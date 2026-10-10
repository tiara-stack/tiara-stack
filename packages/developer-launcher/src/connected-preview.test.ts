import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import path from "node:path";
import { Deferred, Duration, Effect, Fiber, FileSystem, Layer, Path, Scope } from "effect";
import { TestClock } from "effect/testing";
import { parseCommand, parsePositionals, runLauncher, type ProcessExecutor } from "./index";
import { makePreviewGateway, PreviewGatewayError } from "./preview-gateway";
import {
  connectedPreviewOutput,
  makeSheetWebRevisionHandler,
  stopResumedWebSession,
  superviseSheetWebPreview,
} from "./connected-preview";
import {
  makePreviewSessionController,
  previewSessionHeartbeatMs,
  previewSupervisorLeaseMs,
  PreviewSessionError,
  type PreviewSessionControllerApi,
} from "./preview-sessions";
import type { PreviewGatewayApi, PreviewGatewayTarget } from "./preview-gateway";
import {
  makePreviewWebRuntime,
  PreviewWebRuntimeError,
  type PreviewWebRuntimeApi,
} from "./preview-web-runtime";
import {
  makeLocalFilesystemPreviewResourceAdapter,
  makePreviewAllocationController,
  previewCapacityDimensionsByGroup,
  type PreviewAllocationApi,
} from "./preview-allocations";
import type { ConnectedPreviewAction, LauncherOptions } from "./types";
import {
  previewRelayDoctorCheckIds,
  PreviewRelayProviderUnavailable,
  previewRelayHostRoles,
} from "./preview-relay-provider";

const previewRoleContracts = {
  "sheet-web": {
    provided: [],
    consumed: [
      "auth.session",
      "application.zero",
      "workflow.enqueue",
      "bot.capability",
      "search.query",
    ],
  },
  "sheet-auth": { provided: ["auth.session"], consumed: [] },
  "sheet-db-server": { provided: ["application.zero"], consumed: ["auth.session"] },
  "sheet-bot": {
    provided: ["bot.capability"],
    consumed: ["auth.session", "application.zero", "workflow.enqueue"],
  },
  "sheet-workflows-api": {
    provided: ["workflow.enqueue"],
    consumed: [
      "auth.session",
      "application.zero",
      "workflow.execution",
      "workflow.browser",
      "bot.capability",
    ],
  },
  "sheet-workflows-runner": {
    provided: ["workflow.execution"],
    consumed: ["auth.session", "application.zero", "workflow.browser"],
  },
  "sheet-workflows-browser-runner": {
    provided: ["workflow.browser"],
    consumed: ["auth.session", "application.zero", "workflow.execution", "bot.capability"],
  },
} as const;

const previewRoleCredentialNames = {
  "sheet-web": ["preview-admission", "application-integration", "search-query"],
  "sheet-auth": [
    "auth-sql",
    "auth-redis",
    "discord-oauth-client",
    "issuer-signing",
    "session-signing",
    "subject-signing",
    "reviewer",
    "workload-proof",
  ],
  "sheet-db-server": ["application-database", "verifier"],
  "sheet-bot": [
    "discord-bot-token",
    "redis",
    "capability-encryption",
    "internal-oauth-client",
    "bot-delegation-proof",
  ],
  "sheet-workflows-api": ["workflow-database", "internal-oauth-client", "workload-identity"],
  "sheet-workflows-runner": [
    "workflow-database",
    "internal-oauth-client",
    "workload-identity",
    "google-service-account",
  ],
  "sheet-workflows-browser-runner": [
    "workflow-database",
    "internal-oauth-client",
    "workload-identity",
    "bot-capability",
  ],
} as const;

const previewRoleGroups = {
  "sheet-web": ["application-zero", "auth", "workflow-execution", "search"],
  "sheet-auth": ["auth"],
  "sheet-db-server": ["application-zero", "auth"],
  "sheet-bot": ["application-zero", "auth", "workflow-execution", "bot-storage"],
  "sheet-workflows-api": ["application-zero", "auth", "workflow-execution"],
  "sheet-workflows-runner": ["application-zero", "auth", "workflow-execution"],
  "sheet-workflows-browser-runner": ["application-zero", "auth", "workflow-execution"],
} as const;

const allPreviewRoles = Object.keys(previewRoleContracts);
const previewSourceRevision = "a".repeat(40);
const previewArtifactDigest = `sha256:${"b".repeat(64)}`;
const previewManifestDigest = `sha256:${"c".repeat(64)}`;
const previewEnvironmentKeys = ["NODE_ENV", "LOG_LEVEL"] as const;

const liveTest = <E, R extends NodeServices.NodeServices | Scope.Scope | HttpClient.HttpClient>(
  name: string,
  run: () => Effect.Effect<void, E, R>,
) =>
  it.live(name, () =>
    run().pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
  );

const makeUnavailableProfileAllocationController = (now: () => number) =>
  makePreviewAllocationController(
    {
      planProfile: () => Effect.fail(new Error("profile-demand-not-configured")),
      validateProfileAllocation: () => Effect.fail(new Error("profile-allocation-not-configured")),
      allocate: () => Effect.fail(new Error("allocation-not-configured")),
      deleteOwned: () => Effect.fail(new Error("deletion-not-configured")),
      proveCleanup: () => Effect.succeed(false),
    },
    now,
  );

const makeRelayProviderWithAttachmentStatus = (
  attachmentStatus: "ready" | "failed" | "unavailable",
) => {
  const unavailable = PreviewRelayProviderUnavailable();
  return {
    ...unavailable,
    configured: true,
    checkPreparedWorkspace: () =>
      Effect.succeed(
        previewRelayDoctorCheckIds.map((id) => ({
          id,
          status: id === "scoped-relay-attachment" ? attachmentStatus : "ready",
          detail: "test probe result",
        })),
      ),
  };
};

const contractsForPreviewRole = (role: string) => {
  const definition = previewRoleContracts[role as keyof typeof previewRoleContracts];
  return definition === undefined ? [] : [...definition.provided, ...definition.consumed];
};

const previewChangeDeclaration = (
  role: string,
  contract: string | null,
  classification: string,
) => ({
  role,
  contract,
  classification,
  sourceRevision: previewSourceRevision,
  artifactDigest: previewArtifactDigest,
  deployedManifestDigest: previewManifestDigest,
  catalogVersion: 1,
});

interface PreviewFixtureOptions {
  readonly roles?: readonly string[];
  readonly groupOwnership?: Readonly<Record<string, "owned" | "reused">>;
  readonly groupOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly changeOverrides?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly omittedGroups?: readonly string[];
  readonly omittedChanges?: readonly string[];
  readonly credentialOverrides?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly configOverrides?: Readonly<Record<string, unknown>>;
}

const connectedPreviewGroupsFor = (roles: readonly string[], overrides: PreviewFixtureOptions) => {
  const groupIds = [
    ...new Set(
      roles.flatMap((role) => previewRoleGroups[role as keyof typeof previewRoleGroups] ?? []),
    ),
  ].filter((group) => !(overrides.omittedGroups ?? []).includes(group));
  const groups = groupIds.map((id) => {
    const ownership = overrides.groupOwnership?.[id] ?? "owned";
    const group =
      ownership === "owned"
        ? { id, ownership, allocationProfile: `profile-${id}-dev` }
        : {
            id,
            ownership,
            endpoint: `https://${id}.dev.theerapakg.moe`,
            stateIdentity: `${id}-dev-state-v1`,
            deployedManifestDigest: previewManifestDigest,
          };
    return { ...group, ...overrides.groupOverrides?.[id] };
  });
  return groups;
};

const connectedPreviewChangesFor = (roles: readonly string[], overrides: PreviewFixtureOptions) =>
  roles.flatMap((role) =>
    contractsForPreviewRole(role).flatMap((contract) => {
      const key = `${role}:${contract}`;
      if ((overrides.omittedChanges ?? []).includes(key)) return [];
      return [
        {
          ...previewChangeDeclaration(role, contract, "compatible"),
          ...overrides.changeOverrides?.[key],
        },
      ];
    }),
  );

const connectedPreviewCredentialReferencesFor = (
  roles: readonly string[],
  overrides: PreviewFixtureOptions,
) =>
  Object.fromEntries(
    roles.map((role) => [
      role,
      overrides.credentialOverrides?.[role] ?? {
        [previewRoleCredentialNames[role as keyof typeof previewRoleCredentialNames]?.[0] ?? ""]:
          `secret://tiara-stack-dev/${role}/${previewRoleCredentialNames[role as keyof typeof previewRoleCredentialNames]?.[0] ?? ""}`,
      },
    ]),
  );

const createConnectedPreviewConfig = (overrides: PreviewFixtureOptions = {}) => {
  const roles = overrides.roles ?? allPreviewRoles;
  const groups = connectedPreviewGroupsFor(roles, overrides);
  const changes = connectedPreviewChangesFor(roles, overrides);
  const botSelected = roles.includes("sheet-bot");
  const botTarget = "discord:guild:development";
  return {
    schemaVersion: 1,
    environment: "tiara-stack-dev",
    profile: "connected-preview-dev-v1",
    owner: "developer:alice",
    roles,
    hostListeners: roles.flatMap((role, index) =>
      previewRelayHostRoles.some((hostRole) => hostRole === role)
        ? [
            {
              role,
              host: "127.0.0.1" as const,
              port: 4100 + index,
              processId: `test-process-${role}`,
            },
          ]
        : [],
    ),
    identities: {
      sourceRevision: previewSourceRevision,
      artifactDigests: Object.fromEntries(roles.map((role) => [role, previewArtifactDigest])),
      deployedManifestDigest: previewManifestDigest,
      catalogVersion: 1,
    },
    environmentFileInputs: roles.map((role) => ({
      role,
      path: `environment/${role}.env`,
    })),
    groups,
    changes,
    credentialReferences: connectedPreviewCredentialReferencesFor(roles, overrides),
    sharedExecution: "disabled",
    ...(botSelected
      ? {
          botHandoff: {
            targetAllocation: botTarget,
            acknowledgedSharedInterruption: true,
          },
          externalTargets: [botTarget],
        }
      : {}),
    ...overrides.configOverrides,
  };
};

const withConnectedPreviewConfig = <A, E, R>(
  config: unknown,
  use: (configPath: string, cwd: string) => Effect.Effect<A, E, R>,
  environmentFileContents: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "developer-launcher-preview-config-",
    });
    const configPath = pathService.join(cwd, "preview.json");
    yield* fileSystem.writeFileString(configPath, JSON.stringify(config));
    for (const role of allPreviewRoles) {
      const relativePath = `environment/${role}.env`;
      const environmentFilePath = pathService.resolve(cwd, relativePath);
      yield* fileSystem.makeDirectory(pathService.dirname(environmentFilePath), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        environmentFilePath,
        environmentFileContents[relativePath] ?? "",
      );
    }
    return yield* use(configPath, cwd);
  });

const runConnectedPreviewConfig = (
  action: "plan" | "doctor",
  config: unknown,
  options: {
    readonly output?: "json" | "json-stream" | "human";
    readonly executor?: ProcessExecutor;
    readonly environmentFileContents?: Readonly<Record<string, string>>;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
) => {
  const output = options.output ?? "json";
  return withConnectedPreviewConfig(
    config,
    (configPath, cwd) =>
      Effect.tryPromise({
        try: () =>
          runLauncher(
            [
              "preview",
              action,
              "--config",
              configPath,
              ...(output === "json" ? ["--json"] : []),
              ...(output === "json-stream" ? ["--json-stream"] : []),
            ],
            {
              cwd,
              env: options.env ?? {},
              ...(options.executor === undefined ? {} : { executor: options.executor }),
            },
          ),
        catch: (cause) => cause,
      }),
    options.environmentFileContents,
  );
};

const runLauncherEffect = (...args: Parameters<typeof runLauncher>) =>
  Effect.tryPromise({
    try: () => runLauncher(...args),
    catch: (cause) => cause,
  });

const expectPlanBlockedWithDiagnostic = (config: unknown, code: string) =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig("plan", config);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code })]),
    );
  });

liveTest("prints connected preview help without reading configuration or starting resources", () =>
  Effect.gen(function* () {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      executions.push(request);
      return { exitCode: 0 };
    };

    const result = yield* runLauncherEffect(["preview", "--config", "/missing/preview.json"], {
      executor,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output.mode).toBe("preview");
    expect(result.output.readiness).toBe("help");
    expect(result.stdout).toContain("pnpm dev preview plan --config <file>");
    expect(result.stdout).toContain("pnpm dev preview doctor --config <file>");
    expect(result.stdout).toContain("pnpm dev preview start --config <file>");
    expect(result.stdout).toContain("pnpm dev preview status --session <id>");
    expect(executions).toEqual([]);
  }),
);

