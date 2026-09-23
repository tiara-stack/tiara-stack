import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Path, Scope } from "effect";
import { parseCommand, runLauncher, type ProcessExecutor } from "./index";

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

const liveTest = <E, R extends NodeServices.NodeServices | Scope.Scope>(
  name: string,
  run: () => Effect.Effect<void, E, R>,
) => it.live(name, () => run().pipe(Effect.provide(NodeServices.layer)));

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
    expect(results.human.stdout).toContain("workspace-preparation: unavailable");
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
    expect(output.errors.every(({ code }) => code === "prerequisite-unavailable")).toBe(true);
    expect(executions).toEqual([]);
  }),
);

const blockedPreviewActions: readonly [string, readonly string[]][] = [
  ["start", ["start", "--config", "/missing/preview.json"]],
  ["status", ["status", "--session", "session-123"]],
  ["resume", ["resume", "--session", "session-123"]],
  ["stop", ["stop", "--session", "session-123"]],
  ["cleanup", ["cleanup", "--session", "session-123"]],
];

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
          errors: [expect.objectContaining({ code: "not-implemented" })],
        }),
      );
      expect(executions).toEqual([]);
    }),
  );
}