it("parses connected preview action arguments by action", () => {
  const plan = parseCommand(["preview", "plan", "--config", "preview.json", "--json"]);
  const status = parseCommand(["preview", "status", "--session", "session-123", "--json"]);
  const resolve = parseCommand([
    "preview",
    "resolve",
    "--session",
    "session-123",
    "--resource",
    "database",
  ]);
  const statusWithLeadingOption = parseCommand([
    "preview",
    "--json",
    "status",
    "--session",
    "session-123",
  ]);

  expect(plan).toEqual(
    expect.objectContaining({
      kind: "preview",
      action: "plan",
      options: expect.objectContaining({
        configFile: "preview.json",
        sessionId: null,
        json: true,
      }),
    }),
  );
  expect(status).toEqual(
    expect.objectContaining({
      kind: "preview",
      action: "status",
      options: expect.objectContaining({
        configFile: null,
        sessionId: "session-123",
        json: true,
      }),
    }),
  );
  expect(statusWithLeadingOption).toEqual(
    expect.objectContaining({ kind: "preview", action: "status" }),
  );
  expect(resolve).toEqual(
    expect.objectContaining({
      kind: "preview",
      action: "resolve",
      options: expect.objectContaining({ sessionId: "session-123", resource: "database" }),
    }),
  );
  expect(() =>
    parsePositionals(["preview", "heartbeat"], {
      json: false,
      jsonStream: false,
      help: false,
      envFile: null,
      configFile: null,
      sessionId: "session-123",
      resource: null,
      generation: 0,
      service: null,
      confirm: false,
      confirmDevelopment: false,
      tag: null,
      changedSurfaces: [],
    }),
  ).toThrow(/positive safe integer/);
});

it("accepts only decimal safe integers for preview supervisor generations", () => {
  for (const generation of ["0x10", "1e2", "+1", "1.0", " "]) {
    expect(() =>
      parseCommand([
        "preview",
        "heartbeat",
        "--session",
        "00000000-0000-4000-8000-000000000000",
        "--generation",
        generation,
      ]),
    ).toThrow(/positive safe integer/);
  }
  expect(
    parseCommand([
      "preview",
      "heartbeat",
      "--session",
      "00000000-0000-4000-8000-000000000000",
      "--generation",
      "17",
    ]),
  ).toEqual(expect.objectContaining({ kind: "preview", action: "heartbeat" }));
});

liveTest("plans all seven selected roles and explicit groups without starting resources", () =>
  Effect.gen(function* () {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const executor: ProcessExecutor = async (request) => {
      executions.push(request);
      return { exitCode: 0 };
    };

    const config = createConnectedPreviewConfig({
      configOverrides: {
        seed: "synthetic-development-v1",
        additionalUserGrants: ["developer:bob"],
        triggers: [{ name: "daily-checkin", targets: ["sheets:development-2026"] }],
        externalTargets: ["discord:guild:development", "sheets:development-2026"],
      },
    });
    const results = {
      json: yield* runConnectedPreviewConfig("plan", config, { executor }),
      human: yield* runConnectedPreviewConfig("plan", config, {
        output: "human",
        executor,
      }),
    };
    const result = results.json;
    const output = JSON.parse(result.stdout) as {
      readonly schemaVersion: number;
      readonly mode: string;
      readonly action: string;
      readonly readiness: string;
      readonly plannedProcesses: readonly unknown[];
      readonly connectedPreview: {
        readonly executionAvailable: boolean;
        readonly environmentFileInputs: readonly {
          readonly role: string;
          readonly path: string;
          readonly digest: string | null;
          readonly keys: readonly string[];
          readonly status: string;
        }[];
        readonly selectedRoles: readonly string[];
        readonly requiredRoles: readonly string[];
        readonly missingRoles: readonly string[];
        readonly requiredGroups: readonly { readonly id: string; readonly ownership: string }[];
        readonly roleCatalog: readonly {
          readonly role: string;
          readonly providedContracts: readonly string[];
          readonly consumedContracts: readonly string[];
          readonly externalEffects: readonly string[];
          readonly credentialNames: readonly string[];
          readonly environmentKeys: readonly string[];
        }[];
        readonly compatibility: readonly { readonly classification: string }[];
        readonly quotaRequirements: readonly {
          readonly group: string;
          readonly status: string;
          readonly requested: number | null;
          readonly reserved: number | null;
          readonly available: number | null;
          readonly resourceDimensions: readonly string[];
        }[];
        readonly externalOwnership: readonly {
          readonly target: string;
          readonly ownership: string;
          readonly status: string;
          readonly purposes: readonly string[];
        }[];
        readonly declaredIntent: {
          readonly sharedExecution: string;
          readonly seed: string | null;
          readonly additionalUserGrants: readonly string[];
          readonly triggers: readonly { readonly name: string }[];
          readonly externalTargets: readonly string[];
          readonly botHandoff: { readonly acknowledgedSharedInterruption: boolean } | null;
        };
        readonly prerequisites: readonly { readonly status: string }[];
        readonly effects: Readonly<Record<string, boolean>>;
      };
      readonly credentialReferences: readonly {
        readonly role: string;
        readonly names: readonly string[];
      }[];
    };

    expect(result.exitCode, result.stdout).toBe(0);
    expect(output).toEqual(
      expect.objectContaining({
        schemaVersion: 3,
        mode: "preview",
        action: "plan",
        readiness: "planned",
        plannedProcesses: [],
        connectedPreview: expect.objectContaining({
          executionAvailable: false,
          selectedRoles: allPreviewRoles,
          requiredRoles: allPreviewRoles,
          missingRoles: [],
          requiredGroups: [
            { id: "application-zero", ownership: "owned" },
            { id: "workflow-execution", ownership: "owned" },
            { id: "auth", ownership: "owned" },
            { id: "bot-storage", ownership: "owned" },
            { id: "search", ownership: "owned" },
          ],
          quotaRequirements: expect.arrayContaining([
            expect.objectContaining({
              group: "application-zero",
              status: "unavailable",
              requested: null,
              reserved: null,
              available: null,
            }),
            expect.objectContaining({
              group: "workflow-execution",
              status: "unavailable",
              requested: null,
              reserved: null,
              available: null,
            }),
          ]),
          externalOwnership: expect.arrayContaining([
            expect.objectContaining({
              target: "discord:guild:development",
              ownership: "exclusive",
              status: "unavailable",
              purposes: ["declared target allocation", "exclusive bot handoff"],
            }),
            expect.objectContaining({
              target: "sheets:development-2026",
              ownership: "exclusive",
              status: "unavailable",
              purposes: ["declared target allocation", "trigger daily-checkin"],
            }),
          ]),
        }),
      }),
    );
    expect(output.connectedPreview.compatibility).toHaveLength(27);
    expect(output.connectedPreview.environmentFileInputs).toHaveLength(allPreviewRoles.length);
    expect(
      output.connectedPreview.environmentFileInputs.every(
        ({ status, digest, keys }) =>
          status === "declared" &&
          digest === "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
          keys.length === 0,
      ),
    ).toBe(true);
    expect(
      output.connectedPreview.compatibility.every(
        ({ classification }) => classification === "compatible",
      ),
    ).toBe(true);
    expect(output.connectedPreview.roleCatalog.find(({ role }) => role === "sheet-auth")).toEqual(
      expect.objectContaining({
        providedContracts: ["auth.session"],
        consumedContracts: [],
        credentialNames: previewRoleCredentialNames["sheet-auth"],
        environmentKeys: previewEnvironmentKeys,
      }),
    );
    expect(output.connectedPreview.declaredIntent).toEqual({
      sharedExecution: "disabled",
      seed: "synthetic-development-v1",
      additionalUserGrants: ["developer:bob"],
      triggers: [{ name: "daily-checkin", targets: ["sheets:development-2026"] }],
      externalTargets: ["discord:guild:development", "sheets:development-2026"],
      botHandoff: {
        targetAllocation: "discord:guild:development",
        acknowledgedSharedInterruption: true,
      },
    });
    expect(output.connectedPreview.prerequisites.length).toBeGreaterThan(0);
    expect(
      output.connectedPreview.prerequisites.every(({ status }) => status === "unavailable"),
    ).toBe(true);
    expect(Object.values(output.connectedPreview.effects).every((effect) => effect === false)).toBe(
      true,
    );
    expect(result.stdout).not.toContain("secret://");
    expect(results.human.stdout).toContain(
      "required role closure: sheet-web, sheet-auth, sheet-db-server, sheet-bot, sheet-workflows-api, sheet-workflows-runner, sheet-workflows-browser-runner",
    );
    expect(results.human.stdout).toContain("config schema version: 1");
    expect(results.human.stdout).toContain("sheet-web: environment/sheet-web.env (declared)");
    expect(results.human.stdout).toContain(
      "external effects: shared application writes, workflow enqueue",
    );
    expect(results.human.stdout).toContain(
      "credential references declared:\n    sheet-web: preview-admission",
    );
    expect(results.human.stdout).toContain("workflow-execution: owned");
    expect(results.human.stdout).toContain("quota requirements:");
    expect(results.human.stdout).toContain(
      "requested=unavailable, reserved=unavailable, available=unavailable",
    );
    expect(results.human.stdout).toContain("daily-checkin targets: sheets:development-2026");
    expect(results.human.stdout).toContain("external ownership requirements:");
    expect(results.human.stdout).toContain("telepresence-client-pin: unavailable");
    expect(results.human.stdout).toContain("allocations=false");
    expect(results.human.stdout).not.toContain("secret://");
    expect(executions).toEqual([]);
  }),
);

liveTest("keeps reported roles, contracts, and incompatible callers aligned", () =>
  Effect.gen(function* () {
    const changeOverrides = Object.fromEntries(
      allPreviewRoles.flatMap((role) =>
        contractsForPreviewRole(role).map((contract) => [
          `${role}:${contract}`,
          { classification: "incompatible" },
        ]),
      ),
    );
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({ changeOverrides }),
    );
    const output = JSON.parse(result.stdout) as {
      readonly connectedPreview: {
        readonly roleCatalog: readonly {
          readonly role: string;
          readonly providedContracts: readonly string[];
          readonly consumedContracts: readonly string[];
          readonly credentialNames: readonly string[];
          readonly environmentKeys: readonly string[];
        }[];
        readonly compatibility: readonly {
          readonly contract: string | null;
          readonly classification: string;
          readonly requiredCallers: readonly string[];
        }[];
      };
    };
    const reportedConsumers = new Map<string, string[]>();

    for (const role of output.connectedPreview.roleCatalog) {
      const expected = previewRoleContracts[role.role as keyof typeof previewRoleContracts];
      expect(role.providedContracts).toEqual(expected.provided);
      expect(role.consumedContracts).toEqual(expected.consumed);
      expect(role.credentialNames).toEqual(
        previewRoleCredentialNames[role.role as keyof typeof previewRoleCredentialNames],
      );
      expect(role.environmentKeys).toEqual(previewEnvironmentKeys);
      for (const contract of role.consumedContracts) {
        const consumers = reportedConsumers.get(contract) ?? [];
        consumers.push(role.role);
        reportedConsumers.set(contract, consumers);
      }
    }
    for (const change of output.connectedPreview.compatibility) {
      if (change.classification !== "incompatible" || change.contract === null) continue;
      expect(change.requiredCallers).toEqual(reportedConsumers.get(change.contract) ?? []);
    }
    expect(
      output.connectedPreview.compatibility.find(
        ({ contract }) => contract === "workflow.execution",
      )?.requiredCallers,
    ).toEqual(["sheet-workflows-api", "sheet-workflows-browser-runner"]);
  }),
);

liveTest("accepts an explicit contract-free implementation-only declaration", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        configOverrides: {
          changes: [
            previewChangeDeclaration("sheet-auth", "auth.session", "compatible"),
            previewChangeDeclaration("sheet-auth", null, "implementation-only"),
          ],
        },
      }),
    );
    const output = JSON.parse(result.stdout) as {
      readonly connectedPreview: {
        readonly compatibility: readonly {
          readonly contract: string | null;
          readonly classification: string;
        }[];
      };
    };

    expect(result.exitCode).toBe(0);
    expect(output.connectedPreview.compatibility).toContainEqual({
      role: "sheet-auth",
      contract: null,
      classification: "implementation-only",
      requiredCallers: [],
    });
  }),
);

liveTest("rejects stale identities on implementation-only declarations", () =>
  Effect.gen(function* () {
    const config = createConnectedPreviewConfig({
      roles: ["sheet-auth"],
      configOverrides: {
        changes: [
          previewChangeDeclaration("sheet-auth", "auth.session", "compatible"),
          {
            ...previewChangeDeclaration("sheet-auth", null, "implementation-only"),
            sourceRevision: "d".repeat(40),
          },
        ],
      },
    });

    yield* expectPlanBlockedWithDiagnostic(config, "stale-compatibility");
  }),
);

liveTest("rejects inherited contract names as unknown contracts", () =>
  Effect.gen(function* () {
    const config = createConnectedPreviewConfig({
      roles: ["sheet-auth"],
      groupOwnership: { auth: "reused" },
      configOverrides: {
        changes: [
          previewChangeDeclaration("sheet-auth", "auth.session", "compatible"),
          previewChangeDeclaration("sheet-auth", "toString", "compatible"),
        ],
      },
    });

    yield* expectPlanBlockedWithDiagnostic(config, "missing-compatibility");
  }),
);

liveTest("redacts unapproved credential names from reports and diagnostics", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        credentialOverrides: {
          "sheet-auth": { postgres: "secret://tiara-stack-dev/sheet-auth/postgres" },
        },
      }),
    );
    const output = JSON.parse(result.stdout) as {
      readonly connectedPreview: {
        readonly credentialReferences: readonly {
          readonly role: string;
          readonly names: readonly string[];
          readonly status: string;
        }[];
      };
    };

    expect(result.exitCode).toBe(2);
    expect(output.connectedPreview.credentialReferences).toContainEqual({
      role: "sheet-auth",
      names: ["<invalid>"],
      status: "unavailable",
    });
    expect(result.stdout).not.toContain("secret://tiara-stack-dev/sheet-auth/postgres");
    expect(result.stdout).not.toContain("Credential reference name postgres");
    expect(result.stdout).toContain("Credential reference name <invalid>");
  }),
);

liveTest("shows the declared acknowledgment state for a bot handoff in human output", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-bot"],
        configOverrides: {
          botHandoff: {
            targetAllocation: "discord:guild:development",
            acknowledgedSharedInterruption: false,
          },
        },
      }),
      { output: "human" },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain(
      "bot handoff: acknowledgment required for discord:guild:development",
    );
    expect(result.stdout).not.toContain("bot handoff: acknowledged for");
  }),
);

liveTest("requires owned workflow execution for an acknowledged bot handoff", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-bot", "sheet-workflows-api"],
        groupOwnership: { "workflow-execution": "reused" },
        configOverrides: { sharedExecution: "producer-only" },
      }),
    );
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string; readonly dependency: string | null }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.errors).toContainEqual(
      expect.objectContaining({
        code: "invalid-preview-intent",
        dependency: "workflow-execution",
      }),
    );
  }),
);

liveTest("plans explicit producer-only shared execution as intent without starting it", () =>
  Effect.gen(function* () {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-workflows-api"],
        groupOwnership: {
          "application-zero": "reused",
          auth: "reused",
          "workflow-execution": "reused",
        },
        configOverrides: { sharedExecution: "producer-only" },
      }),
      {
        executor: async (request) => {
          executions.push(request);
          return { exitCode: 0 };
        },
      },
    );
    const output = JSON.parse(result.stdout) as {
      readonly connectedPreview: {
        readonly declaredIntent: { readonly sharedExecution: string };
        readonly requiredGroups: readonly { readonly id: string; readonly ownership: string }[];
      };
    };

    expect(result.exitCode).toBe(0);
    expect(output.connectedPreview.declaredIntent.sharedExecution).toBe("producer-only");
    expect(output.connectedPreview.requiredGroups).toEqual([
      { id: "application-zero", ownership: "reused" },
      { id: "workflow-execution", ownership: "reused" },
      { id: "auth", ownership: "reused" },
    ]);
    expect(executions).toEqual([]);
  }),
);

liveTest("describes web-only producer-only validation remediation", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-web"],
        groupOwnership: {
          "application-zero": "reused",
          auth: "reused",
          "workflow-execution": "owned",
          search: "reused",
        },
        configOverrides: { sharedExecution: "producer-only" },
      }),
    );
    const diagnostic = result.output.errors.find(({ message }) =>
      message.startsWith("Shared execution requires a reused workflow-execution group"),
    );

    expect(diagnostic?.message).toContain("either a sole sheet-web selection");
    expect(diagnostic?.remediation).toContain(
      "either select only sheet-web or select sheet-workflows-api with compatible workflow contracts",
    );
  }),
);

liveTest("requires workflow compatibility for a mixed web and API selection", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-web", "sheet-workflows-api"],
        groupOwnership: {
          "application-zero": "reused",
          auth: "reused",
          "workflow-execution": "reused",
          search: "reused",
        },
        changeOverrides: {
          "sheet-workflows-api:workflow.enqueue": { classification: "unknown" },
        },
        configOverrides: { sharedExecution: "producer-only" },
      }),
    );

    expect(result.exitCode).toBe(2);
    expect(result.output.errors).toContainEqual(
      expect.objectContaining({
        code: "unknown-compatibility",
        dependency: "workflow.enqueue",
      }),
    );
  }),
);

liveTest("keeps planning JSON Lines on lifecycle version 1", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
      { output: "json-stream" },
    );
    const event = JSON.parse(result.stdout) as {
      readonly format: string;
      readonly eventVersion: number;
      readonly sequence: number;
      readonly type: string;
      readonly mode: string;
      readonly connectedPreview: { readonly executionAvailable: boolean };
    };

    expect(event).toEqual(
      expect.objectContaining({
        format: "tiara-stack.development.lifecycle",
        eventVersion: 1,
        sequence: 1,
        type: "planned",
        mode: "preview",
        connectedPreview: expect.objectContaining({ executionAvailable: false }),
      }),
    );
  }),
);

liveTest(
  "reports incompatible contract callers and owned-group closure without selecting them",
  () =>
    Effect.gen(function* () {
      const config = createConnectedPreviewConfig({
        roles: ["sheet-db-server"],
        changeOverrides: {
          "sheet-db-server:application.zero": { classification: "incompatible" },
        },
      });
      const result = yield* runConnectedPreviewConfig("plan", config);
      const human = yield* runConnectedPreviewConfig("plan", config, { output: "human" });
      const output = JSON.parse(result.stdout) as {
        readonly selectedServices: readonly string[];
        readonly errors: readonly { readonly code: string }[];
        readonly connectedPreview: {
          readonly selectedRoles: readonly string[];
          readonly requiredRoles: readonly string[];
          readonly missingRoles: readonly string[];
          readonly requiredGroups: readonly { readonly id: string; readonly ownership: string }[];
          readonly compatibility: readonly {
            readonly contract: string | null;
            readonly requiredCallers: readonly string[];
          }[];
        };
      };

      expect(result.exitCode).toBe(2);
      expect(output.selectedServices).toEqual(["sheet-db-server"]);
      expect(output.connectedPreview.selectedRoles).toEqual(["sheet-db-server"]);
      expect(output.connectedPreview.missingRoles).toEqual([
        "sheet-web",
        "sheet-bot",
        "sheet-workflows-api",
        "sheet-workflows-runner",
        "sheet-workflows-browser-runner",
      ]);
      expect(output.connectedPreview.requiredGroups).toContainEqual({
        id: "application-zero",
        ownership: "owned",
      });
      expect(
        output.connectedPreview.compatibility.find(
          ({ contract }) => contract === "application.zero",
        )?.requiredCallers,
      ).toEqual([
        "sheet-web",
        "sheet-bot",
        "sheet-workflows-api",
        "sheet-workflows-runner",
        "sheet-workflows-browser-runner",
      ]);
      expect(output.errors.some(({ code }) => code === "required-role-missing")).toBe(true);
      expect(human.stdout).toContain("external effects in required role closure:");
    }),
);

liveTest("requires explicit workflow callers for an owned group", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({ roles: ["sheet-web"] }),
    );
    const output = JSON.parse(result.stdout) as {
      readonly connectedPreview: {
        readonly missingRoles: readonly string[];
        readonly requiredGroups: readonly { readonly id: string; readonly ownership: string }[];
      };
      readonly errors: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(2);
    expect(output.connectedPreview.missingRoles).toEqual([
      "sheet-workflows-api",
      "sheet-workflows-runner",
    ]);
    expect(output.connectedPreview.requiredGroups).toContainEqual({
      id: "workflow-execution",
      ownership: "owned",
    });
    expect(output.errors.filter(({ code }) => code === "required-role-missing")).toHaveLength(2);
  }),
);

const invalidPreviewInputs: readonly [string, PreviewFixtureOptions, string][] = [
  ["missing", { omittedChanges: ["sheet-auth:auth.session"] }, "missing-compatibility"],
  [
    "unknown",
    { changeOverrides: { "sheet-auth:auth.session": { classification: "unknown" } } },
    "unknown-compatibility",
  ],
  [
    "stale",
    { changeOverrides: { "sheet-auth:auth.session": { sourceRevision: "d".repeat(40) } } },
    "stale-compatibility",
  ],
  ["group ownership", { omittedGroups: ["auth"] }, "required-group-missing"],
  [
    "unapproved synthetic seed",
    { configOverrides: { seed: "some-other-seed" } },
    "invalid-preview-intent",
  ],
  [
    "credential",
    { credentialOverrides: { "sheet-auth": { runtime: "raw-secret-value" } } },
    "unsafe-preview-credential",
  ],
  [
    "unapproved role credential",
    {
      roles: ["sheet-web"],
      credentialOverrides: {
        "sheet-web": { postgres: "secret://tiara-stack-dev/sheet-web/postgres" },
      },
    },
    "unsafe-preview-credential",
  ],
  [
    "production credential",
    {
      credentialOverrides: {
        "sheet-auth": { runtime: "secret://tiara-stack-prod/sheet-auth/runtime" },
      },
    },
    "unsafe-preview-credential",
  ],
  [
    "credential reference path mismatch",
    {
      credentialOverrides: {
        "sheet-auth": { "auth-sql": "secret://tiara-stack-dev/sheet-auth/other" },
      },
    },
    "unsafe-preview-credential",
  ],
  [
    "incompatible reused group",
    {
      roles: ["sheet-db-server"],
      groupOwnership: { "application-zero": "reused" },
      changeOverrides: { "sheet-db-server:application.zero": { classification: "incompatible" } },
    },
    "invalid-preview-intent",
  ],
  [
    "reused group allocation profile",
    {
      roles: ["sheet-auth"],
      groupOwnership: { auth: "reused" },
      groupOverrides: { auth: { allocationProfile: "auth-dev-profile" } },
    },
    "invalid-preview-intent",
  ],
  [
    "embedded credential",
    { configOverrides: { accessToken: "sensitive-value" } },
    "invalid-preview-config",
  ],
  [
    "production external target",
    { configOverrides: { externalTargets: ["sheets:production-2026"] } },
    "invalid-preview-intent",
  ],
  [
    "implicit shared execution",
    {
      roles: ["sheet-workflows-api"],
      groupOwnership: {
        "application-zero": "reused",
        auth: "reused",
        "workflow-execution": "reused",
      },
    },
    "invalid-preview-intent",
  ],
  [
    "unacknowledged bot handoff",
    {
      roles: ["sheet-bot"],
      configOverrides: {
        botHandoff: {
          targetAllocation: "discord:guild:development",
          acknowledgedSharedInterruption: false,
        },
        externalTargets: [],
      },
    },
    "invalid-preview-intent",
  ],
  [
    "Windows-style environment path",
    {
      configOverrides: {
        environmentFileInputs: [{ role: "sheet-auth", path: "C:/secrets/auth.env" }],
      },
    },
    "invalid-preview-config",
  ],
  [
    "multiple environment files per role",
    {
      configOverrides: {
        environmentFileInputs: [
          { role: "sheet-auth", path: "environment/sheet-auth.env" },
          { role: "sheet-auth", path: "environment/extra.env" },
        ],
      },
    },
    "invalid-preview-config",
  ],
  [
    "missing host listener for a selected runtime",
    { configOverrides: { hostListeners: [] } },
    "invalid-preview-config",
  ],
  [
    "host listener for an unselected role",
    {
      roles: ["sheet-auth"],
      configOverrides: {
        hostListeners: [
          { role: "sheet-auth", host: "127.0.0.1", port: 4102, processId: "auth-process" },
          { role: "sheet-web", host: "127.0.0.1", port: 4101, processId: "web-process" },
        ],
      },
    },
    "invalid-preview-config",
  ],
  [
    "duplicate host listener ports",
    {
      roles: ["sheet-auth", "sheet-bot"],
      configOverrides: {
        hostListeners: [
          { role: "sheet-auth", host: "127.0.0.1", port: 4101, processId: "auth-process" },
          { role: "sheet-bot", host: "127.0.0.1", port: 4101, processId: "bot-process" },
        ],
      },
    },
    "invalid-preview-config",
  ],
];

for (const [name, options, expectedCode] of invalidPreviewInputs) {
  liveTest(`blocks ${name} compatibility or admission inputs`, () =>
    Effect.gen(function* () {
      const result = yield* runConnectedPreviewConfig(
        "plan",
        createConnectedPreviewConfig({ roles: ["sheet-auth"], ...options }),
      );
      const output = JSON.parse(result.stdout) as {
        readonly errors: readonly { readonly code: string }[];
      };

      expect(result.exitCode).toBe(2);
      expect(output.errors.some(({ code }) => code === expectedCode)).toBe(true);
    }),
  );
}

liveTest("validates production, private, and conflicting reused-service endpoints", () =>
  Effect.gen(function* () {
    const production = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        groupOwnership: { auth: "reused" },
        groupOverrides: { auth: { endpoint: "https://auth.production.theerapakg.moe" } },
      }),
    );
    const conflict = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-web"],
        groupOwnership: { "application-zero": "reused", auth: "reused" },
        groupOverrides: { "application-zero": { endpoint: "https://auth.dev.theerapakg.moe" } },
      }),
    );
    const privateService = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        groupOwnership: { auth: "reused" },
        groupOverrides: {
          auth: { endpoint: "postgres://auth.tiara-stack-dev.svc.cluster.local" },
        },
      }),
    );
    const publicDatabaseProtocol = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        groupOwnership: { auth: "reused" },
        groupOverrides: { auth: { endpoint: "postgres://auth.dev.theerapakg.moe" } },
      }),
    );
    const publicWebSocket = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        groupOwnership: { auth: "reused" },
        groupOverrides: { auth: { endpoint: "wss://auth.dev.theerapakg.moe" } },
      }),
    );
    const publicCacheProtocol = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        groupOwnership: { auth: "reused" },
        groupOverrides: { auth: { endpoint: "redis://auth.dev.theerapakg.moe" } },
      }),
    );
    const unapprovedServiceNamespace = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        groupOwnership: { auth: "reused" },
        groupOverrides: { auth: { endpoint: "https://auth.dev.svc.cluster.local" } },
      }),
    );

    expect(privateService.exitCode, privateService.stdout).toBe(0);
    expect(JSON.parse(privateService.stdout).connectedPreview.groupPlans).toContainEqual(
      expect.objectContaining({
        id: "auth",
        endpoint: "postgres://auth.tiara-stack-dev.svc.cluster.local",
      }),
    );
    expect(JSON.parse(production.stdout).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unsafe-preview-endpoint" })]),
    );
    expect(JSON.parse(publicDatabaseProtocol.stdout).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unsafe-preview-endpoint" })]),
    );
    expect(publicWebSocket.exitCode, publicWebSocket.stdout).toBe(0);
    expect(JSON.parse(publicCacheProtocol.stdout).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unsafe-preview-endpoint" })]),
    );
    expect(JSON.parse(conflict.stdout).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "conflicting-preview-endpoint" })]),
    );
    expect(JSON.parse(unapprovedServiceNamespace.stdout).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unsafe-preview-endpoint" })]),
    );
    expect(production.stdout).not.toContain("auth.production.theerapakg.moe");
  }),
);

liveTest("resolves deterministic environment files through a positive role key catalog", () =>
  Effect.gen(function* () {
    const missing = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        configOverrides: {
          environmentFileInputs: [{ role: "sheet-auth", path: "environment/missing.env" }],
        },
      }),
    );
    const allowed = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
      {
        environmentFileContents: {
          "environment/sheet-auth.env": "NODE_ENV=development\nLOG_LEVEL=info\n",
        },
      },
    );
    const credential = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({ roles: ["sheet-web"] }),
      {
        environmentFileContents: {
          "environment/sheet-web.env": "DATABASE_URL=postgres://prod.example.invalid/app\n",
        },
      },
    );

    expect(JSON.parse(missing.stdout).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "env-file-not-found" })]),
    );
    expect(JSON.parse(allowed.stdout).connectedPreview.environmentFileInputs).toContainEqual(
      expect.objectContaining({
        role: "sheet-auth",
        keys: ["LOG_LEVEL", "NODE_ENV"],
        status: "declared",
      }),
    );
    expect(JSON.parse(credential.stdout).errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "unsafe-preview-credential" })]),
    );
    expect(credential.stdout).not.toContain("prod.example.invalid");
  }),
);

liveTest("warns about ambient credentials without exposing their values", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "plan",
      createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
      {
        env: {
          DATABASE_URL: "postgres://prod.example.invalid/application",
          PRODUCTION_DATABASE_URL: "postgres://prod.example.invalid/production",
          SHEET_AUTH_ISSUER_SIGNING_KEY: "unreported-signing-material",
          GCP_SERVICE_ACCOUNT_JSON: "unreported-service-account-material",
        },
      },
    );
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly code: string }[];
      readonly warnings: readonly { readonly code: string }[];
    };

    expect(result.exitCode).toBe(0);
    expect(output.errors).toEqual([]);
    expect(output.warnings.filter(({ code }) => code === "unsafe-preview-credential")).toHaveLength(
      4,
    );
    expect(result.stdout).not.toContain("postgres://prod.example.invalid/application");
    expect(result.stdout).toContain("PRODUCTION_DATABASE_URL");
    expect(result.stdout).not.toContain("unreported-signing-material");
    expect(result.stdout).not.toContain("unreported-service-account-material");
  }),
);

liveTest("reports unimplemented doctor checks as unavailable and performs no process calls", () =>
  Effect.gen(function* () {
    const executions: Parameters<ProcessExecutor>[0][] = [];
    const result = yield* runConnectedPreviewConfig(
      "doctor",
      createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
      {
        executor: async (request) => {
          executions.push(request);
          return { exitCode: 0 };
        },
      },
    );
    const output = JSON.parse(result.stdout) as {
      readonly readiness: string;
      readonly plannedProcesses: readonly unknown[];
      readonly errors: readonly { readonly code: string }[];
      readonly connectedPreview: {
        readonly status: string;
        readonly prerequisites: readonly { readonly status: string }[];
      };
    };

    expect(result.exitCode).toBe(2);
    expect(output.readiness).toBe("blocked");
    expect(output.plannedProcesses).toEqual([]);
    expect(output.connectedPreview.status).toBe("unavailable");
    expect(
      output.connectedPreview.prerequisites.every(({ status }) => status === "unavailable"),
    ).toBe(true);
    expect(output.errors.some(({ code }) => code === "network-unavailable")).toBe(true);
    expect(output.errors.some(({ code }) => code === "dns-unavailable")).toBe(true);
    expect(output.errors.some(({ code }) => code === "tls-unavailable")).toBe(true);
    expect(
      output.errors.some(({ code }) => code === "application-authentication-unavailable"),
    ).toBe(true);
    expect(executions).toEqual([]);
  }),
);

liveTest("deduplicates missing capacity dimensions shared by owned groups", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "doctor",
      createConnectedPreviewConfig({ roles: ["sheet-db-server"] }),
    );
    const output = JSON.parse(result.stdout) as {
      readonly errors: readonly { readonly message: string }[];
    };
    const dimensionDiagnostics = output.errors
      .map(({ message }) => /^Capacity dimension ([^ ]+)/.exec(message)?.[1])
      .filter((dimension): dimension is string => dimension !== undefined);
    expect(dimensionDiagnostics.length).toBeGreaterThan(0);
    expect(new Set(dimensionDiagnostics).size).toBe(dimensionDiagnostics.length);
  }),
);

liveTest(
  "imports an operator baseline and reports missing and exhausted dimensions with values",
  () =>
    Effect.gen(function* () {
      const clock = { value: Date.now() };
      const sessions = yield* makePreviewSessionController(() => clock.value);
      const config = createConnectedPreviewConfig({ roles: ["sheet-auth"] });
      yield* withConnectedPreviewConfig(config, (configPath, cwd) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const adapter = makeLocalFilesystemPreviewResourceAdapter(path.join(cwd, "resources"));
          const allocations = yield* makePreviewAllocationController(
            { ...adapter, validateProfileAllocation: () => Effect.void },
            () => clock.value,
          );
          const baselinePath = path.join(cwd, "capacity-baseline.json");
          const dimensions = previewCapacityDimensionsByGroup.auth;
          const baseline = {
            measurements: dimensions.slice(0, -1).map((dimension, index) => ({
              provider: index === 1 ? "wrong-provider" : "disposable-postgres",
              identity: "tiara-stack-dev-postgres",
              dimension,
              observedAt: clock.value,
              total: index === 0 ? 5 : 10,
              inUse: index === 0 ? 5 : 0,
              grantsVerified: index !== 2,
            })),
            profiles: [
              {
                profile: "connected-preview-dev-v1",
                selectedRoles: ["sheet-auth"],
                ownedGroups: ["auth"],
                demands: dimensions.map((dimension) => ({
                  dimension,
                  amount: 1,
                  provider: "disposable-postgres",
                  identity: "tiara-stack-dev-postgres",
                })),
                resources: ["auth"],
              },
            ],
          };
          yield* fileSystem.writeFileString(baselinePath, JSON.stringify(baseline));
          const options = {
            cwd,
            env: {
              TIARA_PREVIEW_CAPACITY_BASELINE_FILE: baselinePath,
              TIARA_PREVIEW_SESSION_DATABASE: path.join(cwd, "controller.sqlite"),
            },
            previewAllocationController: allocations,
            previewSessionController: sessions,
          };
          const imported = yield* runLauncherEffect(
            ["preview", "baseline", "--config", configPath, "--json"],
            options,
          );
          expect(imported.exitCode).toBe(0);
          expect(imported.output.baseline).toEqual({
            measurements: dimensions.length - 1,
            profiles: 1,
          });
          const doctor = yield* runLauncherEffect(
            ["preview", "doctor", "--config", configPath, "--json"],
            options,
          );
          expect(doctor.exitCode).toBe(2);
          expect(doctor.output.errors).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: "capacity-exhausted",
                message: expect.stringContaining("requested 1, reserved 0, available 0"),
              }),
              expect.objectContaining({
                code: "prerequisite-unavailable",
                message: expect.stringContaining("no measurement was collected"),
              }),
              expect.objectContaining({
                code: "prerequisite-unavailable",
                message: expect.stringContaining(
                  "no observation matches the configured provider identity",
                ),
              }),
              expect.objectContaining({
                code: "prerequisite-unavailable",
                message: expect.stringContaining("required provider grants were not verified"),
              }),
            ]),
          );
          const start = yield* runLauncherEffect(
            ["preview", "start", "--config", configPath, "--json"],
            options,
          );
          expect(start.exitCode).toBe(2);
          expect(start.output.errors[0]?.message).toContain("requested 1, reserved 0, available 0");
          expect(start.output.previewSession).toBeUndefined();
          expect(yield* fileSystem.exists(path.join(cwd, "resources"))).toBe(false);
        }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
);

liveTest("reports unreadable capacity baseline as not imported", () =>
  withConnectedPreviewConfig(
    createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
    (configPath, cwd) =>
      Effect.gen(function* () {
        const adapter = makeLocalFilesystemPreviewResourceAdapter(path.join(cwd, "resources"));
        const allocations = yield* makePreviewAllocationController(adapter);
        const result = yield* runLauncherEffect(
          ["preview", "baseline", "--config", configPath, "--json"],
          {
            cwd,
            env: {
              TIARA_PREVIEW_CAPACITY_BASELINE_FILE: path.join(cwd, "missing-baseline.json"),
            },
            previewAllocationController: allocations,
          },
        );
        expect(result.exitCode).toBe(2);
        expect(result.output.errors[0]?.message).toContain("Capacity baseline was not imported");
        expect(result.output.errors[0]?.message).toContain("operator file could not be read");
        expect(result.output.errors[0]?.message).not.toContain("session controller");
        expect(result.output.errors[0]?.remediation).toContain("no observations were imported");
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ),
);

liveTest("keeps sheet-web allocation unavailable until its host runtime is wired", () =>
  withConnectedPreviewConfig(
    createConnectedPreviewConfig({
      roles: ["sheet-web", "sheet-db-server", "sheet-workflows-api", "sheet-workflows-runner"],
      configOverrides: { seed: "synthetic-development-v1" },
    }),
    (configPath, cwd) =>
      Effect.gen(function* () {
        const now = Date.now();
        const sessions = yield* makePreviewSessionController(() => now);
        const base = makeLocalFilesystemPreviewResourceAdapter(path.join(cwd, "resources"));
        let applicationMetadata: Readonly<Record<string, string | number | boolean>> | undefined;
        const measurements = [
          ...new Set(Object.values(previewCapacityDimensionsByGroup).flat()),
        ].map((dimension) => ({
          dimension,
          amount: 1,
          provider: "local-test",
          identity: "disposable",
        }));
        const allocations = yield* makePreviewAllocationController(
          {
            ...base,
            planProfile: (input) =>
              Effect.succeed({
                demands: [
                  ...new Set(
                    input.ownedGroups.flatMap(
                      (group) =>
                        previewCapacityDimensionsByGroup[
                          group as keyof typeof previewCapacityDimensionsByGroup
                        ] ?? [],
                    ),
                  ),
                ].map((dimension) => ({
                  dimension,
                  amount: 1,
                  provider: "local-test",
                  identity: "disposable",
                })),
                resources: input.ownedGroups,
              }),
            validateProfileAllocation: () => Effect.void,
            allocate: (input) =>
              Effect.gen(function* () {
                if (input.resource === "application-zero") applicationMetadata = input.metadata;
                return yield* base.allocate(input);
              }),
          },
          () => now,
        );
        yield* Effect.forEach(measurements, (measurement) =>
          allocations.observeCapacity({
            ...measurement,
            total: 2,
            inUse: 0,
            grantsVerified: true,
            observedAt: now,
          }),
        );
        const result = yield* runLauncherEffect(
          ["preview", "start", "--config", configPath, "--json"],
          {
            cwd,
            env: { TIARA_PREVIEW_SESSION_DATABASE: path.join(cwd, "controller.sqlite") },
            previewSessionController: sessions,
            previewAllocationController: allocations,
            previewRelayProvider: makeRelayProviderWithAttachmentStatus("ready"),
          },
        );
        expect(result.exitCode).toBe(2);
        expect(result.output.readiness).toBe("blocked");
        expect(result.output.previewSession).toBeUndefined();
        expect(result.output.errors[0]?.message).toContain(
          "sheet-web preview runtime is unavailable",
        );
        expect(applicationMetadata).toBeUndefined();
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ),
);

liveTest("keeps public preview start interruptible while a provider demand planner times out", () =>
  withConnectedPreviewConfig(
    createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
    (configPath, cwd) =>
      Effect.gen(function* () {
        const sessions = yield* makePreviewSessionController(Date.now);
        const localAdapter = makeLocalFilesystemPreviewResourceAdapter(path.join(cwd, "resources"));
        const allocations = yield* makePreviewAllocationController(
          {
            ...localAdapter,
            planProfile: () => Effect.never,
            validateProfileAllocation: () => Effect.void,
          },
          Date.now,
          undefined,
          true,
          5,
        );
        const result = yield* runLauncherEffect(
          ["preview", "start", "--config", configPath, "--json"],
          {
            cwd,
            env: { TIARA_PREVIEW_SESSION_DATABASE: path.join(cwd, "controller.sqlite") },
            previewSessionController: sessions,
            previewAllocationController: allocations,
          },
        );
        expect(result.exitCode).toBe(2);
        expect(result.output.previewSession).toBeUndefined();
        expect(result.output.errors[0]?.remediation).toContain("no session was created");
        expect(result.output.errors[0]?.remediation).toContain("no allocation was attempted");
        expect(result.output.errors[0]?.remediation).toContain("provider-profile-planning-timeout");
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ),
);

const createInterruptedPreviewFixture = (configPath: string, cwd: string) =>
  Effect.gen(function* () {
    const allocationStarted = yield* Deferred.make<void>();
    const sessions = yield* makePreviewSessionController(Date.now);
    const localAdapter = makeLocalFilesystemPreviewResourceAdapter(path.join(cwd, "resources"));
    const allocations = yield* makePreviewAllocationController({
      ...localAdapter,
      planProfile: () =>
        Effect.succeed({
          demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
            dimension,
            amount: 1,
            provider: "local-test",
            identity: "disposable",
          })),
          resources: ["auth"],
        }),
      validateProfileAllocation: () => Effect.void,
      allocate: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(allocationStarted, undefined);
          return yield* Effect.never;
        }),
    });
    const now = Date.now();
    yield* Effect.forEach(previewCapacityDimensionsByGroup.auth, (dimension) =>
      allocations.observeCapacity({
        provider: "local-test",
        identity: "disposable",
        dimension,
        observedAt: now,
        total: 2,
        inUse: 0,
        grantsVerified: true,
      }),
    );
    const options = {
      cwd,
      env: { TIARA_PREVIEW_SESSION_DATABASE: path.join(cwd, "controller.sqlite") },
      previewSessionController: sessions,
      previewAllocationController: allocations,
      previewRelayProvider: makeRelayProviderWithAttachmentStatus("ready"),
    };
    return { allocationStarted, sessions, allocations, options };
  });

const parsePreviewAction = (args: readonly string[], action: ConnectedPreviewAction) => {
  const command = parseCommand(args);
  if (command.kind !== "preview" || command.action !== action)
    throw new Error(`preview ${action} command did not parse`);
  return command;
};

const verifyInterruptedPreviewIsRecoverable = (
  sessionId: string,
  options: LauncherOptions,
  sessions: PreviewSessionControllerApi,
  allocations: PreviewAllocationApi,
) =>
  Effect.gen(function* () {
    expect((yield* sessions.status(sessionId)).phase).toBe("ended");
    const state = yield* allocations.inspect(sessionId);
    expect(state.allocations[0]?.state).toBe("allocating");
    expect(state.reservations[0]?.releasedAt).toBeNull();
    const status = yield* connectedPreviewOutput(
      parsePreviewAction(["preview", "status", "--session", sessionId, "--json"], "status"),
      options,
    );
    expect(status.previewSession?.allocations?.resources[0]?.state).toBe("allocating");
    const cleanup = yield* connectedPreviewOutput(
      parsePreviewAction(["preview", "cleanup", "--session", sessionId, "--json"], "cleanup"),
      options,
    );
    expect(cleanup.previewSession?.allocations?.cleanup).toBe("quarantined");
    expect((yield* allocations.inspect(sessionId)).reservations[0]?.releasedAt).toBeNull();
  });

liveTest("stops and exposes the allocation ledger when public preview start is interrupted", () =>
  withConnectedPreviewConfig(
    createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
    (configPath, cwd) =>
      Effect.gen(function* () {
        const fixture = yield* createInterruptedPreviewFixture(configPath, cwd);
        const start = parsePreviewAction(
          ["preview", "start", "--config", configPath, "--json"],
          "start",
        );
        const startFiber = yield* connectedPreviewOutput(start, fixture.options).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(fixture.allocationStarted);
        yield* Fiber.interrupt(startFiber);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT id FROM preview_sessions`;
        expect(rows).toHaveLength(1);
        yield* verifyInterruptedPreviewIsRecoverable(
          String((rows[0] as Record<string, unknown>).id),
          fixture.options,
          fixture.sessions,
          fixture.allocations,
        );
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ),
);

const blockedPreviewActions: readonly [string, readonly string[]][] = [
  ["start", ["start", "--config", "/missing/preview.json"]],
  ["status", ["status", "--session", "session-123"]],
  ["heartbeat", ["heartbeat", "--session", "session-123", "--generation", "1"]],
  ["resume", ["resume", "--session", "session-123"]],
  ["stop", ["stop", "--session", "session-123"]],
  ["cleanup", ["cleanup", "--session", "session-123"]],
  ["resolve", ["resolve", "--session", "session-123", "--resource", "database"]],
];

liveTest("plans a web-only compatible shared workflow profile without adding API callers", () =>
  runConnectedPreviewConfig(
    "plan",
    createConnectedPreviewConfig({
      roles: ["sheet-web"],
      groupOwnership: {
        "application-zero": "reused",
        auth: "reused",
        "workflow-execution": "reused",
        search: "reused",
      },
      configOverrides: { sharedExecution: "producer-only" },
    }),
  ).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result.output.connectedPreview?.requiredRoles).toEqual(["sheet-web"]);
        expect(
          result.output.errors.some((error) => error.message.includes("Required caller role")),
        ).toBe(false);
      }),
    ),
  ),
);

for (const [action, args] of blockedPreviewActions) {
  liveTest(`keeps connected preview ${action} blocked`, () =>
    Effect.gen(function* () {
      const executions: Parameters<ProcessExecutor>[0][] = [];
      const result = yield* runLauncherEffect(["preview", ...args, "--json"], {
        executor: async (request) => {
          executions.push(request);
          return { exitCode: 0 };
        },
      });
      const output = JSON.parse(result.stdout) as {
        readonly mode: string;
        readonly action: string;
        readonly readiness: string;
        readonly errors: readonly { readonly code: string }[];
      };

      expect(result.exitCode).toBe(2);
      expect(output).toEqual(
        expect.objectContaining({
          mode: "preview",
          action,
          readiness: "blocked",
          errors: [
            expect.objectContaining({
              code: "dependency-unavailable",
            }),
          ],
        }),
      );
      expect(executions).toEqual([]);
    }),
  );
}

it.live(
  "does not create a preview session until scoped relay attachment authorization is ready",
  () =>
    Effect.gen(function* () {
      const now = 50_000;
      const controller = yield* makePreviewSessionController(() => now);
      let createCalls = 0;
      const observedController = {
        ...controller,
        create: (input: Parameters<typeof controller.create>[0]) => {
          createCalls += 1;
          return controller.create(input);
        },
      };
      yield* withConnectedPreviewConfig(
        createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
        (configPath, cwd) =>
          Effect.gen(function* () {
            const localAdapter = makeLocalFilesystemPreviewResourceAdapter(
              path.join(cwd, "resources"),
            );
            const allocationController = yield* makePreviewAllocationController(
              {
                ...localAdapter,
                planProfile: () =>
                  Effect.succeed({
                    demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
                      dimension,
                      amount: 1,
                      provider: "local-test",
                      identity: "disposable",
                    })),
                    resources: ["auth"],
                  }),
                validateProfileAllocation: () => Effect.void,
              },
              () => now,
            );
            yield* Effect.forEach(previewCapacityDimensionsByGroup.auth, (dimension) =>
              allocationController.observeCapacity({
                provider: "local-test",
                identity: "disposable",
                dimension,
                observedAt: now,
                total: 1,
                inUse: 0,
                grantsVerified: true,
              }),
            );
            const result = yield* runLauncherEffect(
              ["preview", "start", "--config", configPath, "--json"],
              {
                cwd,
                env: { TIARA_PREVIEW_SESSION_DATABASE: `${cwd}/controller.sqlite` },
                previewSessionController: observedController,
                previewAllocationController: allocationController,
                previewRelayProvider: makeRelayProviderWithAttachmentStatus("unavailable"),
              },
            );
            const fileSystem = yield* FileSystem.FileSystem;
            expect(result.exitCode).toBe(2);
            expect(result.output.previewSession).toBeUndefined();
            expect(result.output.errors[0]?.remediation).toContain("scoped-relay-attachment");
            expect(result.output.errors[0]?.remediation).toContain(
              "No session or resources were created",
            );
            expect(createCalls).toBe(0);
            expect(yield* fileSystem.exists(path.join(cwd, "resources"))).toBe(false);
          }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
);

liveTest(
  "stops and returns the session ID when allocation status cannot be read after reservation",
  () =>
    withConnectedPreviewConfig(
      createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
      (configPath, cwd) =>
        Effect.gen(function* () {
          const now = 50_000;
          const controller = yield* makePreviewSessionController(() => now);
          const base = makeLocalFilesystemPreviewResourceAdapter(path.join(cwd, "resources"));
          const actualAllocations = yield* makePreviewAllocationController(
            {
              ...base,
              planProfile: () =>
                Effect.succeed({
                  demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
                    dimension,
                    amount: 1,
                    provider: "local-test",
                    identity: "disposable",
                  })),
                  resources: ["auth"],
                }),
              validateProfileAllocation: () => Effect.void,
            },
            () => now,
          );
          yield* Effect.forEach(previewCapacityDimensionsByGroup.auth, (dimension) =>
            actualAllocations.observeCapacity({
              provider: "local-test",
              identity: "disposable",
              dimension,
              observedAt: now,
              total: 2,
              inUse: 0,
              grantsVerified: true,
            }),
          );
          let inspections = 0;
          const allocations: PreviewAllocationApi = {
            ...actualAllocations,
            inspect: (sessionId) => {
              inspections += 1;
              return inspections === 1
                ? Effect.fail(
                    new SqlError.SqlError({
                      reason: new SqlError.UnknownError({
                        cause: new Error("allocation-status-unavailable"),
                        message: "allocation status unavailable",
                        operation: "inspect allocation",
                      }),
                    }),
                  )
                : actualAllocations.inspect(sessionId);
            },
          };
          const result = yield* runLauncherEffect(
            ["preview", "start", "--config", configPath, "--json"],
            {
              cwd,
              env: { TIARA_PREVIEW_SESSION_DATABASE: `${cwd}/controller.sqlite` },
              previewSessionController: controller,
              previewAllocationController: allocations,
              previewRelayProvider: makeRelayProviderWithAttachmentStatus("ready"),
            },
          );

          expect(result.exitCode).toBe(2);
          expect(result.output.readiness).toBe("blocked");
          expect(result.output.previewSession?.id).toMatch(/^[a-f0-9-]{36}$/i);
          expect(result.output.previewSession?.phase).toBe("ended");
          expect(result.output.errors[0]?.code).toBe("prerequisite-unavailable");
          const ended = yield* controller.status(result.output.previewSession!.id);
          expect(ended.phase).toBe("ended");
          expect(inspections).toBeGreaterThanOrEqual(2);
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
);

it.live(
  "routes session commands through durable controller authority without exposing credentials",
  () =>
    Effect.gen(function* () {
      const clock = { value: 50_000 };
      const controller = yield* makePreviewSessionController(() => clock.value);
      yield* withConnectedPreviewConfig(
        createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
        (configPath, cwd) =>
          Effect.gen(function* () {
            const localAdapter = makeLocalFilesystemPreviewResourceAdapter(
              path.join(cwd, "resources"),
            );
            const allocationController = yield* makePreviewAllocationController(
              {
                ...localAdapter,
                planProfile: () =>
                  Effect.succeed({
                    demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
                      dimension,
                      amount: 1,
                      provider: "local-test",
                      identity: "disposable",
                    })),
                    resources: ["auth"],
                  }),
                validateProfileAllocation: () => Effect.void,
                resolveUnknown: ({ sessionId, resource, ownerToken, providerIdentities }) =>
                  Effect.succeed({
                    sessionId,
                    resource,
                    ownerToken,
                    ...providerIdentities[0]!,
                    verifiedAt: clock.value,
                    allocationSettled: true,
                    result: {
                      status: "found" as const,
                      providerResourceId: path.join(
                        cwd,
                        "resources",
                        sessionId,
                        `${resource}.owner`,
                      ),
                    },
                  }),
              },
              () => clock.value,
            );
            yield* Effect.forEach(previewCapacityDimensionsByGroup.auth, (dimension) =>
              allocationController.observeCapacity({
                provider: "local-test",
                identity: "disposable",
                dimension,
                observedAt: clock.value,
                total: 2,
                inUse: 0,
                grantsVerified: true,
              }),
            );
            const sessionDatabase = `${cwd}/controller.sqlite`;
            const gateway = yield* makePreviewGateway({
              domain: "",
              controller,
              now: () => clock.value,
            });
            let routeCleanupCalls = 0;
            const options = {
              cwd,
              env: { TIARA_PREVIEW_SESSION_DATABASE: sessionDatabase },
              previewSessionController: controller,
              previewGateway: {
                ...gateway,
                cleanupSession: (id: string, ownerIdentity: string) => {
                  routeCleanupCalls += 1;
                  return gateway.cleanupSession(id, ownerIdentity);
                },
              },
              previewAllocationController: allocationController,
              previewRelayProvider: makeRelayProviderWithAttachmentStatus("ready"),
            };
            const start = yield* Effect.tryPromise({
              try: () =>
                runLauncher(["preview", "start", "--config", configPath, "--json"], options),
              catch: (cause) => cause,
            });
            expect(start.exitCode, start.stdout).toBe(0);
            const created = JSON.parse(start.stdout) as {
              readonly previewSession: {
                readonly id: string;
                readonly generation: number;
                readonly allocations: {
                  readonly resources: readonly {
                    readonly resource: string;
                    readonly providerResourceId: string | null;
                  }[];
                };
              };
              readonly plannedProcesses: readonly unknown[];
              readonly readiness: string;
            };
            const id = created.previewSession.id;
            expect(created.previewSession.generation).toBe(1);
            expect(created.readiness).toBe("planned");
            expect(created.plannedProcesses).toEqual([]);
            expect(
              created.previewSession.allocations.resources.map(({ resource }) => resource),
            ).toEqual([
              "auth",
              "preview-relay-attachment-sheet-auth",
              "preview-relay-service-sheet-auth",
            ]);
            const resourcePath =
              created.previewSession.allocations.resources[0]?.providerResourceId;
            expect(resourcePath).not.toBeNull();
            const fileSystem = yield* FileSystem.FileSystem;
            expect((yield* fileSystem.readFileString(resourcePath!)).includes(id)).toBe(true);
            const secondSession = yield* controller.create({
              owner: "developer:bob",
              checkout: `${cwd}/second-worktree`,
              manifests: {},
              requestedRevision: "second-revision",
            });
            const secondResources = yield* allocationController.reserveAndAllocate({
              sessionId: secondSession.session.id,
              demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
                dimension,
                amount: 1,
                provider: "local-test",
                identity: "disposable",
              })),
              resources: [
                "auth",
                "preview-relay-attachment-sheet-auth",
                "preview-relay-service-sheet-auth",
              ],
            });
            const otherResourcePath = secondResources.auth!;
            const otherRelayPath = secondResources["preview-relay-attachment-sheet-auth"]!;
            const otherRelayServicePath = secondResources["preview-relay-service-sheet-auth"]!;
            const identityStore = yield* FileSystem.FileSystem;
            const storedIdentity = yield* identityStore.readFileString(
              `${sessionDatabase}.credentials/${id}`,
            );
            const credentials = JSON.parse(storedIdentity) as {
              readonly ownerIdentity: string;
              readonly supervisorIdentity: string;
            };
            expect(start.stdout).not.toContain(credentials.ownerIdentity);
            expect(start.stdout).not.toContain(credentials.supervisorIdentity);

            const { previewAllocationController: _allocationAuthority, ...sessionOnlyOptions } =
              options;
            expect(_allocationAuthority).toBeDefined();

            const status = yield* Effect.tryPromise({
              try: () =>
                runLauncher(["preview", "status", "--session", id, "--json"], sessionOnlyOptions),
              catch: (cause) => cause,
            });
            const beforeHeartbeat = JSON.parse(status.stdout) as {
              readonly previewSession: {
                readonly lastRenewedAt: number;
                readonly allocations?: { readonly resources: readonly unknown[] };
              };
              readonly readiness: string;
              readonly errors: readonly { readonly message: string }[];
            };
            expect(status.exitCode).toBe(2);
            expect(beforeHeartbeat.readiness).toBe("blocked");
            expect(beforeHeartbeat.previewSession.allocations).toBeUndefined();
            expect(beforeHeartbeat.errors[0]?.message).toContain(
              "allocation ledger is unavailable",
            );
            const unavailableResolution = yield* Effect.tryPromise({
              try: () =>
                runLauncher(
                  ["preview", "resolve", "--session", id, "--resource", "auth", "--json"],
                  sessionOnlyOptions,
                ),
              catch: (cause) => cause,
            });
            expect(unavailableResolution.exitCode).toBe(2);
            expect(unavailableResolution.output.errors[0]?.message).toContain(
              "Cleanup requires the durable preview session and allocation authorities",
            );
            expect(unavailableResolution.output.errors[0]?.remediation).toContain(
              "TIARA_PREVIEW_SESSION_DATABASE",
            );

            const fullStatus = yield* Effect.tryPromise({
              try: () => runLauncher(["preview", "status", "--session", id, "--json"], options),
              catch: (cause) => cause,
            });
            const fullStatusOutput = JSON.parse(fullStatus.stdout) as {
              readonly previewSession: {
                readonly lastRenewedAt: number;
                readonly allocations: { readonly resources: readonly unknown[] };
              };
            };
            expect(beforeHeartbeat.previewSession.lastRenewedAt).toBe(clock.value);
            expect(fullStatusOutput.previewSession.allocations.resources).toHaveLength(3);
            const liveCleanup = yield* Effect.tryPromise({
              try: () => runLauncher(["preview", "cleanup", "--session", id, "--json"], options),
              catch: (cause) => cause,
            });
            expect(liveCleanup.exitCode).toBe(2);
            expect(routeCleanupCalls).toBe(0);
            expect((yield* fileSystem.readFileString(resourcePath!)).includes(id)).toBe(true);

            const heartbeat = yield* Effect.tryPromise({
              try: () =>
                runLauncher(
                  ["preview", "heartbeat", "--session", id, "--generation", "1", "--json"],
                  sessionOnlyOptions,
                ),
              catch: (cause) => cause,
            });
            expect(heartbeat.exitCode).toBe(0);
            const concurrentResume = yield* Effect.tryPromise({
              try: () =>
                runLauncher(["preview", "resume", "--session", id, "--json"], sessionOnlyOptions),
              catch: (cause) => cause,
            });
            expect(concurrentResume.exitCode).toBe(2);

            clock.value += 30_000;
            const resumed = yield* Effect.tryPromise({
              try: () =>
                runLauncher(["preview", "resume", "--session", id, "--json"], sessionOnlyOptions),
              catch: (cause) => cause,
            });
            expect(resumed.exitCode).toBe(0);
            const staleHeartbeat = yield* Effect.tryPromise({
              try: () =>
                runLauncher(
                  ["preview", "heartbeat", "--session", id, "--generation", "1", "--json"],
                  sessionOnlyOptions,
                ),
              catch: (cause) => cause,
            });
            expect(staleHeartbeat.exitCode).toBe(2);

            const stopped = yield* Effect.tryPromise({
              try: () =>
                runLauncher(["preview", "stop", "--session", id, "--json"], sessionOnlyOptions),
              catch: (cause) => cause,
            });
            const stoppedAgain = yield* Effect.tryPromise({
              try: () =>
                runLauncher(["preview", "stop", "--session", id, "--json"], sessionOnlyOptions),
              catch: (cause) => cause,
            });
            expect(stopped.exitCode).toBe(0);
            expect(stoppedAgain.exitCode).toBe(0);
            const ended = yield* controller.status(id);
            expect(ended.phase).toBe("ended");
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE preview_allocation_ledger SET provider_resource_id=NULL, state='quarantined', failure='provider-resource-id-missing' WHERE session_id=${id} AND resource='auth'`;
            const waitingCleanup = yield* Effect.tryPromise({
              try: () => runLauncher(["preview", "cleanup", "--session", id, "--json"], options),
              catch: (cause) => cause,
            });
            expect(waitingCleanup.exitCode).toBe(2);
            const waitingCleanupOutput = JSON.parse(waitingCleanup.stdout) as {
              previewSession: { allocations: { cleanup: string } };
              errors: readonly { readonly message: string; readonly remediation: string }[];
            };
            expect(waitingCleanupOutput.previewSession.allocations.cleanup).toBe("quarantined");
            expect(waitingCleanupOutput.errors[0]?.remediation).toContain(
              "preview resolve --session",
            );
            expect(yield* fileSystem.exists(resourcePath!)).toBe(true);
            const resolved = yield* Effect.tryPromise({
              try: () =>
                runLauncher(
                  ["preview", "resolve", "--session", id, "--resource", "auth", "--json"],
                  options,
                ),
              catch: (cause) => cause,
            });
            expect(resolved.exitCode).toBe(0);
            const resolvedOutput = JSON.parse(resolved.stdout) as {
              readonly ok: boolean;
              readonly readiness: string;
              readonly previewSession: { readonly allocations: { readonly cleanup: string } };
              readonly errors: readonly unknown[];
              readonly warnings: readonly { readonly message: string }[];
            };
            expect(resolvedOutput.ok).toBe(true);
            expect(resolvedOutput.readiness).toBe("completed");
            expect(resolvedOutput.previewSession.allocations.cleanup).toBe("waiting");
            expect(resolvedOutput.errors).toEqual([]);
            expect(resolvedOutput.warnings[0]?.message).toContain("Cleanup is waiting");
            const resolution =
              yield* sql`SELECT provider_resource_id, outcome FROM preview_allocation_resolutions WHERE session_id=${id} AND resource='auth'`;
            expect(resolution).toHaveLength(1);
            expect((resolution[0] as Record<string, unknown>).provider_resource_id).toBe(
              resourcePath,
            );
            expect((resolution[0] as Record<string, unknown>).outcome).toBe("found");
            clock.value += 5 * 60_000;
            const cleaned = yield* Effect.tryPromise({
              try: () => runLauncher(["preview", "cleanup", "--session", id, "--json"], options),
              catch: (cause) => cause,
            });
            expect(cleaned.exitCode, cleaned.stdout).toBe(0);
            expect(routeCleanupCalls).toBeGreaterThan(0);
            expect((yield* fileSystem.readDirectory(path.dirname(resourcePath!))).length).toBe(0);
            expect(
              (yield* fileSystem.readFileString(otherResourcePath)).includes(
                secondSession.session.id,
              ),
            ).toBe(true);
            expect(
              (yield* fileSystem.readFileString(otherRelayPath)).includes(secondSession.session.id),
            ).toBe(true);
            expect(
              (yield* fileSystem.readFileString(otherRelayServicePath)).includes(
                secondSession.session.id,
              ),
            ).toBe(true);
            const cleanupAgain = yield* Effect.tryPromise({
              try: () => runLauncher(["preview", "cleanup", "--session", id, "--json"], options),
              catch: (cause) => cause,
            });
            expect(cleanupAgain.exitCode).toBe(0);
            yield* controller.stop(secondSession.session.id, secondSession.ownerIdentity);
            yield* allocationController.cleanup({ sessionId: secondSession.session.id });
            clock.value += 5 * 60_000;
            expect(
              yield* allocationController.cleanup({ sessionId: secondSession.session.id }),
            ).toBe("cleaned");
          }),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
      ),
    ),
);

it.live("does not create a pending session when a declared environment file is unavailable", () =>
  Effect.gen(function* () {
    const clock = { value: 50_000 };
    const controller = yield* makePreviewSessionController(() => clock.value);
    let createCalls = 0;
    const observedController = {
      ...controller,
      create: (input: Parameters<typeof controller.create>[0]) => {
        createCalls += 1;
        return controller.create(input);
      },
    };
    yield* withConnectedPreviewConfig(
      createConnectedPreviewConfig({
        roles: ["sheet-auth"],
        configOverrides: {
          environmentFileInputs: [{ role: "sheet-auth", path: "environment/missing.env" }],
        },
      }),
      (configPath, cwd) =>
        runLauncherEffect(["preview", "start", "--config", configPath, "--json"], {
          cwd,
          env: { TIARA_PREVIEW_SESSION_DATABASE: `${cwd}/controller.sqlite` },
          previewSessionController: observedController,
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result.exitCode).toBe(2);
              expect(JSON.parse(result.stdout).errors).toEqual(
                expect.arrayContaining([expect.objectContaining({ code: "env-file-not-found" })]),
              );
              expect(createCalls).toBe(0);
            }),
          ),
        ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  ),
);

it.live("does not create a pending session without a credential store path", () =>
  Effect.gen(function* () {
    const controller = yield* makePreviewSessionController(() => 50_000);
    let createCalls = 0;
    const observedController = {
      ...controller,
      create: (input: Parameters<typeof controller.create>[0]) => {
        createCalls += 1;
        return controller.create(input);
      },
    };
    yield* withConnectedPreviewConfig(
      createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
      (configPath, cwd) =>
        runLauncherEffect(["preview", "start", "--config", configPath, "--json"], {
          cwd,
          env: {},
          previewSessionController: observedController,
        }).pipe(
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result.exitCode).toBe(2);
              expect(JSON.parse(result.stdout).errors).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ code: "dependency-unavailable" }),
                ]),
              );
              expect(createCalls).toBe(0);
            }),
          ),
        ),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  ),
);

it.live("reports malformed session IDs separately from missing database configuration", () =>
  Effect.gen(function* () {
    const controller = yield* makePreviewSessionController(() => 50_000);
    const allocations = yield* makeUnavailableProfileAllocationController(() => 50_000);
    const result = yield* runLauncherEffect(
      ["preview", "heartbeat", "--session", "not-a-session-id", "--generation", "1", "--json"],
      {
        env: { TIARA_PREVIEW_SESSION_DATABASE: "/tmp/unused-preview-sessions.sqlite" },
        previewSessionController: controller,
        previewAllocationController: allocations,
      },
    );
    expect(result.exitCode).toBe(2);
    expect(JSON.stringify(result.output.errors)).toContain(
      "The --session value must be the session ID returned by preview start.",
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  ),
);

it.live("stops a newly created session when owner credentials cannot be persisted", () =>
  Effect.gen(function* () {
    const controller = yield* makePreviewSessionController(() => 50_000);
    const allocations = yield* makePreviewAllocationController(
      {
        planProfile: () =>
          Effect.succeed({
            demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
              dimension,
              amount: 1,
              provider: "test",
              identity: "provider",
            })),
            resources: ["auth"],
          }),
        validateProfileAllocation: () => Effect.void,
        allocate: () => Effect.fail(new Error("must not allocate before credentials")),
        deleteOwned: () => Effect.void,
        proveCleanup: () => Effect.succeed(false),
      },
      () => 50_000,
    );
    yield* Effect.forEach(previewCapacityDimensionsByGroup.auth, (dimension) =>
      allocations.observeCapacity({
        provider: "test",
        identity: "provider",
        dimension,
        observedAt: 50_000,
        total: 2,
        inUse: 0,
        grantsVerified: true,
      }),
    );
    yield* withConnectedPreviewConfig(
      createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
      (configPath, cwd) =>
        Effect.gen(function* () {
          const sessionDatabase = `${cwd}/controller.sqlite`;
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.writeFileString(`${sessionDatabase}.credentials`, "not-a-directory");
          const result = yield* runLauncherEffect(
            ["preview", "start", "--config", configPath, "--json"],
            {
              cwd,
              env: { TIARA_PREVIEW_SESSION_DATABASE: sessionDatabase },
              previewSessionController: controller,
              previewAllocationController: allocations,
              previewRelayProvider: makeRelayProviderWithAttachmentStatus("ready"),
            },
          );
          const output = JSON.parse(result.stdout) as {
            readonly previewSession: { readonly id: string; readonly phase: string };
          };
          expect(result.exitCode).toBe(2);
          expect(output.previewSession.phase).toBe("ended");
          expect((yield* controller.status(output.previewSession.id)).phase).toBe("ended");
        }),
    );
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  ),
);

it.effect("renews the durable lease after compatible sheet-web resume", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    yield* TestClock.adjust(Duration.millis(previewSupervisorLeaseMs));
    const resumed = yield* controller.resume(
      created.session.id,
      created.ownerIdentity,
      created.supervisorIdentity,
    );
    const active = yield* controller.activate(
      created.session.id,
      resumed.session.generation,
      resumed.supervisorIdentity,
      resumed.session.requestedRevision,
    );
    const gateway = yield* makePreviewGateway({ domain: "", controller, now });
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.void,
    } satisfies PreviewWebRuntimeApi;
    const fiber = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: resumed.supervisorIdentity,
      generation: active.generation,
      controller,
      gateway,
      runtime,
    }).pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    const renewed = yield* controller.status(created.session.id);
    expect(renewed.lastRenewedAt).toBe(now());
    expect(renewed.phase).toBe("active");
    yield* Fiber.interrupt(fiber);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
        FetchHttpClient.layer,
      ),
    ),
  ),
);

it.effect("keeps an active sheet-web session alive for an already-active revision", () =>
  Effect.gen(function* () {
    const now = () => 50_000;
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    const gateway = yield* makePreviewGateway({ domain: "", controller, now });
    const onRevision = makeSheetWebRevisionHandler(
      {
        sessionId: created.session.id,
        generation: created.session.generation,
        role: "sheet-web",
        processId: "web-process",
        revision: "revision-a",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        catalogDigest: `sha256:${"b".repeat(64)}`,
        stateGroup: "web-state",
        serviceFqdn: "web.preview-relays.svc.cluster.local",
        serviceResourceId: "web-service",
        attachmentResourceId: "web-attachment",
        port: 4100,
        kind: "application",
      },
      [],
      created,
      {
        supervisorIdentity: created.supervisorIdentity,
        generation: created.session.generation,
      },
      controller,
      gateway,
    );

    yield* onRevision("revision-a");

    const session = yield* controller.status(created.session.id);
    expect(session.phase).toBe("active");
    expect(session.activeRevision).toBe("revision-a");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(SqliteClient.layer({ filename: ":memory:" }), NodeServices.layer),
    ),
  ),
);

it.effect("applies a source revision received while sheet-web startup is pending", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    const registeredRoutes: string[] = [];
    const baseGateway = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = {
      ...baseGateway,
      register: (target) =>
        Effect.sync(() => {
          registeredRoutes.push(target.revision);
          return { hostname: "p-session-startup-revision", target };
        }),
      registerApplicationDependencies: (target) =>
        Effect.sync(() => {
          registeredRoutes.push(target.revision);
        }),
      cleanupSession: () => Effect.void,
    };
    const authority = {
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
    };
    const onRevision = makeSheetWebRevisionHandler(
      {
        sessionId: created.session.id,
        generation: created.session.generation,
        role: "sheet-web",
        processId: "web-process",
        revision: "revision-a",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        catalogDigest: `sha256:${"b".repeat(64)}`,
        stateGroup: "web-state",
        serviceFqdn: "web.preview-relays.svc.cluster.local",
        serviceResourceId: "web-service",
        attachmentResourceId: "web-attachment",
        port: 4100,
        kind: "application",
      },
      [],
      created,
      authority,
      controller,
      gateway,
    );

    const revisionFiber = yield* Effect.forkChild(onRevision("revision-b"));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.seconds(31));
    yield* Effect.yieldNow;
    expect((yield* controller.status(created.session.id)).phase).toBe("pending");
    expect(registeredRoutes).toEqual([]);

    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    yield* TestClock.adjust(Duration.seconds(1));
    yield* Fiber.join(revisionFiber);

    const active = yield* controller.status(created.session.id);
    expect(active.phase).toBe("active");
    expect(active.activeRevision).toBe("revision-b");
    expect(registeredRoutes).toEqual(["revision-b", "revision-b"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
      ),
    ),
  ),
);

it.effect("rejects an unrecorded revision when startup remains pending past its wait", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    const registeredRoutes: string[] = [];
    let cleanupCalls = 0;
    const baseGateway = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = {
      ...baseGateway,
      register: (target) =>
        Effect.sync(() => {
          registeredRoutes.push(target.revision);
          return { hostname: "p-session-startup-timeout", target };
        }),
      registerApplicationDependencies: (target) =>
        Effect.sync(() => {
          registeredRoutes.push(target.revision);
        }),
      cleanupSession: () => Effect.sync(() => void cleanupCalls++),
    };
    const onRevision = makeSheetWebRevisionHandler(
      {
        sessionId: created.session.id,
        generation: created.session.generation,
        role: "sheet-web",
        processId: "web-process",
        revision: "revision-a",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        catalogDigest: `sha256:${"b".repeat(64)}`,
        stateGroup: "web-state",
        serviceFqdn: "web.preview-relays.svc.cluster.local",
        serviceResourceId: "web-service",
        attachmentResourceId: "web-attachment",
        port: 4100,
        kind: "application",
      },
      [],
      created,
      {
        supervisorIdentity: created.supervisorIdentity,
        generation: created.session.generation,
      },
      controller,
      gateway,
    );

    const revisionFiber = yield* Effect.forkChild(onRevision("revision-b"));
    yield* Effect.yieldNow;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      yield* TestClock.adjust(Duration.millis(100));
      yield* Effect.yieldNow;
    }

    const revisionResult = yield* Effect.exit(Fiber.join(revisionFiber));
    expect(revisionResult._tag).toBe("Failure");
    expect(registeredRoutes).toEqual([]);
    expect(cleanupCalls).toBe(0);
    const stillPending = yield* controller.status(created.session.id);
    expect(stillPending.phase).toBe("pending");
    expect(stillPending.requestedRevision).toBe("revision-a");
    expect(stillPending.activeRevision).toBe(null);

    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    const active = yield* controller.status(created.session.id);
    expect(active.phase).toBe("active");
    expect(active.requestedRevision).toBe("revision-a");
    expect(active.activeRevision).toBe("revision-a");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
      ),
    ),
  ),
);

it.effect("keeps a retired supervisor controller scope open until its process is missing", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    const gateway = yield* makePreviewGateway({ domain: "", controller, now });
    let oldControllerScopeOpen = true;
    const scopedController: PreviewSessionControllerApi = {
      ...controller,
      requestRevision: (id, generation, supervisorIdentity, revision) =>
        oldControllerScopeOpen
          ? controller.requestRevision(id, generation, supervisorIdentity, revision)
          : Effect.fail(new PreviewSessionError({ reason: "controller-scope-closed" })),
    };
    const firstRetiredCheck = yield* Deferred.make<void>();
    let availabilityChecks = 0;
    let cleanupCalls = 0;
    const baseRuntime = makePreviewWebRuntime({ now });
    const runtime: PreviewWebRuntimeApi = {
      ...baseRuntime,
      availability: () =>
        Effect.gen(function* () {
          availabilityChecks += 1;
          if (availabilityChecks === 1) yield* Deferred.succeed(firstRetiredCheck, undefined);
          return availabilityChecks === 1 ? ("ready" as const) : ("missing" as const);
        }),
      stop: () => Effect.sync(() => void cleanupCalls++),
    };
    const authority = {
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      retired: true,
    };
    const supervisor = superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: authority.supervisorIdentity,
      generation: authority.generation,
      authority,
      controller: scopedController,
      gateway,
      runtime,
    }).pipe(Effect.ensuring(Effect.sync(() => void (oldControllerScopeOpen = false))));
    const fiber = yield* Effect.forkChild(supervisor);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Deferred.await(firstRetiredCheck);

    const onRevision = makeSheetWebRevisionHandler(
      {
        sessionId: created.session.id,
        generation: authority.generation,
        role: "sheet-web",
        processId: "web-process",
        revision: "revision-a",
        artifactDigest: `sha256:${"a".repeat(64)}`,
        catalogDigest: `sha256:${"b".repeat(64)}`,
        stateGroup: "application-zero",
        serviceFqdn: "web.preview-relays.svc.cluster.local",
        serviceResourceId: "web-service",
        attachmentResourceId: "web-attachment",
        port: 4100,
        kind: "application",
      },
      [],
      created,
      authority,
      scopedController,
      gateway,
    );
    yield* onRevision("revision-a");
    expect(oldControllerScopeOpen).toBe(true);
    expect((yield* controller.status(created.session.id)).phase).toBe("active");

    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Fiber.join(fiber);
    expect(availabilityChecks).toBe(2);
    expect(oldControllerScopeOpen).toBe(false);
    expect(cleanupCalls).toBe(0);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
        FetchHttpClient.layer,
      ),
    ),
  ),
);

it.effect("cleans only the resumed web generation that still owns the supervisor fence", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    let processStops = 0;
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.sync(() => void processStops++),
    } satisfies PreviewWebRuntimeApi;
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    yield* TestClock.adjust(Duration.millis(previewSupervisorLeaseMs));
    const resumed = yield* controller.resume(
      created.session.id,
      created.ownerIdentity,
      created.supervisorIdentity,
    );
    const cleaned = yield* stopResumedWebSession(
      created.session.id,
      resumed.supervisorIdentity,
      resumed.session.generation,
      { ownerIdentity: created.ownerIdentity, supervisorIdentity: resumed.supervisorIdentity },
      controller,
      undefined,
      runtime,
    );
    expect(cleaned).toBe(true);
    expect(processStops).toBe(1);
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");

    const second = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      second.session.id,
      second.session.generation,
      second.supervisorIdentity,
      "revision-a",
    );
    yield* TestClock.adjust(Duration.millis(previewSupervisorLeaseMs));
    const firstResume = yield* controller.resume(
      second.session.id,
      second.ownerIdentity,
      second.supervisorIdentity,
    );
    yield* TestClock.adjust(Duration.millis(previewSupervisorLeaseMs));
    const latestResume = yield* controller.resume(
      second.session.id,
      second.ownerIdentity,
      firstResume.supervisorIdentity,
    );
    const staleCleanup = yield* stopResumedWebSession(
      second.session.id,
      firstResume.supervisorIdentity,
      firstResume.session.generation,
      { ownerIdentity: second.ownerIdentity, supervisorIdentity: firstResume.supervisorIdentity },
      controller,
      undefined,
      runtime,
    );
    expect(staleCleanup).toBe(false);
    expect(processStops).toBe(1);
    expect((yield* controller.status(second.session.id)).phase).toBe("pending");
    const latestCleanup = yield* controller.stopSupervised(
      second.session.id,
      latestResume.supervisorIdentity,
      latestResume.session.generation,
    );
    expect(latestCleanup.phase).toBe("ended");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
        FetchHttpClient.layer,
      ),
    ),
  ),
);

it.effect("stops a resumed web session after registered dependency checks fail three times", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    yield* TestClock.adjust(Duration.millis(previewSupervisorLeaseMs));
    const resumed = yield* controller.resume(
      created.session.id,
      created.ownerIdentity,
      created.supervisorIdentity,
    );
    const active = yield* controller.activate(
      created.session.id,
      resumed.session.generation,
      resumed.supervisorIdentity,
      resumed.session.requestedRevision,
    );
    const actualGateway = yield* makePreviewGateway({ domain: "", controller, now });
    let dependencyChecks = 0;
    const gateway: PreviewGatewayApi = {
      ...actualGateway,
      checkRegisteredApplicationDependencies: () =>
        Effect.sync(() => {
          dependencyChecks += 1;
        }).pipe(Effect.andThen(Effect.fail(new PreviewGatewayError({ reason: "unavailable" })))),
    };
    let stopCalls = 0;
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () =>
        Effect.succeed({
          sessionId: created.session.id,
          revision: "revision-a",
          port: 4317,
          pid: 123,
          startedAt: 0,
          readyAt: 0,
          startupDurationMs: 0,
          lastEditDurationMs: null,
          editCount: 0,
          processTree: {
            available: false,
            sampleCount: 0,
            processIds: [],
            cpuTimeMs: 0,
            memoryRssBytes: 0,
            memoryHighWaterBytes: 0,
            sampledAt: 0,
          },
        }),
      stop: () => Effect.sync(() => void stopCalls++),
    } satisfies PreviewWebRuntimeApi;
    const fiber = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: resumed.supervisorIdentity,
      generation: active.generation,
      controller,
      gateway,
      runtime,
      checkDependencies: () =>
        gateway
          .checkRegisteredApplicationDependencies(
            created.session.id,
            "sheet-web",
            created.ownerIdentity,
          )
          .pipe(Effect.as(undefined)),
    }).pipe(Effect.forkChild);

    for (let check = 1; check <= 2; check += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
      expect((yield* controller.status(created.session.id)).phase).toBe("active");
      expect(stopCalls).toBe(0);
      expect(dependencyChecks).toBe(check);
    }
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    expect(dependencyChecks).toBe(3);
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    expect(stopCalls).toBe(1);
    yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
        FetchHttpClient.layer,
      ),
    ),
  ),
);

it.effect("tolerates transient web readiness probes but ends after three failures", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    const gateway = yield* makePreviewGateway({ domain: "", controller, now });
    let statusCalls = 0;
    let stopCalls = 0;
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.sync(() => ++statusCalls > 3),
      measurements: () =>
        Effect.succeed({
          sessionId: created.session.id,
          revision: "revision-a",
          port: 4317,
          pid: 123,
          startedAt: 0,
          readyAt: 0,
          startupDurationMs: 0,
          lastEditDurationMs: null,
          editCount: 0,
          processTree: {
            available: false,
            sampleCount: 0,
            processIds: [],
            cpuTimeMs: 0,
            memoryRssBytes: 0,
            memoryHighWaterBytes: 0,
            sampledAt: 0,
          },
        }),
      stop: () => Effect.sync(() => void stopCalls++),
    } satisfies PreviewWebRuntimeApi;
    const fiber = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      controller,
      gateway,
      runtime,
    }).pipe(Effect.forkChild);

    for (let failure = 1; failure <= 2; failure += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
      expect((yield* controller.status(created.session.id)).phase).toBe("active");
      expect(stopCalls).toBe(0);
      expect(statusCalls).toBe(failure);
    }
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    expect(statusCalls).toBe(3);
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    expect(stopCalls).toBe(1);
    yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
        FetchHttpClient.layer,
      ),
    ),
  ),
);

it.effect(
  "retries transient supervisor heartbeats and stops after three consecutive failures",
  () =>
    Effect.gen(function* () {
      const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
      const now = () => testClock.currentTimeMillisUnsafe();
      const controller = yield* makePreviewSessionController(now);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-web": "sha256:manifest" },
        requestedRevision: "revision-a",
      });
      yield* controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        "revision-a",
      );
      let heartbeatCalls = 0;
      const flakyController: PreviewSessionControllerApi = {
        ...controller,
        heartbeat: (id, supervisorIdentity, generation) => {
          heartbeatCalls += 1;
          return heartbeatCalls === 3
            ? controller.heartbeat(id, supervisorIdentity, generation)
            : Effect.fail(new PreviewSessionError({ reason: "transient-controller-failure" }));
        },
      };
      const gateway = yield* makePreviewGateway({ domain: "", controller, now });
      let processStops = 0;
      const runtime = {
        start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
        status: () => Effect.succeed(true),
        measurements: () => Effect.succeed(undefined),
        stop: () => Effect.sync(() => void processStops++),
      } satisfies PreviewWebRuntimeApi;
      const fiber = yield* superviseSheetWebPreview({
        sessionId: created.session.id,
        ownerIdentity: created.ownerIdentity,
        supervisorIdentity: created.supervisorIdentity,
        generation: created.session.generation,
        controller: flakyController,
        gateway,
        runtime,
      }).pipe(Effect.forkChild);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
        yield* Effect.yieldNow;
        expect((yield* controller.status(created.session.id)).phase).toBe("active");
        expect(processStops).toBe(0);
      }
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
      expect(heartbeatCalls).toBe(6);
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
      expect(processStops).toBe(1);
      yield* Fiber.join(fiber);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: ":memory:" }),
          NodeServices.layer,
          TestClock.layer(),
          FetchHttpClient.layer,
        ),
      ),
    ),
);

it.effect("cleans the owned web process when another owner path ends the session", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    const actualGateway = yield* makePreviewGateway({ domain: "", controller, now });
    let routeCleanupCalls = 0;
    const gateway: PreviewGatewayApi = {
      ...actualGateway,
      cleanupSession: () => Effect.sync(() => void routeCleanupCalls++),
    };
    let processStops = 0;
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.sync(() => void processStops++),
    } satisfies PreviewWebRuntimeApi;
    const fiber = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      controller,
      gateway,
      runtime,
    }).pipe(Effect.forkChild);
    yield* controller.stop(created.session.id, created.ownerIdentity);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    yield* Fiber.join(fiber);
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    expect(routeCleanupCalls).toBe(1);
    expect(processStops).toBe(1);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
        FetchHttpClient.layer,
      ),
    ),
  ),
);

it.effect("keeps dependency probes fail-closed but tolerates two transient failures", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    let probeCount = 0;
    let processStopped = false;
    let stopAttempts = 0;
    let routesCleaned = false;
    const actualGateway = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = {
      ...actualGateway,
      cleanupSession: (sessionId, ownerIdentity) =>
        Effect.tap(actualGateway.cleanupSession(sessionId, ownerIdentity), () =>
          Effect.sync(() => {
            routesCleaned = true;
          }),
        ),
    };
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () =>
        Effect.suspend(() => {
          stopAttempts += 1;
          if (stopAttempts === 1)
            return Effect.fail(
              new PreviewWebRuntimeError({ reason: "web-process-cleanup-failed" }),
            );
          processStopped = true;
          return Effect.void;
        }),
    } satisfies PreviewWebRuntimeApi;
    const fiber = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      controller,
      gateway,
      runtime,
      checkDependencies: () =>
        Effect.sync(() => {
          probeCount += 1;
          return "temporarily unavailable";
        }),
    }).pipe(Effect.forkChild);
    for (let index = 1; index <= 2; index += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
      expect((yield* controller.status(created.session.id)).phase).toBe("active");
      expect(probeCount).toBe(index);
    }
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    expect(probeCount).toBe(3);
    expect(stopAttempts).toBe(1);
    for (let retry = 0; retry < 5 && !processStopped; retry += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
    }
    expect(stopAttempts).toBe(2);
    expect(processStopped).toBe(true);
    expect(routesCleaned).toBe(true);
    yield* Fiber.join(fiber);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
        FetchHttpClient.layer,
      ),
    ),
  ),
);

it.effect("does not count revision registration transitions as dependency failures", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "owner",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    const active = yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    const registrationStarted = yield* Deferred.make<void>();
    const finishDependencyRegistration = yield* Deferred.make<void>();
    let routeRevision = "revision-a";
    let dependencyRevision = "revision-a";
    let dependencyDrift = false;
    let dependencyProbes = 0;
    let cleanupCalls = 0;
    const baseGateway = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = {
      ...baseGateway,
      register: (target) =>
        Effect.sync(() => {
          routeRevision = target.revision;
          return { hostname: "p-session-revision-transition", target };
        }),
      registerApplicationDependencies: (target) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(registrationStarted, undefined);
          yield* Deferred.await(finishDependencyRegistration);
          dependencyRevision = target.revision;
        }),
      cleanupSession: () => Effect.sync(() => void cleanupCalls++),
    };
    const target: PreviewGatewayTarget = {
      sessionId: created.session.id,
      generation: active.generation,
      role: "sheet-web",
      processId: "web-process",
      revision: "revision-a",
      artifactDigest: "sha256:" + "a".repeat(64),
      catalogDigest: "sha256:" + "b".repeat(64),
      stateGroup: "application-zero",
      serviceFqdn: "web.preview-relays.svc.cluster.local",
      serviceResourceId: "web-service",
      attachmentResourceId: "web-attachment",
      port: 4100,
      kind: "application",
    };
    const authority = {
      supervisorIdentity: created.supervisorIdentity,
      generation: active.generation,
    };
    const onRevision = makeSheetWebRevisionHandler(
      target,
      [],
      created,
      authority,
      controller,
      gateway,
    );
    const revisionFiber = yield* Effect.forkChild(onRevision("revision-b"));
    yield* Deferred.await(registrationStarted);
    expect((yield* controller.status(created.session.id)).phase).toBe("starting");

    let stopAttempts = 0;
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.sync(() => void stopAttempts++),
    } satisfies PreviewWebRuntimeApi;
    const supervisor = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: authority.supervisorIdentity,
      generation: authority.generation,
      controller,
      gateway,
      runtime,
      checkDependencies: () =>
        Effect.gen(function* () {
          dependencyProbes += 1;
          const state = yield* controller.status(created.session.id);
          return state.phase === "starting" ||
            routeRevision !== dependencyRevision ||
            dependencyDrift
            ? "application dependency revision is not ready"
            : undefined;
        }),
    }).pipe(Effect.forkChild);

    const transitionPhases: string[] = [];
    for (let probe = 0; probe < 3; probe += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
      transitionPhases.push((yield* controller.status(created.session.id)).phase);
    }
    const transitionStopAttempts = stopAttempts;

    yield* Deferred.succeed(finishDependencyRegistration, undefined);
    const revisionResult = yield* Effect.exit(Fiber.join(revisionFiber));
    const activated = yield* controller.status(created.session.id);
    expect(revisionResult._tag).toBe("Success");
    expect(activated.phase).toBe("active");
    expect(activated.activeRevision).toBe("revision-b");
    expect(transitionPhases).toEqual(["starting", "starting", "starting"]);
    expect(transitionStopAttempts).toBe(0);

    dependencyDrift = true;
    for (let probe = 1; probe <= 3; probe += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
      const state = yield* controller.status(created.session.id);
      expect(state.phase).toBe(probe < 3 ? "active" : "ended");
    }
    expect(dependencyProbes).toBe(6);
    expect(stopAttempts).toBe(1);
    expect(cleanupCalls).toBe(1);
    yield* Fiber.join(supervisor);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SqliteClient.layer({ filename: ":memory:" }),
        NodeServices.layer,
        TestClock.layer(),
        FetchHttpClient.layer,
      ),
    ),
  ),
);

it.effect(
  "returns after bounded supervisor cleanup retries when process cleanup stays unproven",
  () =>
    Effect.gen(function* () {
      const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
      const now = () => testClock.currentTimeMillisUnsafe();
      const controller = yield* makePreviewSessionController(now);
      const created = yield* controller.create({
        owner: "owner",
        checkout: "/checkout",
        manifests: { "sheet-web": "sha256:manifest" },
        requestedRevision: "revision-a",
      });
      yield* controller.activate(
        created.session.id,
        created.session.generation,
        created.supervisorIdentity,
        "revision-a",
      );
      const gateway = yield* makePreviewGateway({ domain: "", controller, now });
      let processStops = 0;
      const runtime = {
        start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
        status: () => Effect.succeed(true),
        measurements: () => Effect.succeed(undefined),
        stop: () =>
          Effect.suspend(() => {
            processStops += 1;
            return Effect.fail(new PreviewWebRuntimeError({ reason: "cleanup-unconfirmed" }));
          }),
      } satisfies PreviewWebRuntimeApi;
      const fiber = yield* superviseSheetWebPreview({
        sessionId: created.session.id,
        ownerIdentity: created.ownerIdentity,
        supervisorIdentity: created.supervisorIdentity,
        generation: created.session.generation,
        controller,
        gateway,
        runtime,
        checkDependencies: () => Effect.succeed("temporarily unavailable"),
      }).pipe(Effect.forkChild);
      for (let probe = 1; probe <= 3; probe += 1) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
        yield* Effect.yieldNow;
        if (probe < 3) expect((yield* controller.status(created.session.id)).phase).toBe("active");
      }
      expect((yield* controller.status(created.session.id)).phase).toBe("ended");
      expect(processStops).toBe(1);
      for (let retry = 0; retry < 9; retry += 1) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Effect.yieldNow;
      }
      yield* Fiber.join(fiber);
      expect(processStops).toBe(10);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: ":memory:" }),
          NodeServices.layer,
          TestClock.layer(),
          FetchHttpClient.layer,
        ),
      ),
    ),
);
