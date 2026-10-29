import { expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlClientType from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { Command } from "effect/unstable/cli";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Schema,
  Scope,
} from "effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { TestClock, TestConsole } from "effect/testing";
import {
  command,
  composeWorkflowPreviewLauncherOptions,
  PreviewSupervisorSchedulerService,
  workflowPreviewProviderLayerForArguments,
  type PreviewSupervisorEffect,
} from "./cli";
import { parseCommand, parsePositionals, runLauncher, type ProcessExecutor } from "./index";
import { makePreviewGateway, PreviewGatewayError } from "./preview-gateway";
import {
  makeConnectedWorkflowPreviewRuntime,
  ConnectedWorkflowPreviewRuntimeError,
  connectedPreviewOutput,
  connectedPreviewConfigSchema,
  WorkflowRecreationRecoveryRecordSchema,
  makeSheetWebRevisionHandler,
  stopResumedWebSession,
  superviseSheetWebPreview,
  workflowArtifactEvidenceMatchesRoles,
  workflowPreviewRuntimeContractCatalogIdentity,
  type ConnectedPreviewConfig,
  type ConnectedWorkflowPreviewProviderApi,
} from "./connected-preview";
import {
  makePreviewSessionController,
  previewSessionHeartbeatMs,
  previewSessionHeartbeatFailureLimit,
  previewSessionLeaseMs,
  previewSupervisorLeaseMs,
  PreviewSessionError,
  PreviewSessionController,
  type PreviewSession,
  type SessionCredentials,
  type PreviewSessionControllerApi,
} from "./preview-sessions";
import type { PreviewGatewayApi, PreviewGatewayTarget } from "./preview-gateway";
import {
  makePreviewWebRuntime,
  PreviewWebRuntimeError,
  type PreviewWebRuntimeApi,
} from "./preview-web-runtime";
import {
  workflowExecutionGroupIdentity,
  WorkflowExecutionError,
  type WorkflowExecutionArtifacts,
  type WorkflowExecutionGroup,
  type IncompatibleWorkflowRecreationRuntimeApi,
} from "./owned-workflow-execution";
import {
  sealStagedSourceSnapshot,
  SnapshotRuntimeError,
  type StagedRunnerRuntimeApi,
} from "./staged-source";
import {
  makeLocalFilesystemPreviewResourceAdapter,
  makePreviewAllocationController,
  PreviewAllocationError,
  previewCapacityDimensionsByGroup,
  type PreviewAllocationApi,
} from "./preview-allocations";
import type { ConnectedPreviewAction, LauncherOptions, LauncherOutput } from "./types";

import {
  previewRelayDoctorCheckIds,
  PreviewRelayProviderUnavailable,
  previewRelayHostRoles,
} from "./preview-relay-provider";

const JsonRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const decodeJsonRecord = (input: unknown) => Schema.decodeUnknownSync(JsonRecordSchema)(input);

const parseJsonRecord = (input: string) => decodeJsonRecord(JSON.parse(input));

const parseWorkflowRecreationRecoveryRecord = (input: string) =>
  Schema.decodeUnknownSync(WorkflowRecreationRecoveryRecordSchema)(JSON.parse(input));

const connectedPreviewPlanOutputSchema = Schema.Struct({
  connectedPreview: Schema.Struct({
    requiredRoles: Schema.Array(Schema.String),
    missingRoles: Schema.Array(Schema.String),
    compatibility: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        contract: Schema.NullOr(Schema.String),
        requiredCallers: Schema.Array(Schema.String),
      }),
    ),
  }),
});

const successfulRecreationOutputSchema = Schema.Struct({
  previewSession: Schema.Struct({
    id: Schema.String,
    phase: Schema.String,
    activeRevision: Schema.String,
    workflowRecreation: Schema.Struct({
      oldCleanupRecordId: Schema.String,
      priorRevision: Schema.optionalKey(Schema.String),
      requestedRevision: Schema.optionalKey(Schema.String),
      reasons: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
    workflowTransitionPhases: Schema.Record(Schema.String, Schema.Unknown),
  }),
});
import {
  cessationEvidence,
  ambiguousOldWork,
  drainedOldWork,
  producerFenceEvidence,
  settledOldWork,
  workflowDefinition,
} from "./workflow-recreation.test-fixtures";

it.live("bounds configured workflow activation preflight at the exported runtime boundary", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const config: ConnectedPreviewConfig = {
      schemaVersion: 1,
      environment: "tiara-stack-dev",
      profile: "connected-preview-dev-v1",
      owner: "developer:alice",
      roles: ["sheet-workflows-api"],
      identities: {
        sourceRevision: previewSourceRevision,
        artifactDigests: { "sheet-workflows-api": previewArtifactDigest },
        deployedManifestDigest: previewManifestDigest,
        catalogVersion: 1,
      },
      environmentFileInputs: [
        { role: "sheet-workflows-api", path: "environment/sheet-workflows-api.env" },
      ],
      groups: [],
      changes: [],
      credentialReferences: {},
      sharedExecution: "disabled",
    };
    const controller = yield* makePreviewSessionController(Date.now);
    const created = yield* controller.create({
      owner: config.owner,
      checkout: process.cwd(),
      manifests: {
        ...config.identities.artifactDigests,
        "deployed-manifest": config.identities.deployedManifestDigest,
      },
      requestedRevision: "activation-preflight",
      groups: config.groups.map(({ id }) => id),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const lifecycleScope = yield* Effect.scope;
    const runtime = makeConnectedWorkflowPreviewRuntime({
      provider: {
        _tag: "Configured",
        resolveActivation: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
      },
      controller,
      fileSystem,
    });
    const resolution = yield* runtime
      .resolveActivation(
        {
          session: created.session,
          ownerIdentity: created.ownerIdentity,
          config,
          checkout: process.cwd(),
        },
        lifecycleScope,
      )
      .pipe(Effect.exit, Effect.forkChild);
    yield* Deferred.await(started);
    for (let attempt = 0; attempt < 3 && resolution.pollUnsafe() === undefined; attempt++) {
      yield* TestClock.adjust(Duration.seconds(60));
      yield* Effect.yieldNow;
    }
    const exit = resolution.pollUnsafe();
    if (exit === undefined) yield* Fiber.interrupt(resolution);
    expect(exit).not.toBeUndefined();
    if (exit === undefined) return;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (!Exit.isSuccess(exit)) return;
    expect(Exit.isFailure(exit.value)).toBe(true);
    if (!Exit.isFailure(exit.value)) return;
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.value.cause));
    expect(failure).toBeInstanceOf(ConnectedWorkflowPreviewRuntimeError);
    if (failure instanceof ConnectedWorkflowPreviewRuntimeError)
      expect(failure.reason).toBe("provider-activation-timeout");

    const maskedTimeout = yield* Effect.uninterruptible(
      Effect.interruptible(
        Effect.timeoutOrElse(Effect.never, {
          duration: "60 seconds",
          orElse: () => Effect.succeed("timed out"),
        }),
      ),
    ).pipe(Effect.forkChild);
    yield* TestClock.adjust(Duration.seconds(60));
    expect(yield* Fiber.join(maskedTimeout)).toBe("timed out");
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

it("matches workflow artifact evidence only for declared workload roles", () => {
  const apiDigest = "a".repeat(64);
  const runnerDigest = "b".repeat(64);
  const browserRunnerDigest = "d".repeat(64);
  const deploymentDigest = "c".repeat(64);
  const apiOnlyManifests = {
    "sheet-workflows-api": `sha256:${apiDigest}`,
    "deployed-manifest": `sha256:${deploymentDigest}`,
  };
  expect(
    workflowArtifactEvidenceMatchesRoles({
      workloadRoles: ["workflow_api"],
      apiDigest,
      runnerDigest,
      deploymentDigest,
      manifests: apiOnlyManifests,
    }),
  ).toBe(true);
  expect(
    workflowArtifactEvidenceMatchesRoles({
      workloadRoles: ["workflow_api", "ordinary_runner"],
      apiDigest,
      runnerDigest,
      deploymentDigest,
      manifests: apiOnlyManifests,
    }),
  ).toBe(false);
  expect(
    workflowArtifactEvidenceMatchesRoles({
      workloadRoles: ["workflow_api", "workflow_api"],
      apiDigest,
      runnerDigest,
      deploymentDigest,
      manifests: apiOnlyManifests,
    }),
  ).toBe(false);
  expect(
    workflowArtifactEvidenceMatchesRoles({
      workloadRoles: ["workflow_admin"],
      apiDigest,
      runnerDigest,
      deploymentDigest,
      manifests: apiOnlyManifests,
    }),
  ).toBe(false);

  const browserManifests = {
    ...apiOnlyManifests,
    "sheet-workflows-runner": `sha256:${runnerDigest}`,
    "sheet-workflows-browser-runner": `sha256:${browserRunnerDigest}`,
  };
  expect(
    workflowArtifactEvidenceMatchesRoles({
      workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
      apiDigest,
      runnerDigest,
      runnerArtifacts: {
        ordinary_runner: runnerDigest,
        browser_runner: browserRunnerDigest,
      },
      deploymentDigest,
      manifests: browserManifests,
    }),
  ).toBe(true);
  expect(
    workflowArtifactEvidenceMatchesRoles({
      workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
      apiDigest,
      runnerDigest,
      runnerArtifacts: { ordinary_runner: runnerDigest },
      deploymentDigest,
      manifests: browserManifests,
    }),
  ).toBe(false);
  expect(
    workflowArtifactEvidenceMatchesRoles({
      workloadRoles: ["workflow_api", "browser_runner"],
      apiDigest,
      runnerDigest: browserRunnerDigest,
      deploymentDigest,
      manifests: browserManifests,
    }),
  ).toBe(true);
  expect(
    workflowArtifactEvidenceMatchesRoles({
      workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
      apiDigest,
      runnerDigest,
      runnerArtifacts: {
        ordinary_runner: runnerDigest,
        browser_runner: browserRunnerDigest,
        unsupported: "e".repeat(64),
      },
      deploymentDigest,
      manifests: browserManifests,
    }),
  ).toBe(false);
});

it.live(
  "persists unverified recovery when fresh-session status hangs after activation failure",
  () => {
    const workingDirectory = path.join("/tmp", `tia249-recovery-read-${randomUUID()}`);
    return Effect.gen(function* () {
      const testClock = yield* TestClock.testClockWith((value) => Effect.succeed(value));
      const recoveryTimeoutStarted = yield* Deferred.make<void>();
      const releaseRecoveryTimeout = yield* Deferred.make<void>();
      let recoveryStatusReadStarted = false;
      let recoveryTimeoutIntercepted = false;
      const clock: Clock.Clock = {
        ...testClock,
        sleep: (duration) => {
          if (
            recoveryStatusReadStarted &&
            !recoveryTimeoutIntercepted &&
            Duration.toMillis(duration) === 60_000
          ) {
            recoveryTimeoutIntercepted = true;
            return Deferred.succeed(recoveryTimeoutStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRecoveryTimeout)),
            );
          }
          return testClock.sleep(duration);
        },
      };
      const fileSystem = yield* FileSystem.FileSystem;
      const sessionDatabase = path.join(workingDirectory, "controller.sqlite");
      const credentialsDirectory = `${sessionDatabase}.credentials`;
      yield* fileSystem.makeDirectory(credentialsDirectory, { recursive: true, mode: 0o700 });

      const controller = yield* makePreviewSessionController(() => clock.currentTimeMillisUnsafe());
      const artifacts: WorkflowExecutionArtifacts = {
        api: "a".repeat(64),
        runner: "b".repeat(64),
        contracts: "c".repeat(64),
        deployment: "d".repeat(64),
        workflowVersion: "1.0.0",
        actionVersions: { action: "1" },
      };
      const manifests = {
        "sheet-workflows-api": `sha256:${artifacts.api}`,
        "deployed-manifest": `sha256:${artifacts.deployment}`,
      };
      const oldSession = yield* controller.create({
        owner: "recovery-owner",
        checkout: workingDirectory,
        manifests,
        requestedRevision: "revision-old",
        groups: ["workflow-execution"],
      });
      yield* controller.activate(
        oldSession.session.id,
        oldSession.session.generation,
        oldSession.supervisorIdentity,
        "revision-old",
      );
      const freshSession = yield* controller.create({
        owner: "recovery-owner",
        checkout: workingDirectory,
        manifests: {
          ...manifests,
          "workflow-recreation-prior-cleanup-record": `cleanup-${oldSession.session.id}`,
        },
        requestedRevision: "revision-new",
        groups: ["workflow-execution"],
      });
      yield* fileSystem.writeFileString(
        path.join(credentialsDirectory, freshSession.session.id),
        JSON.stringify({
          ownerIdentity: freshSession.ownerIdentity,
          supervisorIdentity: freshSession.supervisorIdentity,
        }),
        { mode: 0o600 },
      );

      const statusReadStarted = yield* Deferred.make<void>();
      const statusReadRelease = yield* Deferred.make<PreviewSession>();
      let firstFreshStatusRead = true;
      let freshStopCalls = 0;
      const recoveryController: PreviewSessionControllerApi = {
        ...controller,
        status: (id) => {
          if (id === freshSession.session.id && firstFreshStatusRead) {
            firstFreshStatusRead = false;
            recoveryStatusReadStarted = true;
            return Deferred.succeed(statusReadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(statusReadRelease)),
            );
          }
          return controller.status(id);
        },
        stop: (id, ownerIdentity, expectedGeneration) => {
          if (id === freshSession.session.id) freshStopCalls += 1;
          return controller.stop(id, ownerIdentity, expectedGeneration);
        },
      };
      const oldGroup = workflowExecutionGroupIdentity({
        sessionId: oldSession.session.id,
        ownerToken: oldSession.ownerIdentity,
        generation: oldSession.session.generation,
        database: `database_${oldSession.session.id.replaceAll("-", "_")}`,
        apiEndpoint: "http://workflow-api.test",
        observationEndpoint: "http://workflow-observation.test",
        artifacts,
        workloadOAuthClientIds: { workflow_api: `client-${oldSession.session.id}` },
      });
      const recreationRuntime: IncompatibleWorkflowRecreationRuntimeApi = {
        presentProposal: () => Effect.void,
        pauseAdmission: () => Effect.void,
        fenceProducers: ({ expectedBinding }) =>
          Effect.succeed(producerFenceEvidence(expectedBinding)),
        drainOldWork: ({ expectedBinding }) => Effect.succeed(drainedOldWork(expectedBinding)),
        settleWithOldCode: ({ expectedBinding }) => Effect.succeed(settledOldWork(expectedBinding)),
        proveOldCessation: ({ expectedBinding }) =>
          Effect.succeed(cessationEvidence(expectedBinding)),
        endOldSessionAndCleanup: () => Effect.succeed(`cleanup-${oldSession.session.id}`),
        provisionFreshGroup: () => Effect.succeed({}),
        quarantine: () => Effect.void,
        blockOrdinaryReassignment: () => Effect.succeed(false),
        quarantineFreshGroup: () => Effect.void,
      };
      const stagedRuntime: StagedRunnerRuntimeApi = {
        authorizeActivation: () => Effect.void,
        stageComplete: () => Effect.void,
        fenceOldOwner: () => Effect.void,
        activateComplete: () => Effect.void,
        retainImmutableRevision: () => Effect.void,
        rebuildArtifacts: () => Effect.void,
        restartRole: () => Effect.void,
        verifyActualReadiness: () => Effect.succeed(true),
        resolveWorkflowArtifacts: () => Effect.succeed(artifacts),
        persistWorkflowRecreationDiagnostic: () => Effect.void,
        workflowRecreation: recreationRuntime,
      };
      const definition = (sourceRevision: string) =>
        workflowDefinition(sourceRevision, artifacts, ["workflow-execution"], ["workflow_api"]);
      const snapshot = sealStagedSourceSnapshot("revision-old", [
        { path: "package.json", contentEncoding: "utf8", content: "{}", mode: 0o644 },
      ]);
      const activation = {
        oldGroup,
        previous: definition("revision-old"),
        previousSnapshot: snapshot,
        proposed: definition("revision-new"),
        snapshot: sealStagedSourceSnapshot("revision-new", snapshot.files),
        owner: oldSession.ownerIdentity,
        nextOwner: freshSession.ownerIdentity,
        roles: ["workflow-api"] as const,
        runtime: stagedRuntime,
      };
      const runtime = makeConnectedWorkflowPreviewRuntime({
        provider: { _tag: "Configured", resolveActivation: () => Effect.never },
        controller: recoveryController,
        fileSystem,
        clock,
        env: { TIARA_PREVIEW_SESSION_DATABASE: sessionDatabase },
      });
      const diagnostic = {
        oldCleanupRecordId: `cleanup-${oldSession.session.id}`,
        freshSessionId: freshSession.session.id,
        freshGeneration: freshSession.session.generation,
        priorRevision: "revision-old",
        requestedRevision: "revision-new",
        reasons: ["workflow-contracts-changed"] as const,
      };
      const recoveryFiber = yield* Effect.uninterruptible(
        runtime.recoverFailedActivation({
          oldSession: oldSession.session,
          ownerIdentity: oldSession.ownerIdentity,
          activation,
          checkout: workingDirectory,
          reason: "fresh durable session activation was not confirmed",
          diagnostic,
        }),
      ).pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);
      yield* Deferred.await(statusReadStarted);
      const timeoutObservation = yield* Effect.raceFirst(
        Deferred.await(recoveryTimeoutStarted).pipe(Effect.as(true)),
        Effect.sleep(Duration.seconds(1)).pipe(Effect.as(false)),
      ).pipe(Effect.provideService(Clock.Clock, clock), Effect.forkChild);
      let timeoutObservedExit = timeoutObservation.pollUnsafe();
      for (let attempt = 0; attempt < 10 && timeoutObservedExit === undefined; attempt++) {
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Effect.yieldNow;
        timeoutObservedExit = timeoutObservation.pollUnsafe();
      }
      const timeoutWasApplied =
        timeoutObservedExit !== undefined && Exit.isSuccess(timeoutObservedExit)
          ? timeoutObservedExit.value
          : false;
      if (!timeoutWasApplied)
        yield* Deferred.succeed(
          statusReadRelease,
          yield* controller.status(freshSession.session.id),
        );
      yield* Deferred.succeed(releaseRecoveryTimeout, undefined);
      const recovered = yield* Fiber.join(recoveryFiber);
      expect(timeoutWasApplied).toBe(true);
      expect(recovered.recovery).toMatchObject({
        freshSessionDisposition: "state-unverified",
        freshGroupQuarantineDisposition: "quarantined",
        quarantineDisposition: "quarantined",
        recoveryRecordWritten: true,
      });
      expect(freshStopCalls).toBe(0);

      const recoveryPath = path.join(
        credentialsDirectory,
        `${freshSession.session.id}.workflow-recreation-recovery.json`,
      );
      const recoveryRecord = parseWorkflowRecreationRecoveryRecord(
        yield* fileSystem.readFileString(recoveryPath),
      );
      expect(recoveryRecord.oldCleanupRecordId).toBe(`cleanup-${oldSession.session.id}`);
      expect(recoveryRecord.recovery.freshSessionDisposition).toBe("state-unverified");
      expect((yield* controller.status(freshSession.session.id)).phase).toBe("pending");
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem
            .remove(workingDirectory, { recursive: true, force: true })
            .pipe(Effect.ignore);
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: ":memory:" }),
          NodeServices.layer,
          TestClock.layer(),
        ),
      ),
    );
  },
);

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

const liveTestWithTestClock = <
  E,
  R extends NodeServices.NodeServices | Scope.Scope | HttpClient.HttpClient,
>(
  name: string,
  run: () => Effect.Effect<void, E, R>,
) =>
  it.live(name, () =>
    run().pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(TestClock.layer()),
      Effect.provide(TestConsole.layer),
    ),
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
  const definition =
    previewRoleContracts[
      role /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as keyof typeof previewRoleContracts /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */
    ];
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
      roles.flatMap(
        (role) =>
          previewRoleGroups[
            role /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as keyof typeof previewRoleGroups /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */
          ] ?? [],
      ),
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
        [previewRoleCredentialNames[
          role /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as keyof typeof previewRoleCredentialNames /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */
        ]?.[0] ?? ""]:
          `secret://tiara-stack-dev/${role}/${previewRoleCredentialNames[role /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as keyof typeof previewRoleCredentialNames /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */]?.[0] ?? ""}`,
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
    readonly previewRelayProvider?: LauncherOptions["previewRelayProvider"];
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
              ...(options.previewRelayProvider === undefined
                ? {}
                : { previewRelayProvider: options.previewRelayProvider }),
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
    expect(result.stdout).toContain(
      "pnpm dev preview recreate --config <file> --session <id> --confirm-development",
    );
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
  const recreate = parseCommand([
    "preview",
    "recreate",
    "--config",
    "preview.json",
    "--session",
    "session-123",
    "--confirm-development",
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
  expect(recreate).toEqual(
    expect.objectContaining({
      kind: "preview",
      action: "recreate",
      options: expect.objectContaining({
        configFile: "preview.json",
        sessionId: "session-123",
        confirmDevelopment: true,
      }),
    }),
  );
  expect(() =>
    parseCommand(["preview", "recreate", "--config", "preview.json", "--session", "session-123"]),
  ).toThrow(/--confirm-development/);
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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
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
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
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
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
    const reportedConsumers = new Map<string, string[]>();

    for (const role of output.connectedPreview.roleCatalog) {
      const expected =
        previewRoleContracts[
          role.role /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as keyof typeof previewRoleContracts /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */
        ];
      expect(role.providedContracts).toEqual(expected.provided);
      expect(role.consumedContracts).toEqual(expected.consumed);
      expect(role.credentialNames).toEqual(
        previewRoleCredentialNames[
          role.role /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as keyof typeof previewRoleCredentialNames /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */
        ],
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

liveTest(
  "requires the browser runner for incompatible execution only when the preview uses browser behavior",
  () =>
    Effect.gen(function* () {
      const ordinaryOnly = yield* runConnectedPreviewConfig(
        "plan",
        createConnectedPreviewConfig({
          roles: ["sheet-workflows-api", "sheet-workflows-runner"],
          changeOverrides: {
            "sheet-workflows-runner:workflow.execution": { classification: "incompatible" },
          },
        }),
      );
      const ordinaryOutput = Schema.decodeUnknownSync(connectedPreviewPlanOutputSchema)(
        JSON.parse(ordinaryOnly.stdout),
      );
      expect(ordinaryOnly.exitCode).toBe(0);
      expect(ordinaryOutput.connectedPreview.missingRoles).toEqual([]);
      expect(ordinaryOutput.connectedPreview.requiredRoles).toContain("sheet-workflows-api");
      expect(ordinaryOutput.connectedPreview.requiredRoles).toContain("sheet-workflows-runner");
      expect(ordinaryOutput.connectedPreview.requiredRoles).not.toContain(
        "sheet-workflows-browser-runner",
      );
      expect(
        ordinaryOutput.connectedPreview.compatibility.find(
          ({ role, contract }) =>
            role === "sheet-workflows-runner" && contract === "workflow.execution",
        )?.requiredCallers,
      ).toEqual(["sheet-workflows-api"]);

      const browserWorkflow = yield* runConnectedPreviewConfig(
        "plan",
        createConnectedPreviewConfig({
          roles: [
            "sheet-workflows-api",
            "sheet-workflows-runner",
            "sheet-workflows-browser-runner",
          ],
          changeOverrides: {
            "sheet-workflows-runner:workflow.execution": { classification: "incompatible" },
            "sheet-workflows-browser-runner:workflow.browser": {
              classification: "incompatible",
            },
          },
        }),
      );
      const browserOutput = Schema.decodeUnknownSync(connectedPreviewPlanOutputSchema)(
        JSON.parse(browserWorkflow.stdout),
      );
      expect(browserWorkflow.exitCode).toBe(0);
      expect(browserOutput.connectedPreview.missingRoles).toEqual([]);
      expect(browserOutput.connectedPreview.requiredRoles).toEqual(
        expect.arrayContaining([
          "sheet-workflows-api",
          "sheet-workflows-runner",
          "sheet-workflows-browser-runner",
        ]),
      );
      expect(
        browserOutput.connectedPreview.compatibility.find(
          ({ role, contract }) =>
            role === "sheet-workflows-runner" && contract === "workflow.execution",
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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly connectedPreview: {
        readonly compatibility: readonly {
          readonly contract: string | null;
          readonly classification: string;
        }[];
      };
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly connectedPreview: {
        readonly credentialReferences: readonly {
          readonly role: string;
          readonly names: readonly string[];
          readonly status: string;
        }[];
      };
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly errors: readonly { readonly code: string; readonly dependency: string | null }[];
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly connectedPreview: {
        readonly declaredIntent: { readonly sharedExecution: string };
        readonly requiredGroups: readonly { readonly id: string; readonly ownership: string }[];
      };
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

    const event = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly format: string;
      readonly eventVersion: number;
      readonly sequence: number;
      readonly type: string;
      readonly mode: string;
      readonly connectedPreview: { readonly executionAvailable: boolean };
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

      const output = JSON.parse(
        result.stdout,
      ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
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
      } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly connectedPreview: {
        readonly missingRoles: readonly string[];
        readonly requiredGroups: readonly { readonly id: string; readonly ownership: string }[];
      };
      readonly errors: readonly { readonly code: string }[];
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

      const output = JSON.parse(
        result.stdout,
      ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
        readonly errors: readonly { readonly code: string }[];
      } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly errors: readonly { readonly code: string }[];
      readonly warnings: readonly { readonly code: string }[];
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly readiness: string;
      readonly plannedProcesses: readonly unknown[];
      readonly errors: readonly { readonly code: string }[];
      readonly connectedPreview: {
        readonly status: string;
        readonly prerequisites: readonly { readonly status: string }[];
      };
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

liveTest("maps an unknown doctor provider check to the generic unavailable diagnostic", () =>
  Effect.gen(function* () {
    const provider: NonNullable<LauncherOptions["previewRelayProvider"]> = {
      ...PreviewRelayProviderUnavailable(),
      configured: true,
      checkPreparedWorkspace: () =>
        Effect.succeed([
          {
            id: "future-provider-check",
            status: "failed",
            detail: "The provider reported a check unknown to this launcher version.",
          },
        ]),
    };
    const result = yield* runConnectedPreviewConfig(
      "doctor",
      createConnectedPreviewConfig({ roles: ["sheet-auth"] }),
      { previewRelayProvider: provider },
    );
    const parsed: unknown = JSON.parse(result.stdout);
    const errors =
      typeof parsed === "object" &&
      parsed !== null &&
      "errors" in parsed &&
      Array.isArray(parsed.errors)
        ? parsed.errors
        : [];

    expect(result.exitCode).toBe(2);
    expect(errors).toContainEqual(
      expect.objectContaining({
        code: "prerequisite-unavailable",
        dependency: "future-provider-check",
      }),
    );
  }),
);

liveTest("deduplicates missing capacity dimensions shared by owned groups", () =>
  Effect.gen(function* () {
    const result = yield* runConnectedPreviewConfig(
      "doctor",
      createConnectedPreviewConfig({ roles: ["sheet-db-server"] }),
    );

    const output = JSON.parse(
      result.stdout,
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
      readonly errors: readonly { readonly message: string }[];
    } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
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
                          group /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as keyof typeof previewCapacityDimensionsByGroup /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */
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

const recordWorkflowRecreationStopForTest = (input: {
  readonly id: string;
  readonly oldSessionId: string;
  readonly events: string[];
  readonly breakCredentialPathAfterOldStop: { current: boolean };
  readonly environment: NodeJS.ProcessEnv;
}) => {
  const isOldSession = input.id === input.oldSessionId;
  input.events.push(isOldSession ? "end-old-session" : "stop-fresh-session");
  if (isOldSession && input.breakCredentialPathAfterOldStop.current) {
    delete input.environment.TIARA_PREVIEW_SESSION_DATABASE;
    input.breakCredentialPathAfterOldStop.current = false;
  }
};

const requireSessionCredentials = (
  credentials: SessionCredentials | undefined,
): SessionCredentials => {
  if (credentials === undefined) throw new Error("fresh session credentials were not captured");
  return credentials;
};

const requireCliOutput = (output: unknown, message: string): string => {
  if (typeof output !== "string") throw new Error(message);
  return output;
};

const requireSessionId = (id: string | undefined): string => {
  if (id === undefined) throw new Error("fresh session ID was not captured");
  return id;
};

const sessionStatusWithControlledFailure = (input: {
  readonly controller: PreviewSessionControllerApi;
  readonly id: string;
  readonly failAfterOldStop: { readonly current: boolean };
  readonly stoppedSessionIds: ReadonlySet<string>;
  readonly oldSessionId: string;
}) => {
  if (
    input.failAfterOldStop.current &&
    input.stoppedSessionIds.has(input.id) &&
    input.id === input.oldSessionId
  )
    return Effect.fail(new PreviewSessionError({ reason: "controlled-old-status-unavailable" }));
  return input.controller.status(input.id);
};

const assertCachedOldSessionFallback = (output: string, oldCleanupRecordId: string) => {
  expect(parseJsonRecord(output)).toMatchObject({
    previewSession: {
      phase: "active",
      workflowRecreation: {
        oldCleanupRecordId,
        recovery: { freshSessionDisposition: "pending-quarantined" },
      },
    },
    errors: [{ remediation: expect.stringContaining("last known") }],
  });
};

const activateFreshSessionWithControlledFailure = (input: {
  readonly controller: PreviewSessionControllerApi;
  readonly events: Array<string>;
  readonly fail: boolean;
  readonly id: string;
  readonly generation: number;
  readonly supervisorIdentity: string;
  readonly activeRevision: string;
}) => {
  input.events.push("activate-fresh-session");
  if (input.fail)
    return Effect.fail(new PreviewSessionError({ reason: "controlled-fresh-activation-failure" }));
  return input.controller.activate(
    input.id,
    input.generation,
    input.supervisorIdentity,
    input.activeRevision,
  );
};

const assertFailedRecreationSessionState = (output: string) => {
  expect(parseJsonRecord(output)).toMatchObject({ previewSession: { phase: "ended" } });
};

const assertOldSessionBindingMismatchDiagnostic = (output: string) => {
  const result = parseJsonRecord(output);
  const previewSession = decodeJsonRecord(result.previewSession);
  expect(result.errors).toMatchObject([
    { remediation: expect.stringContaining("old-session-binding-mismatch") },
  ]);
  expect(previewSession.workflowTransitionPhases).toMatchObject({
    oldSessionEnd: "unconfirmed",
    cleanup: "unconfirmed",
  });
  expect(previewSession.oldCleanupRecordId).toBeUndefined();
};

const assertGenericOldCleanupFailureDiagnostic = (output: string) => {
  const result = parseJsonRecord(output);
  const previewSession = decodeJsonRecord(result.previewSession);
  expect(result.errors).toMatchObject([
    { remediation: expect.stringContaining("old-cleanup-record-unavailable") },
  ]);
  expect(output).not.toContain("controlled-provider-cleanup");
  expect(previewSession.oldCleanupRecordId).toBeUndefined();
  expect(previewSession.workflowTransitionPhases).toMatchObject({
    oldSessionEnd: "unconfirmed",
    cleanup: "unconfirmed",
  });
};

const assertOldSessionStopFailureDiagnostic = (output: string, cleanupRecordId: string) => {
  const result = parseJsonRecord(output);
  const previewSession = decodeJsonRecord(result.previewSession);
  expect(result.errors).toMatchObject([
    { remediation: expect.stringContaining("old-session-end-unconfirmed") },
  ]);
  expect(output).not.toContain("controlled-old-session-stop");
  expect(previewSession.oldCleanupRecordId).toBe(cleanupRecordId);
  expect(previewSession.workflowTransitionPhases).toMatchObject({
    oldSessionEnd: "unconfirmed",
    cleanup: "completed",
  });
};

const assertOldSessionStopFailureHumanDiagnostic = (output: string, cleanupRecordId: string) => {
  expect(output).toContain(`old cleanup record: ${cleanupRecordId}`);
};

type LifecycleBarrier = {
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
};

type ControlledProvisioningFailure =
  | "none"
  | "provider"
  | "sensitive-provider"
  | "binding"
  | "evidence"
  | "artifact-evidence";

const waitForLifecycleBarrier = (barrier: LifecycleBarrier) =>
  Effect.gen(function* () {
    yield* Deferred.succeed(barrier.started, undefined);
    yield* Deferred.await(barrier.release);
  });

const waitForOptionalLifecycleBarrier = (barrier: LifecycleBarrier | undefined) =>
  barrier === undefined ? Effect.void : waitForLifecycleBarrier(barrier);

const advanceLeaseFailureWindow = () =>
  Effect.gen(function* () {
    for (let failure = 0; failure < previewSessionHeartbeatFailureLimit; failure += 1) {
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
    }
  });

const failControlledProviderProvisioning = (failure: ControlledProvisioningFailure) => {
  if (failure === "none") return Effect.void;
  if (failure === "sensitive-provider")
    return Effect.fail(
      new WorkflowExecutionError({
        reason: "provider-token=canary-session-secret https://db.invalid/private",
      }),
    );
  return Effect.fail(new WorkflowExecutionError({ reason: "controlled-provider-failure" }));
};

const controlledPreviewLeaseHeartbeat = (input: {
  readonly controller: PreviewSessionControllerApi;
  readonly events: Array<string>;
  readonly fail: boolean;
  readonly freshSessionId: string | undefined;
  readonly id: string;
  readonly supervisorIdentity: string;
  readonly generation: number;
}) =>
  input.fail && input.id === input.freshSessionId
    ? Effect.fail(new PreviewSessionError({ reason: "controlled-fresh-lease-failure" })).pipe(
        Effect.tapError(() =>
          Effect.sync(() => void input.events.push("fresh-lease-heartbeat-failed")),
        ),
      )
    : input.controller
        .heartbeat(input.id, input.supervisorIdentity, input.generation)
        .pipe(Effect.tap(() => Effect.sync(() => void input.events.push("heartbeat"))));

const expectInterruptOnlyExit = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
};

type ScheduledPreviewSupervisor = {
  readonly sessionId: string;
  readonly supervisor: PreviewSupervisorEffect;
};

const assertRecreatedSessionRemainsSupervised = (input: {
  readonly scheduledSupervisors: ReadonlyArray<ScheduledPreviewSupervisor>;
  readonly expectedSessionId: string;
  readonly expectedCleanupRecordId: string;
  readonly controller: PreviewSessionControllerApi;
  readonly events: ReadonlyArray<string>;
  readonly setHeartbeatFailuresRemaining: (count: number) => void;
  readonly terminalControllerBehavior?: "stop-timeout" | "status-timeout";
  readonly configureTerminalControllerBehavior?: (
    behavior: "stop-timeout" | "status-timeout" | undefined,
  ) => void;
}) =>
  Effect.gen(function* () {
    const scheduled = input.scheduledSupervisors.at(-1);
    if (scheduled === undefined)
      throw new Error("expected successful recreation to schedule its session supervisor");
    expect(scheduled.sessionId).toBe(input.expectedSessionId);
    const renewalBeforeSupervisor = (yield* input.controller.status(scheduled.sessionId))
      .lastRenewedAt;
    input.setHeartbeatFailuresRemaining(1);
    const fiber = yield* scheduled.supervisor.pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(FetchHttpClient.layer),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    expect(input.events.filter((event) => event === "fresh-lease-heartbeat-failed")).toHaveLength(
      1,
    );
    input.setHeartbeatFailuresRemaining(0);
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    expect((yield* input.controller.status(scheduled.sessionId)).lastRenewedAt).toBeGreaterThan(
      renewalBeforeSupervisor,
    );

    const errorsBeforeTerminalFailure = yield* TestConsole.errorLines;
    input.configureTerminalControllerBehavior?.(input.terminalControllerBehavior);
    input.setHeartbeatFailuresRemaining(previewSessionHeartbeatFailureLimit);
    yield* advanceLeaseFailureWindow();
    if (input.terminalControllerBehavior !== undefined) {
      expect(
        input.events.includes(
          input.terminalControllerBehavior === "stop-timeout"
            ? "fresh-supervisor-stop-started"
            : "fresh-supervisor-status-started",
        ),
      ).toBe(true);
      yield* TestClock.adjust(Duration.seconds(59));
      yield* Effect.yieldNow;
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(Duration.seconds(1));
    }
    yield* Fiber.join(fiber);
    expect((yield* input.controller.status(scheduled.sessionId)).phase).toBe(
      input.terminalControllerBehavior === undefined ? "ended" : "active",
    );
    const errorsAfterTerminalFailure = yield* TestConsole.errorLines;
    expect(
      errorsAfterTerminalFailure
        .slice(errorsBeforeTerminalFailure.length)
        .some(
          (line) =>
            String(line).includes(
              "lease renewal failed after 3 consecutive heartbeat errors; activation was confirmed",
            ) &&
            String(line).includes(`old cleanup record ${input.expectedCleanupRecordId}`) &&
            (input.terminalControllerBehavior === undefined ||
              String(line).includes("controller end unconfirmed")),
        ),
    ).toBe(true);

    if (input.terminalControllerBehavior === undefined) {
      const errorsBeforeEndedSession = yield* TestConsole.errorLines;
      yield* scheduled.supervisor.pipe(
        Effect.provide(NodeServices.layer),
        Effect.provide(FetchHttpClient.layer),
        Effect.forkChild,
        Effect.flatMap(Fiber.join),
      );
      expect(yield* TestConsole.errorLines).toHaveLength(errorsBeforeEndedSession.length);
    }
    input.configureTerminalControllerBehavior?.(undefined);
  });

const assertFreshSessionActivationFailure = <
  Output,
  PrepareError,
  PrepareServices,
  RunError,
  RunServices,
>(input: {
  readonly prepareNextOldSession: () => Effect.Effect<void, PrepareError, PrepareServices>;
  readonly runShippedCli: (
    arguments_: ReadonlyArray<string>,
  ) => Effect.Effect<Output, RunError, RunServices>;
  readonly configPath: string;
  readonly sessionId: () => string;
  readonly setFailure: (enabled: boolean) => void;
}) =>
  Effect.gen(function* () {
    yield* input.prepareNextOldSession();
    input.setFailure(true);
    const output = yield* input
      .runShippedCli([
        "preview",
        "recreate",
        "--config",
        input.configPath,
        "--session",
        input.sessionId(),
        "--confirm-development",
        "--json",
      ])
      .pipe(Effect.ensuring(Effect.sync(() => input.setFailure(false))));
    expect(
      parseJsonRecord(
        requireCliOutput(output, "expected fresh-session activation failure JSON output"),
      ),
    ).toMatchObject({
      previewSession: {
        phase: "ended",
        workflowRecreation: { recovery: { freshSessionDisposition: "ended" } },
      },
    });
  });

type WorkflowRecreationScenario =
  | "provider-status"
  | "provider-module-outside-checkout"
  | "provider-non-effect"
  | "provider-malformed-runtime"
  | "stale-catalog-evidence"
  | "missing-change-declarations"
  | "missing-required-group-closure"
  | "unconfigured-proposed-group"
  | "role-missing-runner"
  | "role-duplicate-api"
  | "role-api-only"
  | "role-duplicate-browser"
  | "role-unsupported"
  | "compatible-transition"
  | "successful-recreation"
  | "legacy-api-only"
  | "old-cleanup-binding-mismatch"
  | "old-cleanup-provider-failure"
  | "old-cleanup-record-empty"
  | "old-cleanup-record-whitespace"
  | "old-session-stop-json"
  | "old-session-stop-human"
  | "old-session-stop-timeout"
  | "credential-persistence-failure"
  | "credential-persistence-expired"
  | "fresh-provider-failure"
  | "sensitive-provider-failure"
  | "fresh-binding-failure"
  | "fresh-evidence-failure"
  | "fresh-artifact-evidence-failure"
  | "provider-timeout"
  | "old-status-timeout"
  | "human-recovery-output"
  | "cached-state-fallback"
  | "activation-failure"
  | "same-snapshot-supervision"
  | "foreground-supervisor-stop-timeout"
  | "foreground-supervisor-status-timeout"
  | "interruption-safe-lifecycle"
  | "lease-failure-during-activation"
  | "lease-failure-during-staging"
  | "lease-failure-during-provisioning"
  | "fresh-stop-denied"
  | "fresh-stop-failed"
  | "fresh-stop-unreadable"
  | "fresh-stop-generation-rotated"
  | "old-session-generation-rotated-before-stop"
  | "old-code-cancellation"
  | "unresolved-ambiguous-outcome"
  | "expired-fresh-session-json"
  | "expired-fresh-session-human"
  | "expired-fresh-session-missing-end-time"
  | "expired-fresh-session-wrong-generation";

type UnconfirmedFreshStopMode = "denied" | "failed" | "unreadable" | "generation-rotated";

const unconfirmedFreshStopExpectations: Record<
  UnconfirmedFreshStopMode,
  {
    readonly quarantineFails: boolean;
    readonly stopFails: boolean;
    readonly rotatesGeneration: boolean;
    readonly statusUnreadable: boolean;
    readonly output: "json" | "human";
    readonly generationDelta: number;
    readonly phase: "ended" | "active" | "pending";
    readonly sessionDisposition: string;
    readonly groupDisposition: string;
    readonly stoppedEvent: boolean;
  }
> = {
  denied: {
    quarantineFails: true,
    stopFails: false,
    rotatesGeneration: false,
    statusUnreadable: false,
    output: "json",
    generationDelta: 0,
    phase: "ended",
    sessionDisposition: "ended",
    groupDisposition: "unconfirmed",
    stoppedEvent: true,
  },
  failed: {
    quarantineFails: false,
    stopFails: true,
    rotatesGeneration: false,
    statusUnreadable: false,
    output: "human",
    generationDelta: 0,
    phase: "active",
    sessionDisposition: "active",
    groupDisposition: "quarantined",
    stoppedEvent: true,
  },
  unreadable: {
    quarantineFails: false,
    stopFails: true,
    rotatesGeneration: false,
    statusUnreadable: true,
    output: "json",
    generationDelta: 0,
    phase: "active",
    sessionDisposition: "state-unverified",
    groupDisposition: "quarantined",
    stoppedEvent: false,
  },
  "generation-rotated": {
    quarantineFails: true,
    stopFails: false,
    rotatesGeneration: true,
    statusUnreadable: false,
    output: "json",
    generationDelta: 1,
    phase: "pending",
    sessionDisposition: "state-unverified",
    groupDisposition: "unconfirmed",
    stoppedEvent: false,
  },
};

const runConnectedWorkflowRecreationScenario = (scenario: WorkflowRecreationScenario) =>
  liveTestWithTestClock(`runs the public workflow recreation scenario: ${scenario}`, () =>
    withConnectedPreviewConfig(
      createConnectedPreviewConfig({
        roles: ["sheet-workflows-api", "sheet-workflows-runner"],
        groupOwnership: { auth: "reused" },
        configOverrides: { externalTargets: ["sheets:development-2026"] },
      }),
      (configPath, cwd) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
          let providerResolutionStarted: Deferred.Deferred<void> | undefined;
          const oldStatusReadStarted = yield* Deferred.make<void>();
          const oldStatusReadRelease = yield* Deferred.make<PreviewSession>();
          const oldStatusReadIsBlocked = { current: false };
          const sessionClockOffset = { current: 0 };
          const now = () => testClock.currentTimeMillisUnsafe() + sessionClockOffset.current;
          const originalConfig = Schema.decodeUnknownSync(connectedPreviewConfigSchema)(
            createConnectedPreviewConfig({
              roles: ["sheet-workflows-api", "sheet-workflows-runner"],
              groupOwnership: { auth: "reused" },
              configOverrides: { externalTargets: ["sheets:development-2026"] },
            }),
          );
          const proposedConfig = Schema.decodeUnknownSync(connectedPreviewConfigSchema)(
            createConnectedPreviewConfig({
              roles: [
                "sheet-workflows-api",
                "sheet-workflows-runner",
                "sheet-workflows-browser-runner",
              ],
              groupOwnership: { auth: "reused" },
              configOverrides: { externalTargets: ["sheets:development-2026"] },
            }),
          );
          const oldRevision = previewSourceRevision;
          const newRevision = "9".repeat(40);
          const nextApiDigest = "e".repeat(64);
          const nextRunnerDigest = "f".repeat(64);
          const nextBrowserRunnerDigest = "8".repeat(64);
          const proposedRoleDigests: Record<string, string> = {
            ...proposedConfig.identities.artifactDigests,
            "sheet-workflows-api": `sha256:${nextApiDigest}`,
            "sheet-workflows-runner": `sha256:${nextRunnerDigest}`,
            "sheet-workflows-browser-runner": `sha256:${nextBrowserRunnerDigest}`,
          };
          const config = {
            ...proposedConfig,
            identities: {
              ...proposedConfig.identities,
              sourceRevision: newRevision,
              artifactDigests: proposedRoleDigests,
            },
            changes: proposedConfig.changes.map((change) => {
              const artifactDigest = proposedRoleDigests[change.role];
              if (artifactDigest === undefined)
                throw new Error(`missing test artifact digest for ${change.role}`);
              return { ...change, sourceRevision: newRevision, artifactDigest };
            }),
          } satisfies ConnectedPreviewConfig;
          yield* fileSystem.writeFileString(configPath, JSON.stringify(config));
          const sessionDatabase = path.join(cwd, "controller.sqlite");
          const controller = yield* makePreviewSessionController(now);
          const oldArtifacts: WorkflowExecutionArtifacts = {
            api: "b".repeat(64),
            runner: "b".repeat(64),
            contracts: "c".repeat(64),
            deployment: "c".repeat(64),
            workflowVersion: "1.0.0",
            actionVersions: { "main-action": "1" },
          };
          const proposedArtifacts: WorkflowExecutionArtifacts = {
            ...oldArtifacts,
            api: nextApiDigest,
            runner: nextRunnerDigest,
            runnerArtifacts: {
              ordinary_runner: nextRunnerDigest,
              browser_runner: nextBrowserRunnerDigest,
            },
            workflowVersion: "2.0.0",
            actionVersions: { "main-action": "2" },
          };
          let activeProposedArtifacts = proposedArtifacts;
          const previousSnapshot = sealStagedSourceSnapshot(oldRevision, [
            {
              path: "package.json",
              contentEncoding: "utf8",
              content: '{"name":"workflow-preview"}',
              mode: 0o644,
            },
            {
              path: "pnpm-lock.yaml",
              contentEncoding: "utf8",
              content: "lockfileVersion: '9.0'",
              mode: 0o644,
            },
            {
              path: "packages/sheet-workflows/src/index.ts",
              contentEncoding: "utf8",
              content: "export const actionVersion = 1",
              mode: 0o644,
            },
          ]);
          const proposedSnapshot = sealStagedSourceSnapshot(newRevision, [
            ...previousSnapshot.files.slice(0, 2),
            {
              path: "packages/sheet-workflows/src/index.ts",
              contentEncoding: "utf8",
              content: "export const actionVersion = 2",
              mode: 0o644,
            },
          ]);
          let activeProposedSnapshot = proposedSnapshot;
          let activeProposedRevision = newRevision;
          const oldCredentials = yield* controller.create({
            owner: config.owner,
            checkout: process.cwd(),
            manifests: {
              ...originalConfig.identities.artifactDigests,
              "deployed-manifest": originalConfig.identities.deployedManifestDigest,
            },
            requestedRevision: oldRevision,
            groups: originalConfig.groups.map(({ id }) => id),
          });
          yield* controller.activate(
            oldCredentials.session.id,
            oldCredentials.session.generation,
            oldCredentials.supervisorIdentity,
            oldRevision,
          );
          const credentialsDirectory = `${sessionDatabase}.credentials`;
          yield* fileSystem.makeDirectory(credentialsDirectory, { recursive: true, mode: 0o700 });
          yield* fileSystem.writeFileString(
            path.join(credentialsDirectory, oldCredentials.session.id),
            JSON.stringify({
              ownerIdentity: oldCredentials.ownerIdentity,
              supervisorIdentity: oldCredentials.supervisorIdentity,
            }),
            { mode: 0o600 },
          );

          let activeOldCredentials = oldCredentials;
          let activationFailureReason: string | undefined;
          let freshSessionActivationFailure = false;
          let provisioningFailure: ControlledProvisioningFailure = "none";
          let lastFreshSessionId: string | undefined;
          let lastCreatedFreshCredentials: SessionCredentials | undefined;
          let failFreshLeaseHeartbeat = false;
          let freshLeaseHeartbeatFailuresRemaining = 0;
          const failFreshSessionStop = { current: false };
          const failFreshSessionStatusAfterStop = { current: false };
          const failedFreshSessionStop = { current: false };
          const hangFreshSessionStopSupervised = { current: false };
          const failFreshSessionStopSupervised = { current: false };
          const hangFreshSessionStatusAfterSupervisedStop = { current: false };
          let freshStopSupervisedStarted: Deferred.Deferred<void> | undefined;
          let freshStatusAfterSupervisedStopStarted: Deferred.Deferred<void> | undefined;
          const expireFreshSessionOnStop = { current: false };
          const rotateFreshSessionGenerationBeforeStop = { current: false };
          const rotateOldSessionGenerationBeforeStop = { current: false };
          const beforeProvisioningFailure: { current: () => void } = { current: () => {} };
          const freshStatusEvidenceOverride: {
            current: "wrong-generation" | "missing-end-time" | undefined;
          } = { current: undefined };
          let failFreshGroupQuarantine = false;
          const failOldGroupQuarantine = { current: false };
          const failOldReassignmentFence = { current: false };
          const mutateOldGroupDuringSettlement: {
            current: (oldGroup: WorkflowExecutionGroup) => void;
          } = { current: () => {} };
          const providerOldCleanup: {
            current: () => Effect.Effect<string, WorkflowExecutionError>;
          } = {
            current: () => Effect.succeed(`cleanup-${activeOldCredentials.session.id}`),
          };
          const stopOldSession: {
            current: (
              id: string,
              ownerIdentity: string,
              expectedGeneration?: number,
            ) => ReturnType<PreviewSessionControllerApi["stop"]>;
          } = {
            current: (id, ownerIdentity, expectedGeneration) =>
              controller.stop(id, ownerIdentity, expectedGeneration),
          };
          const getLastCreatedFreshCredentials = (): SessionCredentials | undefined =>
            lastCreatedFreshCredentials;
          const breakFreshCredentialPathAfterOldStop = { current: false };
          const failOldStatusReadAfterStop = { current: false };
          const hangOldStatusReadAfterStop = { current: false };
          const stoppedSessionIds = new Set<string>();
          const events: string[] = [];
          let oldWorkSettlementMode: "settled" | "cancelled" | "ambiguous" = "settled";
          type FreshLifecycleBarriers = {
            readonly provisioning: LifecycleBarrier;
            readonly staging: LifecycleBarrier;
            readonly activation: LifecycleBarrier;
          };
          let freshLifecycleBarriers: FreshLifecycleBarriers | undefined;
          const makeLifecycleBarrier = () =>
            Effect.gen(function* () {
              return {
                started: yield* Deferred.make<void>(),
                release: yield* Deferred.make<void>(),
              };
            });
          let activeOldGroup = workflowExecutionGroupIdentity({
            sessionId: oldCredentials.session.id,
            ownerToken: oldCredentials.ownerIdentity,
            generation: oldCredentials.session.generation,
            database: "workflow_old_db",
            apiEndpoint: "https://workflow-old.dev.test",
            observationEndpoint: "https://workflow-old.dev.test/observe",
            artifacts: oldArtifacts,
            workloadOAuthClientIds: {
              workflow_api: "old-api-client",
              ordinary_runner: "old-runner-client",
            },
          });
          const stagedRuntime: StagedRunnerRuntimeApi = {
            authorizeActivation: () => Effect.void,
            stageComplete: () => Effect.sync(() => void events.push("stage")),
            fenceOldOwner: () => Effect.sync(() => void events.push("fence-old-owner")),
            activateComplete: () =>
              activationFailureReason === undefined
                ? Effect.sync(() => void events.push("activate-snapshot"))
                : Effect.fail(new SnapshotRuntimeError({ reason: activationFailureReason })),
            retainImmutableRevision: () =>
              Effect.sync(() => void events.push("retain-old-revision")),
            rebuildArtifacts: () => Effect.void,
            restartRole: (role) => Effect.sync(() => void events.push(`restart:${role}`)),
            verifyActualReadiness: (_revision, roles) =>
              Effect.sync(() => {
                events.push(`readiness:${roles.join(",")}`);
                return true;
              }),
            resolveWorkflowArtifacts: () => Effect.succeed(activeProposedArtifacts),
            persistWorkflowRecreationDiagnostic: (diagnostic) =>
              Effect.sync(() => {
                expect(diagnostic.oldCleanupRecordId).toBe(
                  `cleanup-${activeOldCredentials.session.id}`,
                );
                events.push("persist-cleanup-link");
              }),
            workflowRecreation: {
              presentProposal: () => Effect.sync(() => void events.push("proposal")),
              pauseAdmission: () => Effect.sync(() => void events.push("pause-admission")),
              fenceProducers: ({ expectedBinding }) =>
                Effect.succeed(producerFenceEvidence(expectedBinding)),
              drainOldWork: ({ expectedBinding }) =>
                Effect.succeed(drainedOldWork(expectedBinding)),
              settleWithOldCode: ({ oldGroup, oldArtifacts: actual, expectedBinding }) =>
                Effect.sync(() => {
                  expect(actual).toEqual(oldArtifacts);
                  mutateOldGroupDuringSettlement.current(oldGroup);
                  events.push("settle-old-code");
                  if (oldWorkSettlementMode === "ambiguous")
                    return ambiguousOldWork(expectedBinding);
                  if (oldWorkSettlementMode === "cancelled")
                    return settledOldWork(expectedBinding, {
                      disposition: "settled",
                      drain: "completed",
                      cancellation: "completed",
                      reconciliation: "completed",
                    });
                  return settledOldWork(expectedBinding);
                }),
              proveOldCessation: ({ expectedBinding }) =>
                Effect.sync(() => {
                  events.push("prove-old-cessation");
                  return cessationEvidence(expectedBinding);
                }),
              endOldSessionAndCleanup: () =>
                Effect.sync(() => void events.push("provider-old-cleanup")).pipe(
                  Effect.flatMap(() => providerOldCleanup.current()),
                ),
              provisionFreshGroup: (input) =>
                Effect.gen(function* () {
                  lastFreshSessionId = input.freshSession?.sessionId;
                  yield* waitForOptionalLifecycleBarrier(freshLifecycleBarriers?.provisioning);
                  beforeProvisioningFailure.current();
                  yield* failControlledProviderProvisioning(provisioningFailure);
                  events.push("provision-fresh-group");
                  const group = workflowExecutionGroupIdentity({
                    sessionId: input.freshSession?.sessionId ?? "missing-session",
                    ownerToken: input.freshSession?.ownerToken ?? "missing-owner",
                    generation: input.freshSession?.generation ?? 0,
                    database: "workflow_fresh_db",
                    apiEndpoint: "https://workflow-fresh.dev.test",
                    observationEndpoint: "https://workflow-fresh.dev.test/observe",
                    artifacts: activeProposedArtifacts,
                    workloadOAuthClientIds: Object.fromEntries(
                      activation.proposed.workloadRoles.map((role) => [
                        role,
                        `fresh-${role}-client`,
                      ]),
                    ),
                  });
                  const evidence = {
                    group,
                    requiredGroups: input.requiredGroups,
                    workloadOAuthClientIds: group.workloadOAuthClientIds,
                    priorCleanupRecordId: `cleanup-${activeOldCredentials.session.id}`,
                    pendingCommands: 0,
                    browserQueueEntries: 0,
                    responseReferences: 0,
                  };
                  const evidenceByFailure = {
                    none: evidence,
                    provider: evidence,
                    "sensitive-provider": evidence,
                    binding: {
                      ...evidence,
                      group: { ...evidence.group, sessionId: "wrong-session" },
                    },
                    evidence: { ...evidence, requiredGroups: [] },
                    "artifact-evidence": {
                      ...evidence,
                      group: {
                        ...evidence.group,
                        artifacts: {
                          ...evidence.group.artifacts,
                          runnerArtifacts: { ordinary_runner: nextRunnerDigest },
                        },
                      },
                    },
                  } as const;
                  return evidenceByFailure[provisioningFailure];
                }),
              quarantine: () =>
                failOldGroupQuarantine.current
                  ? Effect.fail(new WorkflowExecutionError({ reason: "controlled-old-quarantine" }))
                  : Effect.void,
              blockOrdinaryReassignment: () =>
                failOldReassignmentFence.current
                  ? Effect.fail(
                      new WorkflowExecutionError({ reason: "controlled-reassignment-fence" }),
                    )
                  : Effect.succeed(true),
              quarantineFreshGroup: (quarantine) =>
                Effect.sync(() => {
                  events.push("quarantine-fresh-group");
                  expect(quarantine.freshSessionId).toBe(lastFreshSessionId);
                  expect(quarantine.freshGeneration).toBe(
                    lastCreatedFreshCredentials?.session.generation,
                  );
                  expect(quarantine.priorCleanupRecordId).toBe(
                    `cleanup-${activeOldCredentials.session.id}`,
                  );
                }).pipe(
                  Effect.flatMap(() =>
                    failFreshGroupQuarantine
                      ? Effect.fail(
                          new WorkflowExecutionError({ reason: "controlled-quarantine-failure" }),
                        )
                      : Effect.void,
                  ),
                ),
            },
          };
          class StagedRuntimePrototype {
            constructor(readonly events: Array<string>) {}

            stageComplete() {
              const events = this.events;
              return Effect.gen(function* () {
                events.push("stage");
                yield* waitForOptionalLifecycleBarrier(freshLifecycleBarriers?.staging);
              });
            }
          }
          Object.setPrototypeOf(stagedRuntime, new StagedRuntimePrototype(events));
          Reflect.deleteProperty(stagedRuntime, "stageComplete");
          const recreationRuntime = stagedRuntime.workflowRecreation;
          if (recreationRuntime === undefined) throw new Error("fixture runtime missing");
          class WorkflowRecreationPrototype {
            constructor(readonly events: Array<string>) {}

            presentProposal() {
              return Effect.sync(() => void this.events.push("proposal"));
            }
          }
          Object.setPrototypeOf(recreationRuntime, new WorkflowRecreationPrototype(events));
          Reflect.deleteProperty(recreationRuntime, "presentProposal");
          const freshSupervisorStatusHang = (
            id: string,
          ): ReturnType<PreviewSessionControllerApi["status"]> | undefined => {
            if (
              !hangFreshSessionStatusAfterSupervisedStop.current ||
              !failedFreshSessionStop.current ||
              id !== lastFreshSessionId
            )
              return undefined;
            return Effect.gen(function* () {
              const started = freshStatusAfterSupervisedStopStarted;
              events.push("fresh-supervisor-status-started");
              if (started !== undefined) yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            });
          };
          const oldSessionStatusHang = (
            id: string,
          ): ReturnType<PreviewSessionControllerApi["status"]> | undefined => {
            if (
              !hangOldStatusReadAfterStop.current ||
              !stoppedSessionIds.has(id) ||
              id !== activeOldCredentials.session.id
            )
              return undefined;
            return Effect.gen(function* () {
              oldStatusReadIsBlocked.current = true;
              yield* Deferred.succeed(oldStatusReadStarted, undefined);
              return yield* Deferred.await(oldStatusReadRelease);
            });
          };
          const unavailableFreshSessionStatus = (
            id: string,
          ): ReturnType<PreviewSessionControllerApi["status"]> | undefined => {
            if (
              !failFreshSessionStatusAfterStop.current ||
              !failedFreshSessionStop.current ||
              id !== lastFreshSessionId
            )
              return undefined;
            return Effect.fail(
              new PreviewSessionError({ reason: "controlled-fresh-status-unavailable" }),
            );
          };
          const statusEvidenceForController = (id: string) => {
            const status = sessionStatusWithControlledFailure({
              controller,
              id,
              failAfterOldStop: failOldStatusReadAfterStop,
              stoppedSessionIds,
              oldSessionId: activeOldCredentials.session.id,
            });
            if (id !== lastFreshSessionId || freshStatusEvidenceOverride.current === undefined)
              return status;
            return status.pipe(
              Effect.map((current) => {
                const override = freshStatusEvidenceOverride.current;
                freshStatusEvidenceOverride.current = undefined;
                if (override === "wrong-generation")
                  return { ...current, generation: current.generation + 1 };
                return { ...current, endedAt: null };
              }),
            );
          };
          const statusForLauncherController = (id: string) =>
            freshSupervisorStatusHang(id) ??
            oldSessionStatusHang(id) ??
            unavailableFreshSessionStatus(id) ??
            statusEvidenceForController(id);
          const launcherController: PreviewSessionControllerApi = {
            ...controller,
            status: statusForLauncherController,
            stopSupervised: (id, supervisorIdentity, generation) => {
              if (id === lastFreshSessionId && hangFreshSessionStopSupervised.current)
                return Effect.gen(function* () {
                  const started = freshStopSupervisedStarted;
                  events.push("fresh-supervisor-stop-started");
                  if (started !== undefined) yield* Deferred.succeed(started, undefined);
                  return yield* Effect.never;
                });
              if (id === lastFreshSessionId && failFreshSessionStopSupervised.current) {
                failedFreshSessionStop.current = true;
                return Effect.fail(
                  new PreviewSessionError({ reason: "controlled-fresh-stop-unavailable" }),
                );
              }
              return controller.stopSupervised(id, supervisorIdentity, generation);
            },
            create: (input) =>
              Effect.sync(() => void events.push("provision-fresh-session")).pipe(
                Effect.flatMap(() => controller.create(input)),
                Effect.tap((fresh) =>
                  Effect.sync(() => {
                    lastCreatedFreshCredentials = fresh;
                    lastFreshSessionId = fresh.session.id;
                  }),
                ),
              ),
            stop: (id, ownerIdentity, expectedGeneration) =>
              Effect.sync(() =>
                recordWorkflowRecreationStopForTest({
                  id,
                  oldSessionId: activeOldCredentials.session.id,
                  events,
                  breakCredentialPathAfterOldStop: breakFreshCredentialPathAfterOldStop,
                  environment: process.env,
                }),
              ).pipe(
                Effect.flatMap(() => {
                  if (id === lastFreshSessionId && rotateFreshSessionGenerationBeforeStop.current) {
                    rotateFreshSessionGenerationBeforeStop.current = false;
                    sessionClockOffset.current = Math.max(
                      sessionClockOffset.current,
                      previewSupervisorLeaseMs + 1,
                    );
                    return controller.resume(id, ownerIdentity).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          events.push("fresh-session-generation-rotated-before-stop");
                          sessionClockOffset.current = 0;
                        }),
                      ),
                      Effect.andThen(() =>
                        stopOldSession.current(id, ownerIdentity, expectedGeneration),
                      ),
                    );
                  }
                  if (
                    id === activeOldCredentials.session.id &&
                    rotateOldSessionGenerationBeforeStop.current
                  ) {
                    rotateOldSessionGenerationBeforeStop.current = false;
                    sessionClockOffset.current = previewSupervisorLeaseMs + 1;
                    return controller.resume(id, ownerIdentity).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          events.push("old-session-generation-rotated-before-stop");
                          sessionClockOffset.current = 0;
                        }),
                      ),
                      Effect.andThen(() =>
                        stopOldSession.current(id, ownerIdentity, expectedGeneration),
                      ),
                    );
                  }
                  if (id === lastFreshSessionId && expireFreshSessionOnStop.current) {
                    expireFreshSessionOnStop.current = false;
                    sessionClockOffset.current = previewSessionLeaseMs + 1;
                  }
                  if (id === lastFreshSessionId && failFreshSessionStop.current) {
                    failedFreshSessionStop.current = true;
                    return Effect.fail(
                      new PreviewSessionError({ reason: "controlled-fresh-stop-unavailable" }),
                    );
                  }
                  return stopOldSession.current(id, ownerIdentity, expectedGeneration);
                }),
                Effect.tap(() => Effect.sync(() => void stoppedSessionIds.add(id))),
              ),
            heartbeat: (id, supervisorIdentity, generation) =>
              Effect.suspend(() => {
                const fail =
                  failFreshLeaseHeartbeat ||
                  (id === lastFreshSessionId && freshLeaseHeartbeatFailuresRemaining > 0);
                if (!failFreshLeaseHeartbeat && id === lastFreshSessionId)
                  freshLeaseHeartbeatFailuresRemaining = Math.max(
                    0,
                    freshLeaseHeartbeatFailuresRemaining - 1,
                  );
                return controlledPreviewLeaseHeartbeat({
                  controller,
                  events,
                  fail,
                  freshSessionId: lastFreshSessionId,
                  id,
                  supervisorIdentity,
                  generation,
                });
              }),
            activate: (id, generation, supervisorIdentity, activeRevision) =>
              Effect.gen(function* () {
                yield* waitForOptionalLifecycleBarrier(freshLifecycleBarriers?.activation);
                return yield* activateFreshSessionWithControlledFailure({
                  controller,
                  events,
                  fail: freshSessionActivationFailure,
                  id,
                  generation,
                  supervisorIdentity,
                  activeRevision,
                });
              }),
          };
          let activation = {
            oldGroup: activeOldGroup,
            previous: {
              sourceRevision: oldRevision,
              artifacts: oldArtifacts,
              requiredGroups: ["workflow-execution"],
              workloadRoles: ["workflow_api", "ordinary_runner"],
              compatibility: {
                catalogVersion: 1,
                catalogDigest: workflowPreviewRuntimeContractCatalogIdentity.digest,
                declarations: [],
              },
            },
            previousSnapshot,
            proposed: {
              sourceRevision: activeProposedRevision,
              artifacts: activeProposedArtifacts,
              requiredGroups: ["workflow-execution"],
              workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
              compatibility: {
                catalogVersion: 1,
                catalogDigest: workflowPreviewRuntimeContractCatalogIdentity.digest,
                declarations: [],
              },
            },
            snapshot: activeProposedSnapshot,
            owner: activeOldCredentials.ownerIdentity,
            nextOwner: "fresh-workflow-owner",
            roles: ["workflow-api", "ordinary-runner", "browser-runner"] as const,
            runtime: stagedRuntime,
          };
          let providerResolution: (requestedConfig: ConnectedPreviewConfig) => unknown = () =>
            Effect.succeed(activation);
          let bindProviderCompatibilityEvidence = true;
          const bindTestDefinitionEvidence = (
            definition: typeof activation.previous,
            sourceConfig: ConnectedPreviewConfig,
          ) => ({
            ...definition,
            compatibility: {
              catalogVersion: sourceConfig.identities.catalogVersion,
              catalogDigest: workflowPreviewRuntimeContractCatalogIdentity.digest,
              declarations: sourceConfig.changes.map((change) => ({
                role: change.role,
                contract: change.contract ?? null,
                classification: change.classification,
                sourceRevision: definition.sourceRevision,
                artifactDigest: (change.artifactDigest ?? "").replace(/^sha256:/, ""),
                deployedManifestDigest: change.deployedManifestDigest.replace(/^sha256:/, ""),
                catalogVersion: change.catalogVersion,
              })),
            },
          });
          const bindTestActivationEvidence = (
            resolved: typeof activation,
            requestedConfig: ConnectedPreviewConfig,
          ) => ({
            ...resolved,
            previous: bindTestDefinitionEvidence(resolved.previous, originalConfig),
            proposed: bindTestDefinitionEvidence(resolved.proposed, requestedConfig),
          });
          const activationResolutionFor =
            (resolved: typeof activation) => (requestedConfig: ConnectedPreviewConfig) =>
              Effect.succeed(
                bindProviderCompatibilityEvidence
                  ? bindTestActivationEvidence(resolved, requestedConfig)
                  : resolved,
              );
          providerResolution = activationResolutionFor(activation);
          const suppliedCompatibilityMismatch = {
            catalogVersion: config.identities.catalogVersion,
            catalogDigest: `sha256:${"0".repeat(64)}` as const,
            declarations: [],
          };
          const provider: Extract<
            ConnectedWorkflowPreviewProviderApi,
            { readonly _tag: "Configured" }
          > = {
            _tag: "Configured",
            resolveActivation: ({ session, config: requestedConfig }) => {
              expect(session.id).toBe(activeOldCredentials.session.id);
              const resolution = providerResolution(requestedConfig);
              const started = providerResolutionStarted;
              return started === undefined || !Effect.isEffect(resolution)
                ? resolution
                : Deferred.succeed(started, undefined).pipe(Effect.andThen(resolution));
            },
          };
          const runConnectedRecreation = (
            arguments_: ReadonlyArray<string>,
            clock: Clock.Clock = testClock,
          ) =>
            connectedPreviewOutput(
              parsePreviewAction(arguments_, "recreate"),
              composeWorkflowPreviewLauncherOptions(
                {
                  cwd: process.cwd(),
                  env: process.env,
                  clock,
                  previewSupervisorScheduler: (sessionId, supervisor) => {
                    scheduledSupervisors.push({ sessionId, supervisor });
                  },
                },
                {
                  provider,
                  sessionController: launcherController,
                  fileSystem,
                  previewSupervisorScheduler: (sessionId, supervisor) => {
                    scheduledSupervisors.push({ sessionId, supervisor });
                  },
                  clock,
                  environment: process.env,
                },
              ),
            );
          const moduleSuffix = randomUUID();
          const providerModuleName = `.workflow-preview-cli-provider-${moduleSuffix}.mjs`;
          const providerModulePath = path.join(process.cwd(), providerModuleName);
          const moduleMarkerPath = path.join(
            process.cwd(),
            `.workflow-preview-module-${moduleSuffix}`,
          );
          const factoryMarkerPath = path.join(
            process.cwd(),
            `.workflow-preview-factory-${moduleSuffix}`,
          );
          const resolverMarkerPath = path.join(
            process.cwd(),
            `.workflow-preview-resolver-${moduleSuffix}`,
          );
          const providerGlobalKey = `__tiaraWorkflowPreviewProvider_${moduleSuffix}`;
          const scheduledSupervisors: Array<ScheduledPreviewSupervisor> = [];
          const originalProviderModule = process.env.TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE;
          const originalSessionDatabase = process.env.TIARA_PREVIEW_SESSION_DATABASE;
          const providerModule = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(moduleMarkerPath)}, "imported");
export const makeWorkflowPreviewProvider = () => {
  writeFileSync(${JSON.stringify(factoryMarkerPath)}, "initialized");
  const provider = globalThis[${JSON.stringify(providerGlobalKey)}];
  return { resolveActivation: (input) => {
    writeFileSync(${JSON.stringify(resolverMarkerPath)}, input.session.id);
    return provider.resolveActivation(input);
  } };
};
`;
          yield* fileSystem.writeFileString(providerModulePath, providerModule);
          const cleanupProviderFixture = Effect.gen(function* () {
            yield* Effect.sync(() => {
              if (originalProviderModule === undefined)
                delete process.env.TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE;
              else process.env.TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE = originalProviderModule;
              if (originalSessionDatabase === undefined)
                delete process.env.TIARA_PREVIEW_SESSION_DATABASE;
              else process.env.TIARA_PREVIEW_SESSION_DATABASE = originalSessionDatabase;
              Reflect.deleteProperty(globalThis, providerGlobalKey);
            });
            yield* fileSystem.remove(providerModulePath, { force: true }).pipe(Effect.ignore);
            yield* fileSystem.remove(moduleMarkerPath, { force: true }).pipe(Effect.ignore);
            yield* fileSystem.remove(factoryMarkerPath, { force: true }).pipe(Effect.ignore);
            yield* fileSystem.remove(resolverMarkerPath, { force: true }).pipe(Effect.ignore);
          });
          Reflect.set(globalThis, providerGlobalKey, provider);
          process.env.TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE = providerModuleName;
          process.env.TIARA_PREVIEW_SESSION_DATABASE = sessionDatabase;
          yield* Effect.gen(function* () {
            const runShippedCli = (arguments_: readonly string[]) => {
              const providerLayer = workflowPreviewProviderLayerForArguments(arguments_, {
                checkout: process.cwd(),
                environment: process.env,
              });
              return Effect.gen(function* () {
                yield* Command.runWith(command, { version: "0.0.0" })(arguments_);
                return (yield* TestConsole.logLines).at(-1);
              }).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    providerLayer,
                    Layer.succeed(PreviewSessionController, launcherController),
                    Layer.succeed(PreviewSupervisorSchedulerService, (sessionId, supervisor) => {
                      scheduledSupervisors.push({ sessionId, supervisor });
                    }),
                    TestConsole.layer,
                  ),
                ),
              );
            };
            const prepareNextOldSession = Effect.gen(function* () {
              activeOldCredentials = yield* controller.create({
                owner: config.owner,
                checkout: process.cwd(),
                manifests: {
                  ...originalConfig.identities.artifactDigests,
                  "deployed-manifest": originalConfig.identities.deployedManifestDigest,
                },
                requestedRevision: oldRevision,
                groups: originalConfig.groups.map(({ id }) => id),
              });
              yield* controller.activate(
                activeOldCredentials.session.id,
                activeOldCredentials.session.generation,
                activeOldCredentials.supervisorIdentity,
                oldRevision,
              );
              yield* fileSystem.writeFileString(
                path.join(credentialsDirectory, activeOldCredentials.session.id),
                JSON.stringify({
                  ownerIdentity: activeOldCredentials.ownerIdentity,
                  supervisorIdentity: activeOldCredentials.supervisorIdentity,
                }),
                { mode: 0o600 },
              );
              activeOldGroup = workflowExecutionGroupIdentity({
                sessionId: activeOldCredentials.session.id,
                ownerToken: activeOldCredentials.ownerIdentity,
                generation: activeOldCredentials.session.generation,
                database: `workflow_old_${randomUUID().replaceAll("-", "_")}`,
                apiEndpoint: "https://workflow-old.dev.test",
                observationEndpoint: "https://workflow-old.dev.test/observe",
                artifacts: oldArtifacts,
                workloadOAuthClientIds: {
                  workflow_api: `old-api-${randomUUID()}`,
                  ordinary_runner: `old-runner-${randomUUID()}`,
                },
              });
              activation = {
                ...activation,
                oldGroup: activeOldGroup,
                previous: {
                  ...activation.previous,
                  sourceRevision: oldRevision,
                  artifacts: oldArtifacts,
                  workloadRoles: ["workflow_api", "ordinary_runner"],
                },
                proposed: {
                  ...activation.proposed,
                  sourceRevision: activeProposedRevision,
                  artifacts: activeProposedArtifacts,
                  workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
                },
                previousSnapshot,
                snapshot: activeProposedSnapshot,
                roles: ["workflow-api", "ordinary-runner", "browser-runner"],
                owner: activeOldCredentials.ownerIdentity,
              };
              events.length = 0;
              activeProposedArtifacts = proposedArtifacts;
              activeProposedSnapshot = proposedSnapshot;
              activeProposedRevision = newRevision;
              provisioningFailure = "none";
              activationFailureReason = undefined;
              lastFreshSessionId = undefined;
              providerResolution = activationResolutionFor(activation);
            });

            const prepareNewRevisionTransition = Effect.gen(function* () {
              yield* prepareNextOldSession;
              yield* fileSystem.writeFileString(configPath, JSON.stringify(config));
              activeProposedArtifacts = proposedArtifacts;
              activeProposedRevision = newRevision;
              activeProposedSnapshot = proposedSnapshot;
              activation = {
                ...activation,
                oldGroup: activeOldGroup,
                previous: {
                  ...activation.previous,
                  sourceRevision: oldRevision,
                  artifacts: oldArtifacts,
                  workloadRoles: ["workflow_api", "ordinary_runner"],
                },
                proposed: {
                  ...activation.proposed,
                  sourceRevision: newRevision,
                  artifacts: proposedArtifacts,
                  workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
                },
                previousSnapshot,
                snapshot: proposedSnapshot,
                roles: ["workflow-api", "ordinary-runner", "browser-runner"],
                owner: activeOldCredentials.ownerIdentity,
              };
              providerResolution = activationResolutionFor(activation);
            });

            const assertMissingOldCleanupRecordDoesNotStopSession = (cleanupRecordId: string) =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                providerOldCleanup.current = () => Effect.succeed(cleanupRecordId);
                const output = yield* runShippedCli([
                  "preview",
                  "recreate",
                  "--config",
                  configPath,
                  "--session",
                  activeOldCredentials.session.id,
                  "--confirm-development",
                  "--json",
                ]).pipe(
                  Effect.ensuring(
                    Effect.sync(
                      () =>
                        (providerOldCleanup.current = () =>
                          Effect.succeed(`cleanup-${activeOldCredentials.session.id}`)),
                    ),
                  ),
                );
                assertGenericOldCleanupFailureDiagnostic(String(output));
                expect(events).toContain("provider-old-cleanup");
                expect(events).not.toContain("end-old-session");
                expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                  "active",
                );
                yield* controller.stop(
                  activeOldCredentials.session.id,
                  activeOldCredentials.ownerIdentity,
                );
              });

            const runFailedRecreation = (
              mode:
                | "provider"
                | "sensitive-provider"
                | "binding"
                | "evidence"
                | "artifact-evidence",
            ) =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                provisioningFailure = mode;
                const output = yield* runShippedCli([
                  "preview",
                  "recreate",
                  "--config",
                  configPath,
                  "--session",
                  activeOldCredentials.session.id,
                  "--confirm-development",
                  "--json",
                ]);
                expect(output).toContain('"ok":false');
                assertFailedRecreationSessionState(
                  requireCliOutput(output, "expected failed recreation JSON output"),
                );
                expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                  "ended",
                );
                expect(lastFreshSessionId).toBeDefined();
                if (lastFreshSessionId === undefined) return;
                const recoveryPath = path.join(
                  credentialsDirectory,
                  `${lastFreshSessionId}.workflow-recreation-recovery.json`,
                );
                const recoveryRecord = parseWorkflowRecreationRecoveryRecord(
                  yield* fileSystem.readFileString(recoveryPath),
                );
                expect(recoveryRecord.oldCleanupRecordId).toBe(
                  `cleanup-${activeOldCredentials.session.id}`,
                );
                expect(recoveryRecord.recovery.freshSessionDisposition).toBe("pending-quarantined");
                expect(recoveryRecord.recovery.recoveryRecordUpdated).toBe(true);
                if (mode === "sensitive-provider") {
                  const outputText = requireCliOutput(
                    output,
                    "expected sensitive-provider failure JSON output",
                  );
                  const recoveryText = JSON.stringify(recoveryRecord);
                  expect(outputText).not.toContain("canary-session-secret");
                  expect(outputText).not.toContain("db.invalid");
                  expect(recoveryText).not.toContain("canary-session-secret");
                  expect(recoveryText).not.toContain("db.invalid");
                  expect(recoveryRecord.recovery.failureReason).toContain(
                    "fresh-group-provisioning-unverified",
                  );
                }
                expect((yield* controller.status(lastFreshSessionId)).phase).toBe("pending");
              });

            const runExpiredFreshSessionProvisioningFailure = (
              jsonOutput: boolean,
              evidenceOverride: "valid" | "missing-end-time" | "wrong-generation" = "valid",
            ) =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                provisioningFailure = "provider";
                beforeProvisioningFailure.current = () => {
                  sessionClockOffset.current = previewSessionLeaseMs + 1;
                };
                freshStatusEvidenceOverride.current =
                  evidenceOverride === "valid" ? undefined : evidenceOverride;
                sessionClockOffset.current = 0;
                lastFreshSessionId = undefined;
                const output = yield* runShippedCli([
                  "preview",
                  "recreate",
                  "--config",
                  configPath,
                  "--session",
                  activeOldCredentials.session.id,
                  "--confirm-development",
                  ...(jsonOutput ? ["--json"] : []),
                ]).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      provisioningFailure = "none";
                      beforeProvisioningFailure.current = () => {};
                      freshStatusEvidenceOverride.current = undefined;
                      sessionClockOffset.current = 0;
                    }),
                  ),
                );
                const freshSessionId = requireSessionId(lastFreshSessionId);
                const current = yield* controller.status(freshSessionId);
                expect(current.phase).toBe("expired");
                expect(current.endedAt).not.toBeNull();
                expect(events).not.toContain("activate-fresh-session");
                expect(events).not.toContain("activate-snapshot");
                const recoveryRecord = parseWorkflowRecreationRecoveryRecord(
                  yield* fileSystem.readFileString(
                    path.join(
                      credentialsDirectory,
                      `${freshSessionId}.workflow-recreation-recovery.json`,
                    ),
                  ),
                );
                expect(recoveryRecord.oldCleanupRecordId).toBe(
                  `cleanup-${activeOldCredentials.session.id}`,
                );
                const expectedDisposition =
                  evidenceOverride === "valid" ? "expired" : "state-unverified";
                expect(recoveryRecord.recovery.freshSessionDisposition).toBe(expectedDisposition);
                if (jsonOutput) {
                  expect(String(output)).toContain(
                    `"freshSessionDisposition":"${expectedDisposition}"`,
                  );
                } else {
                  expect(String(output)).toContain(
                    `fresh session disposition: ${expectedDisposition}`,
                  );
                }
              });

            const runCredentialPersistenceFailure = (expireFreshSession: boolean) =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                lastCreatedFreshCredentials = undefined;
                breakFreshCredentialPathAfterOldStop.current = true;
                expireFreshSessionOnStop.current = expireFreshSession;
                sessionClockOffset.current = 0;
                const output = yield* runShippedCli([
                  "preview",
                  "recreate",
                  "--config",
                  configPath,
                  "--session",
                  activeOldCredentials.session.id,
                  "--confirm-development",
                  "--json",
                ]).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      process.env.TIARA_PREVIEW_SESSION_DATABASE = sessionDatabase;
                      breakFreshCredentialPathAfterOldStop.current = false;
                      expireFreshSessionOnStop.current = false;
                      sessionClockOffset.current = 0;
                    }),
                  ),
                );
                expect(typeof output).toBe("string");
                expect(String(output)).toContain("fresh-session-credentials-path-unavailable");
                expect(getLastCreatedFreshCredentials()).toBeDefined();
                expect(events).toContain("stop-fresh-session");
                expect(events).not.toContain("provision-fresh-group");
                const freshCredentials = requireSessionCredentials(
                  getLastCreatedFreshCredentials(),
                );
                const expectedDisposition = expireFreshSession ? "expired" : "ended";
                const recoveredFreshSession = yield* controller.status(freshCredentials.session.id);
                expect(recoveredFreshSession.phase).toBe(expectedDisposition);
                expect(
                  recoveredFreshSession.manifests["workflow-recreation-prior-cleanup-record"],
                ).toBe(`cleanup-${activeOldCredentials.session.id}`);
                expect(parseJsonRecord(String(output))).toMatchObject({
                  previewSession: {
                    phase: "ended",
                    workflowRecreation: {
                      oldCleanupRecordId: `cleanup-${activeOldCredentials.session.id}`,
                      freshSessionId: freshCredentials.session.id,
                      recovery: {
                        freshSessionDisposition: expectedDisposition,
                        recoveryRecordWritten: false,
                      },
                    },
                  },
                });
              });

            const runProviderActivationTimeoutRegression = () =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                events.length = 0;
                const providerStarted = yield* Deferred.make<void>();
                const releaseProvider = yield* Deferred.make<void>();
                const providerTimeoutStarted = yield* Deferred.make<void>();
                const releaseProviderTimeout = yield* Deferred.make<void>();
                const providerTimeoutClock: Clock.Clock = {
                  ...testClock,
                  sleep: (duration) =>
                    Duration.toMillis(duration) === 60_000
                      ? Deferred.succeed(providerTimeoutStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseProviderTimeout)),
                        )
                      : testClock.sleep(duration),
                };
                providerResolutionStarted = providerStarted;
                providerResolution = () =>
                  Deferred.await(releaseProvider).pipe(
                    Effect.andThen(Effect.fail(new Error("controlled provider release"))),
                  );
                const fiber = yield* runConnectedRecreation(
                  [
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ],
                  providerTimeoutClock,
                ).pipe(Effect.forkChild);
                yield* Deferred.await(providerStarted);
                yield* Deferred.await(providerTimeoutStarted);
                yield* Deferred.succeed(releaseProviderTimeout, undefined);
                let timeoutExit = fiber.pollUnsafe();
                for (let attempt = 0; attempt < 20 && timeoutExit === undefined; attempt++) {
                  yield* Effect.yieldNow;
                  timeoutExit = fiber.pollUnsafe();
                }
                if (timeoutExit === undefined) yield* Deferred.succeed(releaseProvider, undefined);
                const output = yield* Fiber.join(fiber);
                providerResolutionStarted = undefined;
                providerResolution = activationResolutionFor(activation);
                expect(timeoutExit).not.toBeUndefined();
                expect(JSON.stringify(output)).toContain(
                  "Authoritative old-group state and a complete staged snapshot could not be resolved.",
                );
                expect(events).not.toContain("settle-old-code");
                expect(events).not.toContain("provision-fresh-session");
                expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                  "active",
                );
                yield* controller.stop(
                  activeOldCredentials.session.id,
                  activeOldCredentials.ownerIdentity,
                );
              });

            const runOldSessionStopTimeoutRegression = () =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                events.length = 0;
                const stopStarted = yield* Deferred.make<void>();
                const timeoutSleepStarted = yield* Deferred.make<void>();
                const releaseTimeout = yield* Deferred.make<void>();
                stopOldSession.current = (id, ownerIdentity, expectedGeneration) =>
                  id === activeOldCredentials.session.id
                    ? Deferred.succeed(stopStarted, undefined).pipe(Effect.andThen(Effect.never))
                    : controller.stop(id, ownerIdentity, expectedGeneration);
                const timeoutClock: Clock.Clock = {
                  ...testClock,
                  sleep: (duration) =>
                    Duration.toMillis(duration) === 60_000
                      ? Deferred.await(stopStarted).pipe(
                          Effect.andThen(Deferred.succeed(timeoutSleepStarted, undefined)),
                          Effect.andThen(Deferred.await(releaseTimeout)),
                        )
                      : testClock.sleep(duration),
                };
                const fiber = yield* runConnectedRecreation(
                  [
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ],
                  timeoutClock,
                ).pipe(Effect.forkChild);
                yield* Deferred.await(stopStarted);
                yield* Deferred.await(timeoutSleepStarted);
                yield* Deferred.succeed(releaseTimeout, undefined);
                let timeoutExit = fiber.pollUnsafe();
                for (let attempt = 0; attempt < 20 && timeoutExit === undefined; attempt++) {
                  yield* Effect.yieldNow;
                  timeoutExit = fiber.pollUnsafe();
                }
                if (timeoutExit === undefined)
                  throw new Error(
                    "local old-session stop timeout did not complete after releasing the timeout clock",
                  );
                const output = yield* Fiber.join(fiber).pipe(
                  Effect.ensuring(
                    Effect.sync(
                      () =>
                        (stopOldSession.current = (id, ownerIdentity, expectedGeneration) =>
                          controller.stop(id, ownerIdentity, expectedGeneration)),
                    ),
                  ),
                );
                const cleanupRecordId = `cleanup-${activeOldCredentials.session.id}`;
                assertOldSessionStopFailureDiagnostic(JSON.stringify(output), cleanupRecordId);
                expect(events).toContain("provider-old-cleanup");
                expect(events).toContain("end-old-session");
                expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                  "active",
                );
                yield* controller.stop(
                  activeOldCredentials.session.id,
                  activeOldCredentials.ownerIdentity,
                );
              });

            const runOldStatusTimeoutRegression = () =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                provisioningFailure = "provider";
                oldStatusReadIsBlocked.current = false;
                hangOldStatusReadAfterStop.current = true;
                const timeoutStarted = yield* Deferred.make<void>();
                const releaseTimeout = yield* Deferred.make<void>();
                const timeoutClock: Clock.Clock = {
                  ...testClock,
                  sleep: (duration) =>
                    Duration.toMillis(duration) === 60_000
                      ? Deferred.succeed(timeoutStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseTimeout)),
                        )
                      : testClock.sleep(duration),
                };
                const fiber = yield* runConnectedRecreation(
                  [
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ],
                  timeoutClock,
                ).pipe(Effect.forkChild);
                yield* Deferred.await(oldStatusReadStarted);
                yield* Deferred.await(timeoutStarted);
                yield* Deferred.succeed(releaseTimeout, undefined);
                let timeoutExit = fiber.pollUnsafe();
                for (let attempt = 0; attempt < 20 && timeoutExit === undefined; attempt++) {
                  yield* Effect.yieldNow;
                  timeoutExit = fiber.pollUnsafe();
                }
                hangOldStatusReadAfterStop.current = false;
                yield* Deferred.succeed(
                  oldStatusReadRelease,
                  yield* controller.status(activeOldCredentials.session.id),
                );
                const output = yield* Fiber.join(fiber);
                expect(oldStatusReadIsBlocked.current).toBe(true);
                expect(timeoutExit).not.toBeUndefined();
                assertCachedOldSessionFallback(
                  JSON.stringify(output),
                  `cleanup-${activeOldCredentials.session.id}`,
                );
                expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                  "ended",
                );
                expect((yield* controller.status(requireSessionId(lastFreshSessionId))).phase).toBe(
                  "pending",
                );
              });

            const runUnconfirmedFreshSessionStop = (mode: UnconfirmedFreshStopMode) =>
              Effect.gen(function* () {
                const expected = unconfirmedFreshStopExpectations[mode];
                yield* prepareNewRevisionTransition;
                events.length = 0;
                const barriers = {
                  provisioning: yield* makeLifecycleBarrier(),
                  staging: yield* makeLifecycleBarrier(),
                  activation: yield* makeLifecycleBarrier(),
                };
                freshLifecycleBarriers = barriers;
                failFreshLeaseHeartbeat = true;
                failFreshGroupQuarantine = expected.quarantineFails;
                failFreshSessionStop.current = expected.stopFails;
                rotateFreshSessionGenerationBeforeStop.current = expected.rotatesGeneration;
                failedFreshSessionStop.current = false;
                failFreshSessionStatusAfterStop.current = expected.statusUnreadable;
                const lifecycle = yield* runShippedCli([
                  "preview",
                  "recreate",
                  "--config",
                  configPath,
                  "--session",
                  activeOldCredentials.session.id,
                  "--confirm-development",
                  ...(expected.output === "json" ? ["--json"] : []),
                ]).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      failFreshLeaseHeartbeat = false;
                      failFreshGroupQuarantine = false;
                      failFreshSessionStop.current = false;
                      rotateFreshSessionGenerationBeforeStop.current = false;
                      failFreshSessionStatusAfterStop.current = false;
                      failedFreshSessionStop.current = false;
                      sessionClockOffset.current = 0;
                      freshLifecycleBarriers = undefined;
                    }),
                  ),
                  Effect.forkChild,
                );
                yield* Deferred.await(barriers.provisioning.started);
                yield* Deferred.succeed(barriers.provisioning.release, undefined);
                yield* Deferred.await(barriers.staging.started);
                yield* Deferred.succeed(barriers.staging.release, undefined);
                yield* Deferred.await(barriers.activation.started);
                yield* advanceLeaseFailureWindow();
                yield* Deferred.succeed(barriers.activation.release, undefined);
                const output = requireCliOutput(
                  yield* Fiber.join(lifecycle),
                  "expected fresh-session stop recovery output",
                );
                const sessionId = requireSessionId(lastFreshSessionId);
                const record = parseWorkflowRecreationRecoveryRecord(
                  yield* fileSystem.readFileString(
                    path.join(
                      credentialsDirectory,
                      `${sessionId}.workflow-recreation-recovery.json`,
                    ),
                  ),
                );
                const current = yield* controller.status(sessionId);
                const createdFresh = requireSessionCredentials(lastCreatedFreshCredentials);
                expect(current.generation).toBe(
                  createdFresh.session.generation + expected.generationDelta,
                );
                expect(current.phase).toBe(expected.phase);
                if (expected.rotatesGeneration) expect(current.endedAt).toBeNull();
                expect(record.recovery).toMatchObject({
                  freshSessionDisposition: expected.sessionDisposition,
                  freshGroupQuarantineDisposition: expected.groupDisposition,
                });
                const sessionDispositionOutput =
                  expected.output === "json"
                    ? `"freshSessionDisposition":"${expected.sessionDisposition}"`
                    : `fresh session disposition: ${expected.sessionDisposition}`;
                const groupDispositionOutput =
                  expected.output === "json"
                    ? `"freshGroupQuarantineDisposition":"${expected.groupDisposition}"`
                    : `fresh group quarantine disposition: ${expected.groupDisposition}`;
                expect(output).toContain(sessionDispositionOutput);
                expect(output).toContain(groupDispositionOutput);
                if (expected.stoppedEvent) expect(events).toContain("stop-fresh-session");
                if (expected.rotatesGeneration)
                  expect(events).toContain("fresh-session-generation-rotated-before-stop");
              });
            const runActivationFailurePrivacyRegression = () =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                const activationFailureCanary =
                  "token=activation-token-canary https://runtime.invalid/password=activation-password-canary";
                activationFailureReason = activationFailureCanary;
                const activationFailureOutput = yield* runShippedCli([
                  "preview",
                  "recreate",
                  "--config",
                  configPath,
                  "--session",
                  activeOldCredentials.session.id,
                  "--confirm-development",
                  "--json",
                ]);
                expect(activationFailureOutput).toContain('"ok":false');
                expect(activationFailureOutput).toContain("workflow-activation-failure-unverified");
                expect(activationFailureOutput).not.toContain(activationFailureCanary);
                expect(activationFailureOutput).not.toContain("activation-token-canary");
                expect(activationFailureOutput).not.toContain("activation-password-canary");
                expect(activationFailureOutput).not.toContain("runtime.invalid");
                const activationFailureResult = parseJsonRecord(
                  requireCliOutput(
                    activationFailureOutput,
                    "expected activation failure JSON output",
                  ),
                );
                expect(activationFailureResult).toMatchObject({
                  previewSession: {
                    phase: "ended",
                    workflowRecreation: {
                      recovery: {
                        freshSessionDisposition: "ended",
                        recoveryRecordUpdated: false,
                      },
                    },
                  },
                });
                expect(lastFreshSessionId).toBeDefined();
                if (lastFreshSessionId !== undefined) {
                  const recoveryRecord = parseWorkflowRecreationRecoveryRecord(
                    yield* fileSystem.readFileString(
                      path.join(
                        credentialsDirectory,
                        `${lastFreshSessionId}.workflow-recreation-recovery.json`,
                      ),
                    ),
                  );
                  expect(recoveryRecord.recovery).toMatchObject({
                    failureReason: "workflow-activation-failure-unverified",
                    freshSessionDisposition: "ended",
                    freshGroupQuarantineDisposition: "quarantined",
                    quarantineDisposition: "quarantined",
                  });
                  const serializedRecovery = JSON.stringify(recoveryRecord);
                  expect(serializedRecovery).not.toContain(activationFailureCanary);
                  expect(serializedRecovery).not.toContain("activation-token-canary");
                  expect(serializedRecovery).not.toContain("activation-password-canary");
                  expect(serializedRecovery).not.toContain("runtime.invalid");
                  expect((yield* controller.status(lastFreshSessionId)).phase).toBe("ended");
                }

                yield* prepareNextOldSession;
                activationFailureReason =
                  "token=activation-token-canary https://runtime.invalid/password=activation-password-canary";
                lastFreshSessionId = undefined;
                const activationFailureHumanOutput = yield* runShippedCli([
                  "preview",
                  "recreate",
                  "--config",
                  configPath,
                  "--session",
                  activeOldCredentials.session.id,
                  "--confirm-development",
                ]);
                expect(activationFailureHumanOutput).toContain(
                  "workflow-activation-failure-unverified",
                );
                expect(activationFailureHumanOutput).not.toContain("activation-token-canary");
                expect(activationFailureHumanOutput).not.toContain("activation-password-canary");
                expect(activationFailureHumanOutput).not.toContain("runtime.invalid");
                expect(lastFreshSessionId).toBeDefined();
                if (lastFreshSessionId !== undefined) {
                  const humanFreshSessionId = requireSessionId(lastFreshSessionId);
                  const humanRecoveryRecord = yield* fileSystem.readFileString(
                    path.join(
                      credentialsDirectory,
                      `${humanFreshSessionId}.workflow-recreation-recovery.json`,
                    ),
                  );
                  expect(humanRecoveryRecord).toContain(
                    '"failureReason":"workflow-activation-failure-unverified"',
                  );
                  expect(humanRecoveryRecord).not.toContain("activation-token-canary");
                  expect(humanRecoveryRecord).not.toContain("activation-password-canary");
                  expect(humanRecoveryRecord).not.toContain("runtime.invalid");
                }
              });

            const runTypedSnapshotValidationRegression = () =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                activeProposedSnapshot = sealStagedSourceSnapshot(
                  activeProposedRevision,
                  activeProposedSnapshot.files.map((file) =>
                    file.path === "packages/sheet-workflows/src/index.ts"
                      ? { ...file, mode: 0o1000 }
                      : file,
                  ),
                );
                activation = { ...activation, snapshot: activeProposedSnapshot };
                providerResolution = activationResolutionFor(activation);
                lastFreshSessionId = undefined;
                events.length = 0;
                const typedSnapshotValidationOutput = requireCliOutput(
                  yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]),
                  "expected typed staged snapshot validation JSON output",
                );
                const typedSnapshotValidationResult = Schema.decodeUnknownSync(
                  Schema.Struct({
                    errors: Schema.Array(Schema.Struct({ remediation: Schema.String })),
                    previewSession: Schema.Struct({ phase: Schema.String }),
                  }),
                )(JSON.parse(typedSnapshotValidationOutput));
                expect(typedSnapshotValidationResult.errors[0]?.remediation).toContain(
                  "invalid-mode",
                );
                expect(typedSnapshotValidationResult.errors[0]?.remediation).not.toContain(
                  "workflow-activation-failure-unverified",
                );
                expect(typedSnapshotValidationResult.previewSession.phase).toBe("active");
                expect(events).toEqual([]);
                expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                  "active",
                );
                activeProposedSnapshot = proposedSnapshot;
                activation = { ...activation, snapshot: proposedSnapshot };
                providerResolution = activationResolutionFor(activation);
                yield* controller.stop(
                  activeOldCredentials.session.id,
                  activeOldCredentials.ownerIdentity,
                );
              });

            const runUnconfirmedActivationFenceRegression = () =>
              Effect.gen(function* () {
                yield* prepareNextOldSession;
                activationFailureReason = "runner-activation-unconfirmed";
                lastFreshSessionId = undefined;
                failOldGroupQuarantine.current = true;
                failOldReassignmentFence.current = true;
                const unconfirmedFenceOutput = requireCliOutput(
                  yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        failOldGroupQuarantine.current = false;
                        failOldReassignmentFence.current = false;
                      }),
                    ),
                  ),
                  "expected unconfirmed reassignment-fence JSON output",
                );
                expect(parseJsonRecord(unconfirmedFenceOutput)).toMatchObject({
                  previewSession: {
                    workflowTransitionPhases: {
                      quarantine: "unconfirmed",
                      ordinaryReassignment: "unconfirmed",
                    },
                    workflowRecreation: {
                      recovery: {
                        quarantineDisposition: "unconfirmed",
                        ordinaryReassignmentBlocked: null,
                      },
                    },
                  },
                });
                expect(lastFreshSessionId).toBeDefined();
                if (lastFreshSessionId !== undefined) {
                  const freshSessionId = requireSessionId(lastFreshSessionId);
                  const unconfirmedFenceRecovery = parseWorkflowRecreationRecoveryRecord(
                    yield* fileSystem.readFileString(
                      path.join(
                        credentialsDirectory,
                        `${freshSessionId}.workflow-recreation-recovery.json`,
                      ),
                    ),
                  );
                  expect(unconfirmedFenceRecovery.phases).toMatchObject({
                    quarantine: "unconfirmed",
                    ordinaryReassignment: "unconfirmed",
                  });
                  expect(unconfirmedFenceRecovery.recovery).toMatchObject({
                    quarantineDisposition: "unconfirmed",
                    ordinaryReassignmentBlocked: null,
                  });
                  expect((yield* controller.status(freshSessionId)).phase).toBe("pending");
                }
              });

            const scenarioHandlers = {
              "old-code-cancellation": () =>
                Effect.gen(function* () {
                  yield* prepareNewRevisionTransition;
                  oldWorkSettlementMode = "cancelled";
                  const output = requireCliOutput(
                    yield* runShippedCli([
                      "preview",
                      "recreate",
                      "--config",
                      configPath,
                      "--session",
                      activeOldCredentials.session.id,
                      "--confirm-development",
                      "--json",
                    ]),
                    "expected old-code cancellation lifecycle output",
                  );
                  oldWorkSettlementMode = "settled";
                  expect(parseJsonRecord(output)).toMatchObject({
                    previewSession: {
                      workflowTransitionPhases: {
                        cancellation: "completed",
                        reconciliation: "completed",
                        settlement: "settled",
                        oldSessionEnd: "ended",
                        freshGroup: "provisioned",
                        activation: "activated",
                      },
                    },
                  });
                  expect(events).toContain("settle-old-code");
                  expect(events).toContain("prove-old-cessation");
                  expect(events).toContain("provider-old-cleanup");
                  expect(events).toContain("end-old-session");
                  expect(events).toContain("provision-fresh-group");
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "ended",
                  );
                }),
              "unresolved-ambiguous-outcome": () =>
                Effect.gen(function* () {
                  yield* prepareNewRevisionTransition;
                  oldWorkSettlementMode = "ambiguous";
                  const output = requireCliOutput(
                    yield* runShippedCli([
                      "preview",
                      "recreate",
                      "--config",
                      configPath,
                      "--session",
                      activeOldCredentials.session.id,
                      "--confirm-development",
                      "--json",
                    ]),
                    "expected ambiguous-outcome lifecycle output",
                  );
                  oldWorkSettlementMode = "settled";
                  const result = parseJsonRecord(output);
                  expect(result.errors).toMatchObject([
                    { remediation: expect.stringContaining("old-work-settlement-ambiguous") },
                  ]);
                  expect(result.previewSession).toMatchObject({
                    workflowTransitionPhases: {
                      cancellation: "ambiguous",
                      settlement: "ambiguous",
                      cessation: "not-started",
                      oldSessionEnd: "not-started",
                      cleanup: "not-started",
                      freshGroup: "not-started",
                      activation: "not-started",
                      quarantine: "confirmed",
                    },
                  });
                  expect(events).toContain("settle-old-code");
                  expect(events).not.toContain("prove-old-cessation");
                  expect(events).not.toContain("provider-old-cleanup");
                  expect(events).not.toContain("end-old-session");
                  expect(events).not.toContain("provision-fresh-session");
                  expect(events).not.toContain("provision-fresh-group");
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "active",
                  );
                }),
              "provider-status": () =>
                Effect.gen(function* () {
                  const statusOutput = yield* runShippedCli([
                    "preview",
                    "status",
                    "--session",
                    oldCredentials.session.id,
                    "--json",
                  ]);
                  expect(typeof statusOutput).toBe("string");
                  expect(yield* fileSystem.exists(moduleMarkerPath)).toBe(false);
                  expect(yield* fileSystem.exists(factoryMarkerPath)).toBe(false);
                }),
              "provider-module-outside-checkout": () =>
                Effect.gen(function* () {
                  process.env.TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE =
                    "../outside-workflow-provider.mjs";
                  events.length = 0;
                  const unavailableProviderOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    oldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(unavailableProviderOutput).toContain("provider-module-outside-checkout");
                  expect(events).not.toContain("settle-old-code");
                  expect(events).not.toContain("provision-fresh-session");
                  const unrelatedStatusOutput = yield* runShippedCli([
                    "preview",
                    "status",
                    "--session",
                    oldCredentials.session.id,
                    "--json",
                  ]);
                  expect(unrelatedStatusOutput).not.toContain("provider-module-outside-checkout");
                  expect(yield* fileSystem.exists(moduleMarkerPath)).toBe(false);
                  process.env.TIARA_PREVIEW_WORKFLOW_PROVIDER_MODULE = providerModuleName;
                }),
              "provider-non-effect": () =>
                Effect.gen(function* () {
                  providerResolution = () => ({ malformed: true });
                  const nonEffectOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    oldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(nonEffectOutput).toContain('"ok":false');
                  expect(
                    JSON.parse(
                      requireCliOutput(nonEffectOutput, "expected provider failure JSON output"),
                    ).previewSession.phase,
                  ).toBe("active");
                  expect(events).not.toContain("provision-fresh-session");
                }),
              "provider-malformed-runtime": () =>
                Effect.gen(function* () {
                  providerResolution = (requestedConfig) =>
                    Effect.succeed({
                      ...bindTestActivationEvidence(activation, requestedConfig),
                      runtime: {},
                    });
                  const malformedActivationOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    oldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(malformedActivationOutput).toContain('"ok":false');
                  expect(events).not.toContain("provision-fresh-session");
                  providerResolution = activationResolutionFor(activation);
                }),
              "stale-catalog-evidence": () =>
                Effect.gen(function* () {
                  bindProviderCompatibilityEvidence = false;
                  providerResolution = activationResolutionFor({
                    ...activation,
                    proposed: {
                      ...activation.proposed,
                      compatibility: suppliedCompatibilityMismatch,
                    },
                  });
                  events.length = 0;
                  const staleCatalogOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    oldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(staleCatalogOutput).toContain('"ok":false');
                  expect(events).not.toContain("settle-old-code");
                  expect(events).not.toContain("provision-fresh-session");
                }),
              "missing-change-declarations": () =>
                Effect.gen(function* () {
                  bindProviderCompatibilityEvidence = false;
                  providerResolution = activationResolutionFor({
                    ...activation,
                    proposed: {
                      ...activation.proposed,
                      compatibility: {
                        catalogVersion: config.identities.catalogVersion,
                        catalogDigest: workflowPreviewRuntimeContractCatalogIdentity.digest,
                        declarations: [],
                      },
                    },
                  });
                  events.length = 0;
                  const missingDeclarationsOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    oldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(missingDeclarationsOutput).toContain('"ok":false');
                  expect(events).not.toContain("settle-old-code");
                  expect(events).not.toContain("provision-fresh-session");
                  bindProviderCompatibilityEvidence = true;
                  providerResolution = activationResolutionFor(activation);
                }),
              "missing-required-group-closure": () =>
                Effect.gen(function* () {
                  const incompatibleClosureConfig = {
                    ...config,
                    changes: config.changes.map((change) =>
                      change.role === "sheet-workflows-runner" &&
                      change.contract === "workflow.execution"
                        ? { ...change, classification: "incompatible" }
                        : change,
                    ),
                  };
                  yield* fileSystem.writeFileString(
                    configPath,
                    JSON.stringify(incompatibleClosureConfig),
                  );
                  providerResolution = activationResolutionFor({
                    ...activation,
                    proposed: { ...activation.proposed, requiredGroups: [] },
                  });
                  events.length = 0;
                  const missingClosureOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    oldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(missingClosureOutput).toContain('"ok":false');
                  expect(events).not.toContain("settle-old-code");
                  expect(events).not.toContain("provision-fresh-session");
                  yield* fileSystem.writeFileString(configPath, JSON.stringify(config));
                }),
              "unconfigured-proposed-group": () =>
                Effect.gen(function* () {
                  providerResolution = activationResolutionFor({
                    ...activation,
                    proposed: {
                      ...activation.proposed,
                      requiredGroups: [
                        ...activation.proposed.requiredGroups,
                        "unselected-workflow-state",
                      ],
                    },
                  });
                  events.length = 0;
                  const unconfiguredGroupOutput = requireCliOutput(
                    yield* runShippedCli([
                      "preview",
                      "recreate",
                      "--config",
                      configPath,
                      "--session",
                      oldCredentials.session.id,
                      "--confirm-development",
                      "--json",
                    ]),
                    "expected unconfigured group rejection JSON output",
                  );
                  expect(unconfiguredGroupOutput).toContain('"ok":false');
                  expect(unconfiguredGroupOutput).toContain("proposed configuration");
                  expect(events).not.toContain("settle-old-code");
                  expect(events).not.toContain("prove-old-cessation");
                  expect(events).not.toContain("provider-old-cleanup");
                  expect(events).not.toContain("end-old-session");
                  expect(events).not.toContain("provision-fresh-session");
                  expect(events).not.toContain("provision-fresh-group");
                  expect(events).not.toContain("stage");
                  expect(events).not.toContain("activate-snapshot");
                  expect((yield* controller.status(oldCredentials.session.id)).phase).toBe(
                    "active",
                  );
                }),
              "compatible-transition": () =>
                Effect.gen(function* () {
                  const compatibleArtifacts: WorkflowExecutionArtifacts = {
                    ...activeProposedArtifacts,
                    runnerArtifacts: { ordinary_runner: nextRunnerDigest },
                    contracts: oldArtifacts.contracts,
                    deployment: oldArtifacts.deployment,
                    workflowVersion: oldArtifacts.workflowVersion,
                    actionVersions: oldArtifacts.actionVersions,
                  };
                  const compatibleConfig = {
                    ...config,
                    roles: originalConfig.roles,
                    environmentFileInputs: config.environmentFileInputs.filter(
                      ({ role }) => role !== "sheet-workflows-browser-runner",
                    ),
                    identities: {
                      ...config.identities,
                      artifactDigests: Object.fromEntries(
                        Object.entries(config.identities.artifactDigests).filter(
                          ([role]) => role !== "sheet-workflows-browser-runner",
                        ),
                      ),
                    },
                    changes: config.changes.filter(
                      (change) => change.role !== "sheet-workflows-browser-runner",
                    ),
                    credentialReferences: Object.fromEntries(
                      Object.entries(config.credentialReferences).filter(
                        ([role]) => role !== "sheet-workflows-browser-runner",
                      ),
                    ),
                  };
                  yield* fileSystem.writeFileString(configPath, JSON.stringify(compatibleConfig));
                  activeProposedArtifacts = compatibleArtifacts;
                  providerResolution = activationResolutionFor({
                    ...activation,
                    proposed: {
                      ...activation.proposed,
                      artifacts: compatibleArtifacts,
                      requiredGroups: activation.previous.requiredGroups,
                      workloadRoles: activation.previous.workloadRoles,
                    },
                  });
                  events.length = 0;
                  const compatibleTransitionOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    oldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(compatibleTransitionOutput).toContain("transition is compatible");
                  expect(events).not.toContain("stage");
                  expect(events).not.toContain("fence-old-owner");
                  expect(events).not.toContain("activate-snapshot");
                  expect(events).not.toContain("settle-old-code");
                  expect(events).not.toContain("provision-fresh-session");
                  expect(events).not.toContain("provision-fresh-group");
                }),
              "successful-recreation": () =>
                Effect.gen(function* () {
                  yield* fileSystem.writeFileString(configPath, JSON.stringify(config));
                  activeProposedArtifacts = proposedArtifacts;
                  providerResolution = activationResolutionFor(activation);
                  events.length = 0;
                  const resultOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    oldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(typeof resultOutput).toBe("string");
                  const output = Schema.decodeUnknownSync(successfulRecreationOutputSchema)(
                    JSON.parse(requireCliOutput(resultOutput, "expected CLI JSON output")),
                  );
                  expect(yield* fileSystem.exists(moduleMarkerPath)).toBe(true);
                  expect(yield* fileSystem.exists(factoryMarkerPath)).toBe(true);
                  expect(yield* fileSystem.exists(resolverMarkerPath)).toBe(true);
                  expect(output.previewSession.phase).toBe("active");
                  expect(output.previewSession.activeRevision).toBe(newRevision);
                  expect(output.previewSession.id).not.toBe(oldCredentials.session.id);
                  expect(output.previewSession.workflowRecreation.oldCleanupRecordId).toBe(
                    `cleanup-${oldCredentials.session.id}`,
                  );
                  expect(output.previewSession.workflowRecreation.priorRevision).toBe(oldRevision);
                  expect(output.previewSession.workflowRecreation.requestedRevision).toBe(
                    newRevision,
                  );
                  expect(output.previewSession.workflowRecreation.reasons).toContain(
                    "action-version-changed",
                  );
                  expect(output.previewSession.workflowTransitionPhases).toMatchObject({
                    proposal: "presented",
                    admission: "paused",
                    producerFencing: "fenced",
                    drain: "completed",
                    cancellation: "not-required",
                    reconciliation: "not-required",
                    settlement: "settled",
                    cessation: "proven",
                    oldSessionEnd: "ended",
                    cleanup: "completed",
                    freshGroup: "provisioned",
                    activation: "activated",
                    quarantine: "not-started",
                    ordinaryReassignment: "not-started",
                  });
                  expect(
                    output.previewSession.workflowTransitionPhases.drainElapsedMs,
                  ).toBeGreaterThanOrEqual(0);
                  expect(
                    output.previewSession.workflowTransitionPhases
                      .cancellationReconciliationElapsedMs,
                  ).toBeGreaterThanOrEqual(0);
                  expect(
                    output.previewSession.workflowTransitionPhases.cessationProofElapsedMs,
                  ).toBeGreaterThanOrEqual(0);
                  expect(
                    output.previewSession.workflowTransitionPhases.settlementElapsedMs,
                  ).toBeGreaterThanOrEqual(0);
                  expect(
                    output.previewSession.workflowTransitionPhases.acceptedWorkElapsedMs,
                  ).toBeGreaterThanOrEqual(0);
                  const freshSession = yield* controller.status(output.previewSession.id);
                  const authEndpoint = "https://auth.dev.theerapakg.moe";
                  expect(originalConfig.groups).toContainEqual(
                    expect.objectContaining({ id: "auth", endpoint: authEndpoint }),
                  );
                  const credentialIssue = yield* controller.authorizeCredentialIssue(
                    freshSession.id,
                    freshSession.generation,
                    "sheet-workflows-api",
                  );
                  const oauthClientId = `fresh-api-client-${freshSession.id}`;
                  yield* controller.registerCredentialIdentity({
                    id: freshSession.id,
                    generation: freshSession.generation,
                    role: "sheet-workflows-api",
                    reservationId: credentialIssue.reservationId,
                    credentialName: "workflow-database",
                    serviceAccount: "fresh-preview-service-account",
                    oauthClientId,
                    credentialFile: `${credentialsDirectory}/fresh-api-credential`,
                  });
                  yield* controller.authorizeWorkload(
                    freshSession.id,
                    freshSession.generation,
                    "sheet-workflows-api",
                    oauthClientId,
                  );
                  const admission = yield* controller.admitWorkload({
                    sessionId: freshSession.id,
                    generation: freshSession.generation,
                    role: "sheet-workflows-api",
                    oauthClientId,
                    groupId: "auth",
                    invocationId: "fresh-session-admission-check",
                    continuationId: null,
                    endpoint: authEndpoint,
                    target: "sheets:development-2026",
                  });
                  expect(admission.endpoint).toBe(authEndpoint);
                  expect(admission.target).toBe("sheets:development-2026");
                  yield* controller.settleWorkload(admission);
                  expect(events.indexOf("settle-old-code")).toBeLessThan(
                    events.indexOf("end-old-session"),
                  );
                  expect(events.indexOf("prove-old-cessation")).toBeLessThan(
                    events.indexOf("provider-old-cleanup"),
                  );
                  expect(events.indexOf("provider-old-cleanup")).toBeLessThan(
                    events.indexOf("end-old-session"),
                  );
                  expect(events.indexOf("prove-old-cessation")).toBeLessThan(
                    events.indexOf("provision-fresh-session"),
                  );
                  expect(events.indexOf("provision-fresh-session")).toBeLessThan(
                    events.indexOf("provision-fresh-group"),
                  );
                  expect(events.indexOf("provision-fresh-session")).toBeLessThan(
                    events.indexOf("activate-snapshot"),
                  );
                  expect(events.indexOf("persist-cleanup-link")).toBeLessThan(
                    events.indexOf("activate-snapshot"),
                  );
                  expect(events.at(-1)).toBe("activate-fresh-session");
                  expect(events).toContain("restart:workflow-api");
                  expect(events).toContain("restart:ordinary-runner");
                  expect(events).toContain("restart:browser-runner");
                  expect(events).toContain("readiness:workflow-api,ordinary-runner,browser-runner");
                }),
              "legacy-api-only": () =>
                Effect.gen(function* () {
                  yield* fileSystem.writeFileString(configPath, JSON.stringify(config));
                  activeOldCredentials = yield* controller.create({
                    owner: config.owner,
                    checkout: process.cwd(),
                    manifests: {
                      "sheet-workflows-api": `sha256:${oldArtifacts.api}`,
                      "deployed-manifest": originalConfig.identities.deployedManifestDigest,
                    },
                    requestedRevision: oldRevision,
                    groups: config.groups.map(({ id }) => id),
                  });
                  yield* controller.activate(
                    activeOldCredentials.session.id,
                    activeOldCredentials.session.generation,
                    activeOldCredentials.supervisorIdentity,
                    oldRevision,
                  );
                  yield* fileSystem.writeFileString(
                    path.join(credentialsDirectory, activeOldCredentials.session.id),
                    JSON.stringify({
                      ownerIdentity: activeOldCredentials.ownerIdentity,
                      supervisorIdentity: activeOldCredentials.supervisorIdentity,
                    }),
                    { mode: 0o600 },
                  );
                  activeOldGroup = workflowExecutionGroupIdentity({
                    sessionId: activeOldCredentials.session.id,
                    ownerToken: activeOldCredentials.ownerIdentity,
                    generation: activeOldCredentials.session.generation,
                    database: "workflow_legacy_api_only_db",
                    apiEndpoint: "https://workflow-legacy-api-only.dev.test",
                    observationEndpoint: "https://workflow-legacy-api-only.dev.test/observe",
                    artifacts: oldArtifacts,
                    workloadOAuthClientIds: { workflow_api: "api-only-old-client" },
                  });
                  activeProposedArtifacts = proposedArtifacts;
                  activation = {
                    ...activation,
                    oldGroup: activeOldGroup,
                    previous: { ...activation.previous, workloadRoles: ["workflow_api"] },
                    proposed: {
                      ...activation.proposed,
                      sourceRevision: newRevision,
                      artifacts: proposedArtifacts,
                      workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
                    },
                    previousSnapshot,
                    snapshot: proposedSnapshot,
                    roles: ["workflow-api", "ordinary-runner", "browser-runner"],
                    owner: activeOldCredentials.ownerIdentity,
                  };
                  providerResolution = activationResolutionFor(activation);
                  events.length = 0;
                  const legacyApiOnlyOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  const legacyApiOnlyResult = Schema.decodeUnknownSync(
                    Schema.Struct({
                      ok: Schema.Boolean,
                      previewSession: Schema.Struct({ phase: Schema.String }),
                    }),
                  )(
                    JSON.parse(
                      requireCliOutput(
                        legacyApiOnlyOutput,
                        "expected API-only legacy session JSON output",
                      ),
                    ),
                  );
                  if (!legacyApiOnlyResult.ok)
                    throw new Error(
                      requireCliOutput(
                        legacyApiOnlyOutput,
                        "expected API-only legacy session output",
                      ),
                    );
                  expect(legacyApiOnlyResult.ok).toBe(true);
                  expect(legacyApiOnlyResult.previewSession.phase).toBe("active");
                  expect(events).toContain("restart:workflow-api");
                  expect(events).toContain("restart:ordinary-runner");
                  expect(events).toContain("restart:browser-runner");
                }),
              "old-cleanup-binding-mismatch": () =>
                Effect.gen(function* () {
                  yield* prepareNextOldSession;
                  mutateOldGroupDuringSettlement.current = (oldGroup) =>
                    Object.assign(oldGroup, { ownerToken: "unexpected-owner-after-settlement" });
                  const bindingMismatchOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        mutateOldGroupDuringSettlement.current = () => {};
                        Object.assign(activeOldGroup, {
                          ownerToken: activeOldCredentials.ownerIdentity,
                        });
                      }),
                    ),
                  );
                  assertOldSessionBindingMismatchDiagnostic(String(bindingMismatchOutput));
                  expect(events).toContain("settle-old-code");
                  expect(events).toContain("prove-old-cessation");
                  expect(events).not.toContain("provider-old-cleanup");
                  expect(events).not.toContain("end-old-session");
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "active",
                  );
                  yield* controller.stop(
                    activeOldCredentials.session.id,
                    activeOldCredentials.ownerIdentity,
                  );
                }),
              "old-cleanup-provider-failure": () =>
                Effect.gen(function* () {
                  yield* prepareNextOldSession;
                  providerOldCleanup.current = () =>
                    Effect.fail(
                      new WorkflowExecutionError({ reason: "controlled-provider-cleanup" }),
                    );
                  const genericOldCleanupOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(
                        () =>
                          (providerOldCleanup.current = () =>
                            Effect.succeed(`cleanup-${activeOldCredentials.session.id}`)),
                      ),
                    ),
                  );
                  assertGenericOldCleanupFailureDiagnostic(String(genericOldCleanupOutput));
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "active",
                  );
                  yield* controller.stop(
                    activeOldCredentials.session.id,
                    activeOldCredentials.ownerIdentity,
                  );
                }),
              "old-cleanup-record-empty": () =>
                Effect.gen(function* () {
                  yield* assertMissingOldCleanupRecordDoesNotStopSession("");
                }),
              "old-cleanup-record-whitespace": () =>
                Effect.gen(function* () {
                  yield* assertMissingOldCleanupRecordDoesNotStopSession(" \t\n ");
                }),
              "old-session-stop-json": () =>
                Effect.gen(function* () {
                  yield* prepareNextOldSession;
                  stopOldSession.current = () =>
                    Effect.fail(new PreviewSessionError({ reason: "controlled-old-session-stop" }));
                  const controllerStopFailureOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(
                        () =>
                          (stopOldSession.current = (id, ownerIdentity, expectedGeneration) =>
                            controller.stop(id, ownerIdentity, expectedGeneration)),
                      ),
                    ),
                  );
                  const expectedCleanupRecordId = `cleanup-${activeOldCredentials.session.id}`;
                  assertOldSessionStopFailureDiagnostic(
                    String(controllerStopFailureOutput),
                    expectedCleanupRecordId,
                  );
                  expect(events).toContain("provider-old-cleanup");
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "active",
                  );
                  yield* controller.stop(
                    activeOldCredentials.session.id,
                    activeOldCredentials.ownerIdentity,
                  );
                }),
              "old-session-stop-human": () =>
                Effect.gen(function* () {
                  yield* prepareNextOldSession;
                  stopOldSession.current = () =>
                    Effect.fail(new PreviewSessionError({ reason: "controlled-old-session-stop" }));
                  const expectedHumanCleanupRecordId = `cleanup-${activeOldCredentials.session.id}`;
                  const controllerStopFailureHumanOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(
                        () =>
                          (stopOldSession.current = (id, ownerIdentity, expectedGeneration) =>
                            controller.stop(id, ownerIdentity, expectedGeneration)),
                      ),
                    ),
                  );
                  assertOldSessionStopFailureHumanDiagnostic(
                    String(controllerStopFailureHumanOutput),
                    expectedHumanCleanupRecordId,
                  );
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "active",
                  );
                  yield* controller.stop(
                    activeOldCredentials.session.id,
                    activeOldCredentials.ownerIdentity,
                  );
                }),
              "old-session-stop-timeout": () =>
                Effect.gen(function* () {
                  yield* runOldSessionStopTimeoutRegression();
                }),
              "old-session-generation-rotated-before-stop": () =>
                Effect.gen(function* () {
                  yield* prepareNextOldSession;
                  const previousGeneration = activeOldCredentials.session.generation;
                  rotateOldSessionGenerationBeforeStop.current = true;
                  const output = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        rotateOldSessionGenerationBeforeStop.current = false;
                        sessionClockOffset.current = 0;
                      }),
                    ),
                  );
                  const current = yield* controller.status(activeOldCredentials.session.id);
                  const result = parseJsonRecord(
                    requireCliOutput(output, "expected generation-fenced old-session stop output"),
                  );
                  const previewSession = decodeJsonRecord(result.previewSession);
                  expect(current.generation).toBe(previousGeneration + 1);
                  expect(current.phase).toBe("pending");
                  expect(current.endedAt).toBeNull();
                  expect(result.errors).toMatchObject([
                    { remediation: expect.stringContaining("old-session-end-unconfirmed") },
                  ]);
                  expect(previewSession.oldCleanupRecordId).toBe(
                    `cleanup-${activeOldCredentials.session.id}`,
                  );
                  expect(previewSession.workflowTransitionPhases).toMatchObject({
                    oldSessionEnd: "unconfirmed",
                    cleanup: "completed",
                  });
                  expect(events).toContain("old-session-generation-rotated-before-stop");
                  expect(events).not.toContain("provision-fresh-group");
                  yield* controller.stop(
                    activeOldCredentials.session.id,
                    activeOldCredentials.ownerIdentity,
                  );
                }),
              "credential-persistence-failure": () =>
                Effect.gen(function* () {
                  yield* runCredentialPersistenceFailure(false);
                }),
              "credential-persistence-expired": () =>
                Effect.gen(function* () {
                  yield* runCredentialPersistenceFailure(true);
                }),
              "fresh-provider-failure": () =>
                Effect.gen(function* () {
                  yield* runFailedRecreation("provider");
                }),
              "sensitive-provider-failure": () =>
                Effect.gen(function* () {
                  yield* runFailedRecreation("sensitive-provider");
                }),
              "fresh-binding-failure": () =>
                Effect.gen(function* () {
                  yield* runFailedRecreation("binding");
                }),
              "fresh-evidence-failure": () =>
                Effect.gen(function* () {
                  yield* runFailedRecreation("evidence");
                }),
              "fresh-artifact-evidence-failure": () =>
                Effect.gen(function* () {
                  yield* runFailedRecreation("artifact-evidence");
                }),
              "provider-timeout": () =>
                Effect.gen(function* () {
                  yield* runProviderActivationTimeoutRegression();
                }),
              "human-recovery-output": () =>
                Effect.gen(function* () {
                  yield* prepareNextOldSession;
                  provisioningFailure = "provider";
                  lastFreshSessionId = undefined;
                  failOldGroupQuarantine.current = true;
                  failOldReassignmentFence.current = true;
                  const humanRecoveryOutput = requireCliOutput(
                    yield* runShippedCli([
                      "preview",
                      "recreate",
                      "--config",
                      configPath,
                      "--session",
                      activeOldCredentials.session.id,
                      "--confirm-development",
                    ]).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          failOldGroupQuarantine.current = false;
                          failOldReassignmentFence.current = false;
                        }),
                      ),
                    ),
                    "expected human-readable recovery output",
                  );
                  expect(lastFreshSessionId).toBeDefined();
                  const humanFreshSessionId = requireSessionId(lastFreshSessionId);
                  const humanRecoveryRecord = parseWorkflowRecreationRecoveryRecord(
                    yield* fileSystem.readFileString(
                      path.join(
                        credentialsDirectory,
                        `${humanFreshSessionId}.workflow-recreation-recovery.json`,
                      ),
                    ),
                  );
                  expect(humanRecoveryRecord.recovery.quarantineDisposition).toBe("unconfirmed");
                  expect(humanRecoveryRecord.recovery.ordinaryReassignmentBlocked).toBeNull();
                  expect(humanRecoveryOutput).toContain(
                    `recovery disposition: ${humanRecoveryRecord.recovery.quarantineDisposition}`,
                  );
                  expect(humanRecoveryOutput).toContain(
                    `fresh session disposition: ${humanRecoveryRecord.recovery.freshSessionDisposition}`,
                  );
                  expect(humanRecoveryOutput).toContain(
                    `fresh group quarantine disposition: ${humanRecoveryRecord.recovery.freshGroupQuarantineDisposition}`,
                  );
                }),
              "cached-state-fallback": () =>
                Effect.gen(function* () {
                  yield* prepareNextOldSession;
                  provisioningFailure = "provider";
                  failOldStatusReadAfterStop.current = true;
                  const cachedStateFallbackOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(() => (failOldStatusReadAfterStop.current = false)),
                    ),
                  );
                  assertCachedOldSessionFallback(
                    requireCliOutput(
                      cachedStateFallbackOutput,
                      "expected cached-state fallback JSON",
                    ),
                    `cleanup-${activeOldCredentials.session.id}`,
                  );
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "ended",
                  );
                  expect(
                    (yield* controller.status(requireSessionId(lastFreshSessionId))).phase,
                  ).toBe("pending");
                }),
              "old-status-timeout": () =>
                Effect.gen(function* () {
                  yield* runOldStatusTimeoutRegression();
                }),
              "activation-failure": () =>
                Effect.gen(function* () {
                  yield* runActivationFailurePrivacyRegression();
                  yield* assertFreshSessionActivationFailure({
                    prepareNextOldSession: () => prepareNextOldSession,
                    runShippedCli,
                    configPath,
                    sessionId: () => activeOldCredentials.session.id,
                    setFailure: (enabled) => (freshSessionActivationFailure = enabled),
                  });
                  yield* runTypedSnapshotValidationRegression();
                  yield* runUnconfirmedActivationFenceRegression();
                }),
              "same-snapshot-supervision": () =>
                Effect.gen(function* () {
                  yield* prepareNextOldSession;
                  const sameSnapshotActionArtifacts: WorkflowExecutionArtifacts = {
                    ...proposedArtifacts,
                    contracts: oldArtifacts.contracts,
                    deployment: oldArtifacts.deployment,
                    workflowVersion: "2.0.0",
                    actionVersions: { "main-action": "2" },
                  };
                  const sameSnapshotConfig = {
                    ...config,
                    identities: { ...config.identities, sourceRevision: oldRevision },
                    changes: config.changes.map((change) => ({
                      ...change,
                      sourceRevision: oldRevision,
                    })),
                  };
                  yield* fileSystem.writeFileString(configPath, JSON.stringify(sameSnapshotConfig));
                  activeProposedArtifacts = sameSnapshotActionArtifacts;
                  activeProposedSnapshot = previousSnapshot;
                  activeProposedRevision = oldRevision;
                  activation = {
                    ...activation,
                    previous: {
                      ...activation.previous,
                      sourceRevision: oldRevision,
                      artifacts: oldArtifacts,
                    },
                    previousSnapshot,
                    proposed: {
                      ...activation.proposed,
                      sourceRevision: oldRevision,
                      artifacts: sameSnapshotActionArtifacts,
                      workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
                    },
                    snapshot: previousSnapshot,
                    roles: ["workflow-api", "ordinary-runner", "browser-runner"],
                  };
                  providerResolution = activationResolutionFor(activation);
                  events.length = 0;
                  const sameSnapshotOutput = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]);
                  expect(typeof sameSnapshotOutput).toBe("string");
                  if (typeof sameSnapshotOutput !== "string")
                    throw new Error("expected same-snapshot recreation JSON output");
                  const sameSnapshotResult = Schema.decodeUnknownSync(
                    successfulRecreationOutputSchema,
                  )(JSON.parse(sameSnapshotOutput));
                  expect(sameSnapshotResult.previewSession.phase).toBe("active");
                  expect(sameSnapshotResult.previewSession.activeRevision).toBe(oldRevision);
                  expect(sameSnapshotResult.previewSession.id).not.toBe(
                    activeOldCredentials.session.id,
                  );
                  expect(
                    sameSnapshotResult.previewSession.workflowRecreation.oldCleanupRecordId,
                  ).toBe(`cleanup-${activeOldCredentials.session.id}`);
                  expect(events).toContain("settle-old-code");
                  expect(events).toContain("provision-fresh-session");
                  expect(events).toContain("persist-cleanup-link");
                  expect(events).toContain("restart:workflow-api");
                  expect(events).toContain("restart:ordinary-runner");
                  expect(events).toContain("restart:browser-runner");
                  let terminalControllerBehavior: "stop-timeout" | "status-timeout" | undefined;
                  if (scenario === "foreground-supervisor-stop-timeout") {
                    terminalControllerBehavior = "stop-timeout";
                  } else if (scenario === "foreground-supervisor-status-timeout") {
                    terminalControllerBehavior = "status-timeout";
                  }
                  if (terminalControllerBehavior !== undefined) {
                    freshStopSupervisedStarted = yield* Deferred.make<void>();
                    freshStatusAfterSupervisedStopStarted = yield* Deferred.make<void>();
                  }
                  yield* assertRecreatedSessionRemainsSupervised({
                    scheduledSupervisors,
                    expectedSessionId: sameSnapshotResult.previewSession.id,
                    expectedCleanupRecordId:
                      sameSnapshotResult.previewSession.workflowRecreation.oldCleanupRecordId,
                    controller,
                    events,
                    setHeartbeatFailuresRemaining: (count) => {
                      freshLeaseHeartbeatFailuresRemaining = count;
                    },
                    ...(terminalControllerBehavior === undefined
                      ? {}
                      : { terminalControllerBehavior }),
                    configureTerminalControllerBehavior: (behavior) => {
                      hangFreshSessionStopSupervised.current = behavior === "stop-timeout";
                      failFreshSessionStopSupervised.current = behavior === "status-timeout";
                      hangFreshSessionStatusAfterSupervisedStop.current =
                        behavior === "status-timeout";
                      failedFreshSessionStop.current = false;
                    },
                  });
                }),
              "interruption-safe-lifecycle": () =>
                Effect.gen(function* () {
                  yield* prepareNewRevisionTransition;
                  const lifecycleBarriers = {
                    provisioning: yield* makeLifecycleBarrier(),
                    staging: yield* makeLifecycleBarrier(),
                    activation: yield* makeLifecycleBarrier(),
                  };
                  freshLifecycleBarriers = lifecycleBarriers;
                  const interruptedLifecycle = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(Effect.forkChild);
                  yield* Deferred.await(lifecycleBarriers.provisioning.started);
                  const freshDuringProvisioning = requireSessionCredentials(
                    getLastCreatedFreshCredentials(),
                  );
                  const initialRenewal = freshDuringProvisioning.session.lastRenewedAt;
                  yield* TestClock.adjust(Duration.seconds(50));
                  let renewedFreshSession = yield* controller.status(
                    freshDuringProvisioning.session.id,
                  );
                  expect(renewedFreshSession.lastRenewedAt).toBeGreaterThan(initialRenewal);
                  expect(events).toContain("heartbeat");
                  const interruptRequest = yield* Fiber.interrupt(interruptedLifecycle).pipe(
                    Effect.forkChild,
                  );
                  yield* Effect.yieldNow;
                  yield* Deferred.succeed(lifecycleBarriers.provisioning.release, undefined);
                  yield* Deferred.await(lifecycleBarriers.staging.started);
                  const afterProvisioningRenewal = renewedFreshSession.lastRenewedAt;
                  yield* TestClock.adjust(Duration.seconds(50));
                  renewedFreshSession = yield* controller.status(
                    freshDuringProvisioning.session.id,
                  );
                  expect(renewedFreshSession.lastRenewedAt).toBeGreaterThan(
                    afterProvisioningRenewal,
                  );
                  yield* Deferred.succeed(lifecycleBarriers.staging.release, undefined);
                  yield* Deferred.await(lifecycleBarriers.activation.started);
                  const afterStagingRenewal = renewedFreshSession.lastRenewedAt;
                  yield* TestClock.adjust(Duration.seconds(50));
                  renewedFreshSession = yield* controller.status(
                    freshDuringProvisioning.session.id,
                  );
                  expect(renewedFreshSession.lastRenewedAt).toBeGreaterThan(afterStagingRenewal);
                  expect(renewedFreshSession.leaseDeadline).toBeGreaterThan(now());
                  yield* Deferred.succeed(lifecycleBarriers.activation.release, undefined);
                  const interruptedLifecycleExit = yield* Fiber.await(interruptedLifecycle);
                  yield* Fiber.join(interruptRequest);
                  freshLifecycleBarriers = undefined;
                  expectInterruptOnlyExit(interruptedLifecycleExit);
                  const interruptedFreshSessionId = requireSessionId(lastFreshSessionId);
                  const interruptedFreshSession =
                    yield* controller.status(interruptedFreshSessionId);
                  expect(interruptedFreshSession.phase).toBe("active");
                  expect(interruptedFreshSession.activeRevision).toBe(activeProposedRevision);
                  expect(interruptedFreshSession.id).not.toBe(activeOldCredentials.session.id);
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "ended",
                  );
                  expect(interruptedFreshSession.leaseDeadline).toBeGreaterThan(now());
                  expect(
                    interruptedFreshSession.manifests["workflow-recreation-prior-cleanup-record"],
                  ).toBe(`cleanup-${activeOldCredentials.session.id}`);
                  expect(events).toContain("provider-old-cleanup");
                  expect(events).toContain("persist-cleanup-link");
                  expect(events).toContain("restart:browser-runner");
                }),
              "lease-failure-during-activation": () =>
                Effect.gen(function* () {
                  yield* prepareNewRevisionTransition;
                  const leaseFailureBarrier = yield* makeLifecycleBarrier();
                  const failedLeaseBarriers = {
                    provisioning: leaseFailureBarrier,
                    staging: yield* makeLifecycleBarrier(),
                    activation: yield* makeLifecycleBarrier(),
                  };
                  freshLifecycleBarriers = failedLeaseBarriers;
                  failFreshLeaseHeartbeat = true;
                  const failedLeaseLifecycle = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        failFreshLeaseHeartbeat = false;
                        freshLifecycleBarriers = undefined;
                      }),
                    ),
                    Effect.forkChild,
                  );
                  yield* Deferred.await(leaseFailureBarrier.started);
                  yield* Deferred.succeed(leaseFailureBarrier.release, undefined);
                  yield* Deferred.await(failedLeaseBarriers.staging.started);
                  yield* Deferred.succeed(failedLeaseBarriers.staging.release, undefined);
                  yield* Deferred.await(failedLeaseBarriers.activation.started);
                  yield* advanceLeaseFailureWindow();
                  yield* Deferred.succeed(failedLeaseBarriers.activation.release, undefined);
                  const failedLeaseOutput = requireCliOutput(
                    yield* Fiber.join(failedLeaseLifecycle),
                    "expected lease-failure recovery output",
                  );
                  expect(failedLeaseOutput).toContain('"ok":false');
                  const failedLeaseSessionId = requireSessionId(lastFreshSessionId);
                  const failedLeaseRecovery = parseWorkflowRecreationRecoveryRecord(
                    yield* fileSystem.readFileString(
                      path.join(
                        credentialsDirectory,
                        `${failedLeaseSessionId}.workflow-recreation-recovery.json`,
                      ),
                    ),
                  );
                  expect(failedLeaseRecovery.recovery).toMatchObject({
                    freshSessionDisposition: "ended",
                    freshGroupQuarantineDisposition: "quarantined",
                  });
                  expect((yield* controller.status(failedLeaseSessionId)).phase).toBe("ended");
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "ended",
                  );
                }),
              "lease-failure-during-staging": () =>
                Effect.gen(function* () {
                  yield* prepareNewRevisionTransition;
                  events.length = 0;
                  lastFreshSessionId = undefined;
                  lastCreatedFreshCredentials = undefined;
                  const provisioning = yield* makeLifecycleBarrier();
                  const staging = yield* makeLifecycleBarrier();
                  const activation = yield* makeLifecycleBarrier();
                  yield* Deferred.succeed(provisioning.release, undefined);
                  yield* Deferred.succeed(activation.release, undefined);
                  freshLifecycleBarriers = { provisioning, staging, activation };
                  failFreshLeaseHeartbeat = true;
                  const lifecycle = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        failFreshLeaseHeartbeat = false;
                        freshLifecycleBarriers = undefined;
                      }),
                    ),
                    Effect.forkChild,
                  );
                  yield* Deferred.await(staging.started);
                  const freshSessionId = requireSessionId(lastFreshSessionId);
                  yield* advanceLeaseFailureWindow();
                  expect(events).toContain("fresh-lease-heartbeat-failed");
                  yield* Deferred.succeed(staging.release, undefined);

                  const output = requireCliOutput(
                    yield* Fiber.join(lifecycle),
                    "expected staging-time lease failure JSON output",
                  );
                  expect(output).toContain('"ok":false');
                  expect(events).toContain("quarantine-fresh-group");
                  expect(events).not.toContain("activate-fresh-session");
                  expect((yield* controller.status(freshSessionId)).phase).toBe("ended");
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "ended",
                  );

                  const recovery = parseWorkflowRecreationRecoveryRecord(
                    yield* fileSystem.readFileString(
                      path.join(
                        credentialsDirectory,
                        `${freshSessionId}.workflow-recreation-recovery.json`,
                      ),
                    ),
                  );
                  expect(recovery).toMatchObject({
                    oldCleanupRecordId: `cleanup-${activeOldCredentials.session.id}`,
                    recovery: {
                      failureReason: "fresh durable session activation was not confirmed",
                      freshSessionDisposition: "ended",
                      freshGroupQuarantineDisposition: "quarantined",
                      recoveryRecordWritten: true,
                    },
                  });
                }),
              "lease-failure-during-provisioning": () =>
                Effect.gen(function* () {
                  yield* prepareNewRevisionTransition;
                  events.length = 0;
                  lastFreshSessionId = undefined;
                  lastCreatedFreshCredentials = undefined;
                  const provisioningLeaseBarrier = yield* makeLifecycleBarrier();
                  freshLifecycleBarriers = {
                    provisioning: provisioningLeaseBarrier,
                    staging: yield* makeLifecycleBarrier(),
                    activation: yield* makeLifecycleBarrier(),
                  };
                  failFreshLeaseHeartbeat = true;
                  const leaseFailureDuringProvisioning = yield* runShippedCli([
                    "preview",
                    "recreate",
                    "--config",
                    configPath,
                    "--session",
                    activeOldCredentials.session.id,
                    "--confirm-development",
                    "--json",
                  ]).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        failFreshLeaseHeartbeat = false;
                        freshLifecycleBarriers = undefined;
                      }),
                    ),
                    Effect.forkChild,
                  );
                  yield* Deferred.await(provisioningLeaseBarrier.started);
                  const provisioningFailureSessionId = requireSessionId(lastFreshSessionId);
                  yield* advanceLeaseFailureWindow();
                  expect(events).toContain("fresh-lease-heartbeat-failed");
                  yield* Deferred.succeed(provisioningLeaseBarrier.release, undefined);
                  const failedProvisioningOutput = requireCliOutput(
                    yield* Fiber.join(leaseFailureDuringProvisioning),
                    "expected provisioning-time lease failure JSON output",
                  );
                  expect(failedProvisioningOutput).toContain('"ok":false');
                  expect(events).toContain("quarantine-fresh-group");
                  expect(events).not.toContain("stage");
                  expect((yield* controller.status(provisioningFailureSessionId)).phase).toBe(
                    "pending",
                  );
                  expect((yield* controller.status(activeOldCredentials.session.id)).phase).toBe(
                    "ended",
                  );
                  const provisioningFailureRecovery = parseWorkflowRecreationRecoveryRecord(
                    yield* fileSystem.readFileString(
                      path.join(
                        credentialsDirectory,
                        `${provisioningFailureSessionId}.workflow-recreation-recovery.json`,
                      ),
                    ),
                  );
                  expect(provisioningFailureRecovery).toMatchObject({
                    oldCleanupRecordId: `cleanup-${activeOldCredentials.session.id}`,
                    freshSessionId: provisioningFailureSessionId,
                    recovery: {
                      failureReason: expect.stringContaining(
                        "fresh-session-lease-maintenance-unconfirmed",
                      ),
                      freshSessionDisposition: "pending-quarantined",
                      freshGroupQuarantineDisposition: "quarantined",
                      quarantineDisposition: "quarantined",
                      recoveryRecordWritten: true,
                      recoveryRecordUpdated: true,
                    },
                  });
                }),
              "fresh-stop-denied": () =>
                Effect.gen(function* () {
                  yield* runUnconfirmedFreshSessionStop("denied");
                }),
              "fresh-stop-failed": () =>
                Effect.gen(function* () {
                  yield* runUnconfirmedFreshSessionStop("failed");
                }),
              "fresh-stop-unreadable": () =>
                Effect.gen(function* () {
                  yield* runUnconfirmedFreshSessionStop("unreadable");
                }),
              "fresh-stop-generation-rotated": () =>
                Effect.gen(function* () {
                  yield* runUnconfirmedFreshSessionStop("generation-rotated");
                }),
              "expired-fresh-session-json": () =>
                Effect.gen(function* () {
                  yield* runExpiredFreshSessionProvisioningFailure(true);
                }),
              "expired-fresh-session-human": () =>
                Effect.gen(function* () {
                  yield* runExpiredFreshSessionProvisioningFailure(false);
                }),
              "expired-fresh-session-missing-end-time": () =>
                Effect.gen(function* () {
                  yield* runExpiredFreshSessionProvisioningFailure(true, "missing-end-time");
                }),
              "expired-fresh-session-wrong-generation": () =>
                Effect.gen(function* () {
                  yield* runExpiredFreshSessionProvisioningFailure(true, "wrong-generation");
                }),
            };

            const roleMismatchCases: Partial<
              Record<WorkflowRecreationScenario, ReadonlyArray<string>>
            > = {
              "role-missing-runner": ["workflow-api"],
              "role-duplicate-api": ["workflow-api", "workflow-api"],
              "role-api-only": ["workflow-api", "ordinary-runner"],
              "role-duplicate-browser": [
                "workflow-api",
                "ordinary-runner",
                "browser-runner",
                "browser-runner",
              ],
              "role-unsupported": ["workflow-api", "ordinary-runner", "unsupported-runner"],
            };
            const stagedRoleMismatch = roleMismatchCases[scenario];
            if (stagedRoleMismatch !== undefined) {
              providerResolution = (requestedConfig) =>
                Effect.succeed({
                  ...bindTestActivationEvidence(activation, requestedConfig),
                  roles: stagedRoleMismatch,
                });
              const roleMismatchOutput = yield* runShippedCli([
                "preview",
                "recreate",
                "--config",
                configPath,
                "--session",
                oldCredentials.session.id,
                "--confirm-development",
                "--json",
              ]);
              expect(roleMismatchOutput).toContain('"ok":false');
              expect(events).not.toContain("settle-old-code");
              expect(events).not.toContain("provision-fresh-session");
            }

            const scenarioHandlerScenario =
              scenario === "foreground-supervisor-stop-timeout" ||
              scenario === "foreground-supervisor-status-timeout"
                ? "same-snapshot-supervision"
                : scenario;
            const scenarioHandler = Object.entries(scenarioHandlers).find(
              ([name]) => name === scenarioHandlerScenario,
            )?.[1];
            if (scenarioHandler !== undefined) yield* scenarioHandler();
          }).pipe(Effect.ensuring(cleanupProviderFixture));
        }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
    ),
  );

const workflowRecreationScenarios: readonly WorkflowRecreationScenario[] = [
  "provider-status",
  "provider-module-outside-checkout",
  "provider-non-effect",
  "provider-malformed-runtime",
  "stale-catalog-evidence",
  "missing-change-declarations",
  "missing-required-group-closure",
  "unconfigured-proposed-group",
  "role-missing-runner",
  "role-duplicate-api",
  "role-api-only",
  "role-duplicate-browser",
  "role-unsupported",
  "compatible-transition",
  "successful-recreation",
  "legacy-api-only",
  "old-cleanup-binding-mismatch",
  "old-cleanup-provider-failure",
  "old-cleanup-record-empty",
  "old-cleanup-record-whitespace",
  "old-session-stop-json",
  "old-session-stop-human",
  "old-session-stop-timeout",
  "credential-persistence-failure",
  "credential-persistence-expired",
  "fresh-provider-failure",
  "sensitive-provider-failure",
  "fresh-binding-failure",
  "fresh-evidence-failure",
  "fresh-artifact-evidence-failure",
  "provider-timeout",
  "old-status-timeout",
  "human-recovery-output",
  "cached-state-fallback",
  "activation-failure",
  "same-snapshot-supervision",
  "foreground-supervisor-stop-timeout",
  "foreground-supervisor-status-timeout",
  "interruption-safe-lifecycle",
  "lease-failure-during-activation",
  "lease-failure-during-staging",
  "lease-failure-during-provisioning",
  "fresh-stop-denied",
  "fresh-stop-failed",
  "fresh-stop-unreadable",
  "fresh-stop-generation-rotated",
  "old-session-generation-rotated-before-stop",
  "old-code-cancellation",
  "unresolved-ambiguous-outcome",
  "expired-fresh-session-json",
  "expired-fresh-session-human",
  "expired-fresh-session-missing-end-time",
  "expired-fresh-session-wrong-generation",
];

for (const scenario of workflowRecreationScenarios)
  runConnectedWorkflowRecreationScenario(scenario);

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
    expect(cleanup.ok).toBe(false);
    expect(cleanup.readiness).toBe("blocked");
    expect(cleanup.errors[0]?.remediation).toContain("retry");
    const statusAfterCleanup = yield* connectedPreviewOutput(
      parsePreviewAction(["preview", "status", "--session", sessionId, "--json"], "status"),
      options,
    );
    expect(statusAfterCleanup.previewSession?.allocations?.resources[0]?.state).not.toBe("deleted");
    expect(statusAfterCleanup.previewSession?.allocations?.reservations[0]?.releasedAt).toBeNull();
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
          String(
            (
              rows[0] /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Record<
                string,
                unknown
              >
            ) /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */.id,
          ),
          fixture.options,
          fixture.sessions,
          fixture.allocations,
        );
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
  ),
);

const blockedPreviewActions: readonly [string, readonly string[]][] = [
  ["start", ["start", "--config", "/missing/preview.json"]],
  [
    "recreate",
    [
      "recreate",
      "--config",
      "/missing/preview.json",
      "--session",
      "session-123",
      "--confirm-development",
    ],
  ],
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

      const output = JSON.parse(
        result.stdout,
      ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
        readonly mode: string;
        readonly action: string;
        readonly readiness: string;
        readonly errors: readonly { readonly code: string }[];
      } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

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

            const created = JSON.parse(
              start.stdout,
            ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
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
            } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
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

            const credentials = JSON.parse(
              storedIdentity,
            ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
              readonly ownerIdentity: string;
              readonly supervisorIdentity: string;
            } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
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

            const beforeHeartbeat = JSON.parse(
              status.stdout,
            ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
              readonly previewSession: {
                readonly lastRenewedAt: number;
                readonly allocations?: { readonly resources: readonly unknown[] };
              };
              readonly readiness: string;
              readonly errors: readonly { readonly message: string }[];
            } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
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

            const fullStatusOutput = JSON.parse(
              fullStatus.stdout,
            ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
              readonly previewSession: {
                readonly lastRenewedAt: number;
                readonly allocations: { readonly resources: readonly unknown[] };
              };
            } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
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

            const waitingCleanupOutput = Schema.decodeUnknownSync(
              Schema.Struct({
                ok: Schema.Boolean,
                readiness: Schema.String,
                errors: Schema.Array(
                  Schema.Struct({ message: Schema.String, remediation: Schema.String }),
                ),
              }),
            )(JSON.parse(waitingCleanup.stdout));
            expect(waitingCleanupOutput.ok).toBe(false);
            expect(waitingCleanupOutput.readiness).toBe("blocked");
            expect(waitingCleanupOutput.errors[0]?.message).toContain("proof");
            const observedWaitingCleanup = yield* Effect.tryPromise({
              try: () => runLauncher(["preview", "status", "--session", id, "--json"], options),
              catch: (cause) => cause,
            });
            const observedWaitingCleanupOutput = Schema.decodeUnknownSync(
              Schema.Struct({
                previewSession: Schema.Struct({
                  allocations: Schema.Struct({ cleanup: Schema.String }),
                }),
              }),
            )(JSON.parse(observedWaitingCleanup.stdout));
            expect(observedWaitingCleanupOutput.previewSession.allocations.cleanup).toBe(
              "quarantined",
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

            const resolvedOutput = Schema.decodeUnknownSync(
              Schema.Struct({
                ok: Schema.Boolean,
                readiness: Schema.String,
                previewSession: Schema.Struct({
                  allocations: Schema.Struct({ cleanup: Schema.String }),
                }),
                errors: Schema.Array(Schema.Unknown),
                warnings: Schema.Array(Schema.Struct({ message: Schema.String })),
              }),
            )(JSON.parse(resolved.stdout));
            expect(resolvedOutput.ok).toBe(true);
            expect(resolvedOutput.readiness).toBe("completed");
            expect(resolvedOutput.previewSession.allocations.cleanup).toBe("waiting");
            expect(resolvedOutput.errors).toEqual([]);
            expect(resolvedOutput.warnings[0]?.message).toContain("Cleanup is waiting");
            const resolution =
              yield* sql`SELECT provider_resource_id, outcome FROM preview_allocation_resolutions WHERE session_id=${id} AND resource='auth'`;
            expect(resolution).toHaveLength(1);

            const resolutionRows = yield* Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  provider_resource_id: Schema.NullOr(Schema.String),
                  outcome: Schema.Literals(["found", "absent"]),
                }),
              ),
            )(resolution);
            expect(resolutionRows[0]?.provider_resource_id).toBe(resourcePath);
            expect(resolutionRows[0]?.outcome).toBe("found");
            clock.value = Date.now();
            yield* sql`UPDATE preview_cleanup_state SET proof_at=${clock.value - 5 * 60_000} WHERE session_id=${id}`;
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
            yield* sql`UPDATE preview_cleanup_state SET proof_at=${clock.value - 5 * 60_000} WHERE session_id=${secondSession.session.id}`;
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

          const output = JSON.parse(
            result.stdout,
          ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
            readonly previewSession: { readonly id: string; readonly phase: string };
          } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
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

it.effect("retains mixed gateway causes in resumed session cleanup", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "mixed-cleanup-owner",
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
    const gatewayBase = yield* makePreviewGateway({ domain: "", controller, now });
    const gatewayFailure = new PreviewGatewayError({ reason: "unavailable" });
    const adapterDefect = new Error("resumed-route-adapter-defect");
    const gateway: PreviewGatewayApi = {
      ...gatewayBase,
      cleanupSession: () =>
        Effect.failCause(Cause.combine(Cause.fail(gatewayFailure), Cause.die(adapterDefect))),
    };

    const exit = yield* Effect.exit(
      stopResumedWebSession(
        created.session.id,
        created.supervisorIdentity,
        created.session.generation,
        { ownerIdentity: created.ownerIdentity, supervisorIdentity: created.supervisorIdentity },
        controller,
        gateway,
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (Exit.isFailure(exit)) {
      const defect = Cause.findDefect(exit.cause);
      expect(defect._tag).toBe("Success");
      if (defect._tag === "Success" && defect.success instanceof Error) {
        expect(defect.success.message).toBe("Cleanup failed with an unrecoverable cause.");
        expect(defect.success.message).not.toContain(adapterDefect.message);
        expect(Cause.isCause(defect.success.cause)).toBe(true);
        if (Cause.isCause(defect.success.cause)) {
          expect(Cause.hasFails(defect.success.cause)).toBe(true);
          expect(Cause.hasDies(defect.success.cause)).toBe(true);
          expect(
            defect.success.cause.reasons.some(
              (reason) => Cause.isDieReason(reason) && reason.defect === adapterDefect,
            ),
          ).toBe(true);
        }
      }
    }
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
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

it.effect("preserves pure interruption through resumed cleanup wrappers", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const gatewayBase = yield* makePreviewGateway({ domain: "", controller, now });
    const gatewayInterrupted: PreviewGatewayApi = {
      ...gatewayBase,
      cleanupSession: () => Effect.interrupt,
    };
    const gatewaySession = yield* controller.create({
      owner: "resumed-gateway-interruption",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      gatewaySession.session.id,
      gatewaySession.session.generation,
      gatewaySession.supervisorIdentity,
      "revision-a",
    );

    const gatewayExit = yield* Effect.exit(
      stopResumedWebSession(
        gatewaySession.session.id,
        gatewaySession.supervisorIdentity,
        gatewaySession.session.generation,
        {
          ownerIdentity: gatewaySession.ownerIdentity,
          supervisorIdentity: gatewaySession.supervisorIdentity,
        },
        controller,
        gatewayInterrupted,
      ),
    );
    expect(Exit.isFailure(gatewayExit)).toBe(true);
    if (Exit.isFailure(gatewayExit)) expect(Cause.hasInterruptsOnly(gatewayExit.cause)).toBe(true);

    const runtimeSession = yield* controller.create({
      owner: "resumed-runtime-interruption",
      checkout: "/checkout",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      runtimeSession.session.id,
      runtimeSession.session.generation,
      runtimeSession.supervisorIdentity,
      "revision-a",
    );
    const gatewayConfirmed: PreviewGatewayApi = {
      ...gatewayBase,
      cleanupSession: () => Effect.void,
    };
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.interrupt,
    } satisfies PreviewWebRuntimeApi;
    const runtimeExit = yield* Effect.exit(
      stopResumedWebSession(
        runtimeSession.session.id,
        runtimeSession.supervisorIdentity,
        runtimeSession.session.generation,
        {
          ownerIdentity: runtimeSession.ownerIdentity,
          supervisorIdentity: runtimeSession.supervisorIdentity,
        },
        controller,
        gatewayConfirmed,
        runtime,
      ),
    );
    expect(Exit.isFailure(runtimeExit)).toBe(true);
    if (Exit.isFailure(runtimeExit)) expect(Cause.hasInterruptsOnly(runtimeExit.cause)).toBe(true);
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

it.effect("preserves pure interruption from resumed runtime cleanup", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "resumed-runtime-stop-interruption",
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
    const gatewayBase = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = { ...gatewayBase, cleanupSession: () => Effect.void };
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.interrupt,
    } satisfies PreviewWebRuntimeApi;

    const exit = yield* Effect.exit(
      stopResumedWebSession(
        created.session.id,
        created.supervisorIdentity,
        created.session.generation,
        { ownerIdentity: created.ownerIdentity, supervisorIdentity: created.supervisorIdentity },
        controller,
        gateway,
        runtime,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
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

it.effect("continues sheet-web supervision after a stalled status read", () =>
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
    const stalledStatusStarted = yield* Deferred.make<void>();
    const secondHeartbeat = yield* Deferred.make<void>();
    let heartbeatCalls = 0;
    let statusCalls = 0;
    let processStops = 0;
    const stalledStatusController: PreviewSessionControllerApi = {
      ...controller,
      heartbeat: () => {
        heartbeatCalls += 1;
        const failed = Effect.fail(
          new PreviewSessionError({ reason: "transient-controller-failure" }),
        );
        return heartbeatCalls === 2
          ? Deferred.succeed(secondHeartbeat, undefined).pipe(Effect.andThen(failed))
          : failed;
      },
      status: (id) => {
        if (id !== created.session.id) return controller.status(id);
        statusCalls += 1;
        if (statusCalls === 1)
          return Deferred.succeed(stalledStatusStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          );
        return controller.status(id);
      },
    };
    const gateway = yield* makePreviewGateway({ domain: "", controller, now });
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.sync(() => void processStops++),
    } satisfies PreviewWebRuntimeApi;
    const supervisor = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      controller: stalledStatusController,
      gateway,
      runtime,
    }).pipe(Effect.forkChild);
    const resumed = yield* Deferred.await(secondHeartbeat).pipe(
      Effect.timeoutOption(Duration.millis(previewSessionHeartbeatMs * 4)),
      Effect.forkChild,
    );

    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    yield* Deferred.await(stalledStatusStarted);
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;

    const continued = yield* Fiber.join(resumed);
    yield* Fiber.interrupt(supervisor);
    expect(Option.isSome(continued)).toBe(true);
    expect(heartbeatCalls).toBeGreaterThanOrEqual(2);
    expect(statusCalls).toBeGreaterThanOrEqual(2);
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
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

it.effect("counts a stalled dependency status as a sheet-web health failure", () =>
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
    const stalledStatusStarted = yield* Deferred.make<void>();
    const secondDependencyCheck = yield* Deferred.make<void>();
    let dependencyChecks = 0;
    let statusCalls = 0;
    let processStops = 0;
    const stalledStatusController: PreviewSessionControllerApi = {
      ...controller,
      status: (id) => {
        if (id !== created.session.id) return controller.status(id);
        statusCalls += 1;
        if (statusCalls === 1)
          return Deferred.succeed(stalledStatusStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          );
        return controller.status(id);
      },
    };
    const gateway = yield* makePreviewGateway({ domain: "", controller, now });
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.sync(() => void processStops++),
    } satisfies PreviewWebRuntimeApi;
    const supervisor = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      controller: stalledStatusController,
      gateway,
      runtime,
      checkDependencies: () => {
        dependencyChecks += 1;
        const failed = Effect.fail(new Error("dependency unavailable"));
        return dependencyChecks === 2
          ? Deferred.succeed(secondDependencyCheck, undefined).pipe(Effect.andThen(failed))
          : failed;
      },
    }).pipe(Effect.forkChild);
    const continued = yield* Deferred.await(secondDependencyCheck).pipe(
      Effect.timeoutOption(Duration.millis(previewSessionHeartbeatMs * 4)),
      Effect.forkChild,
    );

    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    yield* Deferred.await(stalledStatusStarted);
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
    yield* Effect.yieldNow;

    const reachedSecondCheck = yield* Fiber.join(continued);
    yield* Fiber.interrupt(supervisor);
    expect(Option.isSome(reachedSecondCheck)).toBe(true);
    expect(dependencyChecks).toBe(3);
    expect(statusCalls).toBe(3);
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
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

it.effect("does not clean sheet-web resources without confirmed stop ownership", () =>
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
    const cleanupStatusStarted = yield* Deferred.make<void>();
    let statusCalls = 0;
    let routeCleanupCalls = 0;
    let processStops = 0;
    const uncertainController: PreviewSessionControllerApi = {
      ...controller,
      heartbeat: () =>
        Effect.fail(new PreviewSessionError({ reason: "transient-controller-failure" })),
      stopSupervised: () =>
        Effect.fail(new PreviewSessionError({ reason: "supervised-session-stop-unconfirmed" })),
      status: (id) => {
        if (id !== created.session.id) return controller.status(id);
        statusCalls += 1;
        if (statusCalls === 4)
          return Deferred.succeed(cleanupStatusStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          );
        return controller.status(id);
      },
    };
    const actualGateway = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = {
      ...actualGateway,
      cleanupSession: () => Effect.sync(() => void routeCleanupCalls++),
    };
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.sync(() => void processStops++),
    } satisfies PreviewWebRuntimeApi;
    const supervisor = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      controller: uncertainController,
      gateway,
      runtime,
    }).pipe(Effect.forkChild);

    for (let failure = 0; failure < previewSessionHeartbeatFailureLimit; failure += 1) {
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
    }
    yield* Deferred.await(cleanupStatusStarted);
    const completed = yield* Fiber.join(supervisor).pipe(
      Effect.timeoutOption(Duration.seconds(70)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(70));
    yield* Effect.yieldNow;
    const completedWithinBudget = yield* Fiber.join(completed);
    const cleanupCallsBeforeInterrupt = {
      route: routeCleanupCalls,
      process: processStops,
    };
    if (Option.isNone(completedWithinBudget)) yield* Fiber.interrupt(supervisor);
    yield* TestClock.adjust(Duration.millis(previewSessionLeaseMs));

    expect(Option.isSome(completedWithinBudget)).toBe(true);
    expect(cleanupCallsBeforeInterrupt).toEqual({ route: 0, process: 0 });
    expect(statusCalls).toBe(4);
    expect((yield* controller.status(created.session.id)).phase).toBe("expired");
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

it.effect("bounds total sheet-web cleanup after supervisor ownership is confirmed", () =>
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

    const cleanupStarted = yield* Deferred.make<number>();
    let routeCleanupCalls = 0;
    let processStopCalls = 0;
    let supervisorCompletedAt: number | undefined;
    const failingController: PreviewSessionControllerApi = {
      ...controller,
      heartbeat: () =>
        Effect.fail(new PreviewSessionError({ reason: "transient-controller-failure" })),
    };
    const actualGateway = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = {
      ...actualGateway,
      cleanupSession: () =>
        Effect.sync(() => {
          routeCleanupCalls += 1;
          if (routeCleanupCalls === 1) return Deferred.succeed(cleanupStarted, now());
          return Effect.void;
        }).pipe(Effect.flatten, Effect.andThen(Effect.never)),
    };
    const runtime = {
      start: () => Effect.fail(new PreviewWebRuntimeError({ reason: "unused" })),
      status: () => Effect.succeed(true),
      measurements: () => Effect.succeed(undefined),
      stop: () => Effect.sync(() => void processStopCalls++).pipe(Effect.andThen(Effect.never)),
    } satisfies PreviewWebRuntimeApi;
    const supervisor = yield* superviseSheetWebPreview({
      sessionId: created.session.id,
      ownerIdentity: created.ownerIdentity,
      supervisorIdentity: created.supervisorIdentity,
      generation: created.session.generation,
      controller: failingController,
      gateway,
      runtime,
    }).pipe(
      Effect.tap(() => Effect.sync(() => (supervisorCompletedAt = now()))),
      Effect.forkChild,
    );

    for (let failure = 0; failure < previewSessionHeartbeatFailureLimit; failure += 1) {
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(previewSessionHeartbeatMs));
      yield* Effect.yieldNow;
    }
    const deletionStartedAt = yield* Deferred.await(cleanupStarted);
    yield* TestClock.adjust(Duration.minutes(5));
    yield* Effect.yieldNow;
    const completedAtDeadline = supervisorCompletedAt;

    // Let the pre-fix ten-attempt loop finish naturally so a red run leaves no child fiber behind.
    yield* TestClock.adjust(Duration.seconds(1_210));
    yield* Effect.yieldNow;
    yield* Fiber.join(supervisor);

    expect(completedAtDeadline).toBeDefined();
    if (completedAtDeadline === undefined) return;
    expect(completedAtDeadline - deletionStartedAt).toBeLessThanOrEqual(
      Duration.toMillis(Duration.minutes(5)),
    );
    expect(routeCleanupCalls).toBeGreaterThan(0);
    expect(processStopCalls).toBeGreaterThan(0);
    expect((yield* controller.status(created.session.id)).phase).toBe("ended");
    expect(
      (yield* TestConsole.errorLines).some(
        (line) =>
          typeof line === "string" &&
          line.includes("five-minute deletion budget") &&
          line.includes("not confirmed"),
      ),
    ).toBe(true);
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

it.live("bounds the public cleanup command across gateway and allocation teardown", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "cleanup-owner",
      checkout: "/tmp/explicit-cleanup-deadline",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "cleanup-revision",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "cleanup-revision",
    );
    const allocations = yield* makePreviewAllocationController(
      {
        planProfile: () => Effect.fail(new Error("unused")),
        validateProfileAllocation: () => Effect.void,
        allocate: () => Effect.succeed("owned-resource"),
        deleteOwned: () => Effect.void,
        proveCleanup: () => Effect.succeed(true),
        resolveUnknown: () => Effect.fail(new Error("unused")),
      },
      now,
      undefined,
      true,
      10 * 60_000,
    );
    yield* Effect.forEach(previewCapacityDimensionsByGroup.auth, (dimension) =>
      allocations.observeCapacity({
        provider: "local-test",
        identity: "disposable",
        dimension,
        observedAt: now(),
        total: 1,
        inUse: 0,
        grantsVerified: true,
      }),
    );
    yield* allocations.reserveAndAllocate({
      sessionId: created.session.id,
      demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
        dimension,
        amount: 1,
        provider: "local-test",
        identity: "disposable",
      })),
      resources: ["auth"],
    });
    yield* controller.stop(created.session.id, created.ownerIdentity);
    expect(yield* allocations.cleanup({ sessionId: created.session.id })).toBe("waiting");
    yield* TestClock.adjust(Duration.minutes(5));

    const sessionDatabase = path.join("/tmp", `preview-cleanup-${randomUUID()}.sqlite`);
    const credentialsDirectory = `${sessionDatabase}.credentials`;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(credentialsDirectory, { recursive: true, mode: 0o700 });
    yield* fileSystem.writeFileString(
      path.join(credentialsDirectory, created.session.id),
      JSON.stringify({
        ownerIdentity: created.ownerIdentity,
        supervisorIdentity: created.supervisorIdentity,
      }),
      { mode: 0o600 },
    );
    const routeCleanupStarted = yield* Deferred.make<void>();
    const actualGateway = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = {
      ...actualGateway,
      cleanupSession: () =>
        Deferred.succeed(routeCleanupStarted, undefined).pipe(Effect.andThen(Effect.never)),
    };
    const command = parsePreviewAction(
      ["preview", "cleanup", "--session", created.session.id, "--json"],
      "cleanup",
    );
    const cleanup = yield* connectedPreviewOutput(command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: sessionDatabase },
      previewSessionController: controller,
      previewAllocationController: allocations,
      previewGateway: gateway,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(routeCleanupStarted);
    yield* TestClock.adjust(Duration.minutes(5));
    yield* Effect.yieldNow;
    const observed = yield* Fiber.join(cleanup).pipe(
      Effect.timeoutOption(Duration.seconds(1)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(1));
    const completed = yield* Fiber.join(observed);
    if (Option.isNone(completed)) yield* Fiber.interrupt(cleanup);

    expect(Option.isSome(completed)).toBe(true);
    if (Option.isNone(completed)) return;
    expect(completed.value.ok).toBe(false);
    expect(completed.value.previewSession?.allocations?.cleanup).toBe("quarantined");
    const state = yield* allocations.inspect(created.session.id);
    expect(state.allocations[0]?.state).toBe("owned");
    expect(state.reservations[0]?.releasedAt).toBeNull();
    yield* fileSystem.remove(credentialsDirectory, { recursive: true, force: true });
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

it.live("bounds quarantine persistence and inspection after the cleanup deadline", () =>
  Effect.gen(function* () {
    let cleanupCompletedAt: number | undefined;
    const runUnresponsiveReport = (owner: string, stallWrite: boolean) =>
      makeCleanupReportFixture(owner).pipe(
        Effect.flatMap((f) =>
          Effect.gen(function* () {
            cleanupCompletedAt = undefined;
            const startedAt = f.now();
            const gatewayCleanupStarted = yield* Deferred.make<void>();
            const reportStepStarted = yield* Deferred.make<void>();
            const gateway: PreviewGatewayApi = {
              ...f.gateway,
              cleanupSession: () =>
                Deferred.succeed(gatewayCleanupStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                ),
            };
            const allocations: PreviewAllocationApi = {
              ...f.allocations,
              markCleanupUnconfirmed: (input) =>
                stallWrite
                  ? Deferred.succeed(reportStepStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    )
                  : f.allocations.markCleanupUnconfirmed(input),
              inspect: (sessionId) =>
                stallWrite
                  ? f.allocations.inspect(sessionId)
                  : Deferred.succeed(reportStepStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    ),
            };
            const cleanup = yield* connectedPreviewOutput(f.command, {
              env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
              previewSessionController: f.controller,
              previewAllocationController: allocations,
              previewGateway: gateway,
            }).pipe(
              Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))),
              Effect.forkChild,
            );
            yield* Deferred.await(gatewayCleanupStarted);
            yield* TestClock.adjust(Duration.minutes(5));
            yield* Effect.yieldNow;
            yield* Deferred.await(reportStepStarted);
            const observedFiber = yield* Fiber.join(cleanup).pipe(
              Effect.timeoutOption(Duration.seconds(1)),
              Effect.forkChild,
            );
            yield* TestClock.adjust(Duration.seconds(1));
            yield* Effect.yieldNow;
            const observed = yield* Fiber.join(observedFiber);
            if (Option.isNone(observed)) yield* Fiber.interrupt(cleanup);
            yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
            return {
              observed,
              elapsedMs:
                cleanupCompletedAt === undefined ? undefined : cleanupCompletedAt - startedAt,
            };
          }),
        ),
      );

    const stalledWrite = yield* runUnresponsiveReport("cleanup-report-stalled-write", true);
    const stalledInspect = yield* runUnresponsiveReport("cleanup-report-stalled-inspect", false);
    expect(Option.isSome(stalledWrite.observed)).toBe(true);
    expect(Option.isSome(stalledInspect.observed)).toBe(true);
    expect(stalledWrite.elapsedMs).toBeLessThanOrEqual(Duration.toMillis(Duration.minutes(5)));
    expect(stalledInspect.elapsedMs).toBeLessThanOrEqual(Duration.toMillis(Duration.minutes(5)));
    if (Option.isSome(stalledWrite.observed)) {
      expect(stalledWrite.observed.value.ok).toBe(false);
      expect(stalledWrite.observed.value.errors[0]?.message).toContain(
        "reservation state is unknown",
      );
    }
    if (Option.isSome(stalledInspect.observed)) {
      expect(stalledInspect.observed.value.ok).toBe(false);
      expect(stalledInspect.observed.value.errors[0]?.message).toContain(
        "reservation state is unknown",
      );
    }
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

it.live("charges a delayed first deletion-timing update to the post-proof deadline", () =>
  Effect.gen(function* () {
    const timingUpdateStarted = yield* Deferred.make<void>();
    const releaseTimingUpdate = yield* Deferred.make<void>();
    const deletionStarted = yield* Deferred.make<void>();
    let deleteCalls = 0;
    let delayTimingUpdate = true;
    const f = yield* makeCleanupReportFixture("cleanup-delayed-first-timing-write", {
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
      adapter: {
        deleteOwned: () =>
          Effect.gen(function* () {
            deleteCalls += 1;
            yield* Deferred.succeed(deletionStarted, undefined);
            yield* Effect.never;
          }),
      },
      sqlDecorator: (sql) =>
        new Proxy(sql, {
          apply: (target, thisArgument, argumentsList) => {
            const statement = Reflect.apply(target, thisArgument, argumentsList);
            const [query] = statement.compile();
            if (
              !delayTimingUpdate ||
              !query.includes("UPDATE preview_cleanup_timing") ||
              !query.includes("SET deletion_started_at = CASE")
            )
              return statement;
            delayTimingUpdate = false;
            return Effect.gen(function* () {
              const rows = yield* statement;
              yield* Deferred.succeed(timingUpdateStarted, undefined);
              yield* Deferred.await(releaseTimingUpdate);
              return rows;
            });
          },
        }),
    });
    const cleanupStartedAt = f.now();
    let cleanupCompletedAt: number | undefined;
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: f.allocations,
      previewGateway: f.gateway,
    })
      .pipe(Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))))
      .pipe(Effect.forkChild);

    yield* Deferred.await(timingUpdateStarted);
    yield* TestClock.adjust(Duration.seconds(294));
    yield* Deferred.succeed(releaseTimingUpdate, undefined);
    yield* Deferred.await(deletionStarted);
    expect(deleteCalls).toBe(1);
    yield* TestClock.adjust(Duration.seconds(1));
    const completion = yield* Fiber.join(cleanup).pipe(
      Effect.timeoutOption(Duration.seconds(1)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(1));
    const observed = yield* Fiber.join(completion);
    if (Option.isNone(observed)) yield* Fiber.interrupt(cleanup);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });

    expect(Option.isSome(observed)).toBe(true);
    if (Option.isNone(observed)) return;
    expect(observed.value.ok).toBe(false);
    expect(observed.value.readiness).toBe("blocked");
    expect(observed.value.errors[0]?.code).toBe("cleanup-failed");
    expect(observed.value.errors[0]?.message).toContain(
      "Capacity reservations recorded as held: 4; released: 0.",
    );
    expect(observed.value.previewSession?.allocations?.cleanup).toBe("quarantined");
    expect(
      observed.value.previewSession?.allocations?.cleanupTiming?.deletionAttempt.elapsedMs,
    ).toBeLessThanOrEqual(Duration.toMillis(Duration.minutes(5)));
    expect(cleanupCompletedAt).toBeDefined();
    if (cleanupCompletedAt === undefined) return;
    expect(cleanupCompletedAt - cleanupStartedAt).toBeLessThanOrEqual(
      Duration.toMillis(Duration.minutes(5)),
    );
    const state = yield* f.allocations.inspect(f.created.session.id);
    expect(state.allocations[0]?.state).toBe("quarantined");
    expect(state.reservations[0]?.releasedAt).toBe(null);
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

it.live("bounds the first timing update by an existing deletion deadline", () =>
  Effect.gen(function* () {
    const timingUpdateStarted = yield* Deferred.make<void>();
    const releaseTimingUpdate = yield* Deferred.make<void>();
    let deleteCalls = 0;
    let delayTimingUpdate = false;
    const f = yield* makeCleanupReportFixture("cleanup-active-deletion-timing-write", {
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
      adapter: {
        deleteOwned: () => Effect.sync(() => void deleteCalls++),
      },
      sqlDecorator: (sql) =>
        new Proxy(sql, {
          apply: (target, thisArgument, argumentsList) => {
            const statement = Reflect.apply(target, thisArgument, argumentsList);
            const [query] = statement.compile();
            if (
              !delayTimingUpdate ||
              !query.includes("UPDATE preview_cleanup_timing") ||
              !query.includes("SET deletion_started_at = CASE")
            )
              return statement;
            delayTimingUpdate = false;
            return Effect.gen(function* () {
              const rows = yield* statement;
              yield* Deferred.succeed(timingUpdateStarted, undefined);
              yield* Deferred.await(releaseTimingUpdate);
              return rows;
            });
          },
        }),
    });
    const sql = yield* SqlClient.SqlClient;
    const deletionStartedAt = f.now();
    yield* sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;
    yield* TestClock.adjust(Duration.seconds(290));
    delayTimingUpdate = true;

    let cleanupCompletedAt: number | undefined;
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: f.allocations,
      previewGateway: f.gateway,
    })
      .pipe(Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))))
      .pipe(Effect.forkChild);

    yield* Deferred.await(timingUpdateStarted);
    yield* TestClock.adjust(Duration.seconds(20));
    yield* Deferred.succeed(releaseTimingUpdate, undefined);
    const result = yield* Fiber.join(cleanup);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });

    expect(result.ok).toBe(false);
    expect(result.readiness).toBe("blocked");
    expect(result.errors[0]?.code).toBe("cleanup-failed");
    expect(result.errors[0]?.message).toContain(
      "Capacity reservations recorded as held: 4; released: 0.",
    );
    expect(deleteCalls).toBe(0);
    expect(cleanupCompletedAt).toBeDefined();
    if (cleanupCompletedAt === undefined) return;
    expect(cleanupCompletedAt - deletionStartedAt).toBeLessThanOrEqual(
      Duration.toMillis(Duration.minutes(5)) + Duration.toMillis(Duration.seconds(5)),
    );
    const state = yield* f.allocations.inspect(f.created.session.id);
    expect(state.reservations[0]?.releasedAt).toBe(null);
    expect(state.cleanupTiming?.deletionAttempt.startedAt).toBe(deletionStartedAt);
    expect(state.cleanupTiming?.deletionAttempt.status).toBe("expired");
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

it.live("reports held cleanup when the first post-proof timing write stalls", () =>
  Effect.gen(function* () {
    const timingUpdateStarted = yield* Deferred.make<void>();
    let deleteCalls = 0;
    let delayTimingUpdate = true;
    const f = yield* makeCleanupReportFixture("cleanup-stalled-first-timing-write", {
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
      adapter: {
        deleteOwned: () => Effect.sync(() => void deleteCalls++),
      },
      sqlDecorator: (sql) =>
        new Proxy(sql, {
          apply: (target, thisArgument, argumentsList) => {
            const statement = Reflect.apply(target, thisArgument, argumentsList);
            const [query] = statement.compile();
            if (
              !delayTimingUpdate ||
              !query.includes("UPDATE preview_cleanup_timing") ||
              !query.includes("SET deletion_started_at = CASE")
            )
              return statement;
            delayTimingUpdate = false;
            return Effect.gen(function* () {
              yield* statement;
              yield* Deferred.succeed(timingUpdateStarted, undefined);
              return yield* Effect.never;
            });
          },
        }),
    });
    const cleanupStartedAt = f.now();
    let cleanupCompletedAt: number | undefined;
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: f.allocations,
      previewGateway: f.gateway,
    })
      .pipe(Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))))
      .pipe(Effect.forkChild);

    yield* Deferred.await(timingUpdateStarted);
    yield* TestClock.adjust(Duration.minutes(5));
    const completion = yield* Fiber.join(cleanup).pipe(
      Effect.timeoutOption(Duration.seconds(1)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(1));
    const observed = yield* Fiber.join(completion);
    if (Option.isNone(observed)) yield* Fiber.interrupt(cleanup);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });

    expect(Option.isSome(observed)).toBe(true);
    if (Option.isNone(observed)) return;
    expect(observed.value.ok).toBe(false);
    expect(observed.value.readiness).toBe("blocked");
    expect(observed.value.errors[0]?.code).toBe("cleanup-failed");
    expect(observed.value.errors[0]?.message).toContain(
      "Capacity reservations recorded as held: 4; released: 0.",
    );
    expect(observed.value.previewSession?.allocations?.cleanup).toBe("quarantined");
    expect(deleteCalls).toBe(0);
    expect(
      observed.value.previewSession?.allocations?.cleanupTiming?.deletionAttempt.elapsedMs,
    ).toBeLessThanOrEqual(Duration.toMillis(Duration.minutes(5)));
    expect(cleanupCompletedAt).toBeDefined();
    if (cleanupCompletedAt === undefined) return;
    expect(cleanupCompletedAt - cleanupStartedAt).toBeLessThanOrEqual(
      Duration.toMillis(Duration.minutes(5)),
    );
    const state = yield* f.allocations.inspect(f.created.session.id);
    expect(state.allocations[0]?.state).toBe("owned");
    expect(state.reservations[0]?.releasedAt).toBe(null);
    expect(state.cleanupTiming?.deletionAttempt.status).toBe("expired");
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

it.live("keeps stalled inspection within the persisted deletion deadline", () =>
  Effect.gen(function* () {
    const reportInspectionStarted = yield* Deferred.make<void>();
    let stallReportInspection = false;
    let deleteCalls = 0;
    const f = yield* makeCleanupReportFixture("cleanup-report-active-deletion-deadline", {
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
      adapter: {
        deleteOwned: () => Effect.sync(() => void deleteCalls++),
      },
      sqlDecorator: (sql) =>
        new Proxy(sql, {
          apply: (target, thisArgument, argumentsList) => {
            const statement = Reflect.apply(target, thisArgument, argumentsList);
            const [query] = statement.compile();
            if (
              !stallReportInspection ||
              !query.includes("SELECT * FROM preview_capacity_reservations WHERE session_id")
            )
              return statement;
            stallReportInspection = false;
            return Effect.gen(function* () {
              yield* Deferred.succeed(reportInspectionStarted, undefined);
              return yield* Effect.never;
            });
          },
        }),
    });
    const sql = yield* SqlClient.SqlClient;
    const proofRows =
      yield* sql`SELECT proof_at FROM preview_cleanup_state WHERE session_id=${f.created.session.id}`;
    const decodedProofRows = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ proof_at: Schema.Number })),
    )(proofRows);
    const proofAt = decodedProofRows[0]?.proof_at;
    expect(proofAt).toBeDefined();
    if (proofAt === undefined) return;
    yield* TestClock.adjust(Duration.seconds(299));

    const deletionStartedAt = proofAt + Duration.toMillis(Duration.minutes(5));
    const deletionDeadlineAt = deletionStartedAt + Duration.toMillis(Duration.minutes(5));
    yield* sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;
    expect(deletionDeadlineAt - f.now()).toBe(Duration.toMillis(Duration.seconds(1)));
    stallReportInspection = true;

    let cleanupCompletedAt: number | undefined;
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: f.allocations,
      previewGateway: f.gateway,
    })
      .pipe(Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))))
      .pipe(Effect.forkChild);

    yield* Deferred.await(reportInspectionStarted);
    yield* TestClock.adjust(Duration.seconds(5));
    yield* Effect.yieldNow;
    const result = yield* Fiber.join(cleanup);
    const state = yield* f.allocations.inspect(f.created.session.id);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });

    expect(result.ok).toBe(false);
    expect(result.readiness).toBe("blocked");
    expect(result.errors[0]?.message).toContain("reservation state is unknown");
    expect(deleteCalls).toBe(0);
    expect(state.allocations[0]?.state).toBe("owned");
    expect(state.reservations[0]?.releasedAt).toBe(null);
    expect(state.cleanupTiming?.deletionAttempt.startedAt).toBe(deletionStartedAt);
    expect(cleanupCompletedAt).toBeDefined();
    if (cleanupCompletedAt === undefined) return;
    expect(cleanupCompletedAt).toBeLessThanOrEqual(deletionDeadlineAt);
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

it.live("does not extend a deletion deadline across the cleanup result handoff", () =>
  Effect.gen(function* () {
    const reportInspectionStarted = yield* Deferred.make<void>();
    let inspectionCalls = 0;
    let deleteCalls = 0;
    const f = yield* makeCleanupReportFixture("cleanup-report-handoff-deadline", {
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
      adapter: {
        deleteOwned: () => Effect.sync(() => void deleteCalls++),
      },
    });
    const sql = yield* SqlClient.SqlClient;
    const proofRows =
      yield* sql`SELECT proof_at FROM preview_cleanup_state WHERE session_id=${f.created.session.id}`;
    const decodedProofRows = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ proof_at: Schema.Number })),
    )(proofRows);
    const proofAt = decodedProofRows[0]?.proof_at;
    expect(proofAt).toBeDefined();
    if (proofAt === undefined) return;
    yield* TestClock.adjust(Duration.seconds(299));

    const deletionStartedAt = proofAt + Duration.toMillis(Duration.minutes(5));
    const deletionDeadlineAt = deletionStartedAt + Duration.toMillis(Duration.minutes(5));
    yield* sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;
    expect(deletionDeadlineAt - f.now()).toBe(Duration.toMillis(Duration.seconds(1)));

    const allocationsWithHandoffPause: PreviewAllocationApi = {
      ...f.allocations,
      cleanupWithDeadline: (input) =>
        f.allocations
          .cleanupWithDeadline(input)
          .pipe(
            Effect.flatMap((result) =>
              TestClock.adjust(Duration.seconds(2)).pipe(Effect.as(result)),
            ),
          ),
      inspect: () =>
        Effect.gen(function* () {
          inspectionCalls += 1;
          yield* Deferred.succeed(reportInspectionStarted, undefined);
          return yield* Effect.never;
        }),
    };
    const cleanupStartedAt = f.now();
    let cleanupCompletedAt: number | undefined;
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: allocationsWithHandoffPause,
      previewGateway: f.gateway,
    })
      .pipe(Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))))
      .pipe(Effect.forkChild);

    const firstResult = yield* Effect.race(
      Deferred.await(reportInspectionStarted).pipe(Effect.as("inspection" as const)),
      Fiber.join(cleanup).pipe(Effect.map((result) => ({ _tag: "completed" as const, result }))),
    );
    let result: LauncherOutput;
    if (firstResult === "inspection") {
      yield* TestClock.adjust(Duration.seconds(1));
      result = yield* Fiber.join(cleanup);
    } else {
      result = firstResult.result;
    }
    const state = yield* f.allocations.inspect(f.created.session.id);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });

    expect(result.ok).toBe(false);
    expect(result.readiness).toBe("blocked");
    expect(result.errors[0]?.message).toContain("reservation state is unknown");
    expect(inspectionCalls).toBe(0);
    expect(deleteCalls).toBe(0);
    expect(state.allocations[0]?.state).toBe("owned");
    expect(state.reservations[0]?.releasedAt).toBe(null);
    expect(state.cleanupTiming?.deletionAttempt.startedAt).toBe(deletionStartedAt);
    expect(cleanupCompletedAt).toBe(cleanupStartedAt + Duration.toMillis(Duration.seconds(2)));
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

it.live("keeps typed cleanup failure reporting within a persisted deletion deadline", () =>
  Effect.gen(function* () {
    const reportInspectionStarted = yield* Deferred.make<void>();
    let proofSucceeds = true;
    let failProofFenceWrite = false;
    let deleteCalls = 0;
    const f = yield* makeCleanupReportFixture("cleanup-report-typed-failure-deadline", {
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
      adapter: {
        proveCleanup: () => Effect.succeed(proofSucceeds),
        deleteOwned: () => Effect.sync(() => void deleteCalls++),
      },
      sqlDecorator: (sql) =>
        new Proxy(sql, {
          apply: (target, thisArgument, argumentsList) => {
            const statement = Reflect.apply(target, thisArgument, argumentsList);
            const [query] = statement.compile();
            if (
              !failProofFenceWrite ||
              !query.includes("UPDATE preview_cleanup_proof_fences") ||
              !query.includes("SET generation=generation+1")
            )
              return statement;
            failProofFenceWrite = false;
            return Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.UnknownError({
                  cause: new Error("proof-fence-write-unavailable"),
                  message: "proof fence write unavailable",
                  operation: "invalidate cleanup proof",
                }),
              }),
            );
          },
        }),
    });
    const sql = yield* SqlClient.SqlClient;
    const proofRows =
      yield* sql`SELECT proof_at FROM preview_cleanup_state WHERE session_id=${f.created.session.id}`;
    const decodedProofRows = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ proof_at: Schema.Number })),
    )(proofRows);
    const proofAt = decodedProofRows[0]?.proof_at;
    expect(proofAt).toBeDefined();
    if (proofAt === undefined) return;

    yield* TestClock.adjust(Duration.seconds(299));
    const deletionStartedAt = proofAt + Duration.toMillis(Duration.minutes(5));
    const deletionDeadlineAt = deletionStartedAt + Duration.toMillis(Duration.minutes(5));
    yield* sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;
    expect(deletionDeadlineAt - f.now()).toBe(Duration.toMillis(Duration.seconds(1)));
    proofSucceeds = false;
    failProofFenceWrite = true;

    let cleanupCompletedAt: number | undefined;
    let inspectionCalls = 0;
    const allocationsWithStalledReport: PreviewAllocationApi = {
      ...f.allocations,
      inspect: () =>
        Effect.gen(function* () {
          inspectionCalls += 1;
          yield* Deferred.succeed(reportInspectionStarted, undefined);
          return yield* Effect.never;
        }),
    };
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: allocationsWithStalledReport,
      previewGateway: f.gateway,
    })
      .pipe(Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))))
      .pipe(Effect.forkChild);

    yield* Deferred.await(reportInspectionStarted);
    yield* TestClock.adjust(Duration.seconds(2));
    const result = yield* Fiber.join(cleanup);
    const state = yield* f.allocations.inspect(f.created.session.id);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });

    expect(result.ok).toBe(false);
    expect(result.readiness).toBe("blocked");
    expect(result.errors[0]?.message).toContain("reservation state is unknown");
    expect(inspectionCalls).toBe(1);
    expect(deleteCalls).toBe(0);
    expect(state.allocations[0]?.state).toBe("owned");
    expect(state.reservations[0]?.releasedAt).toBe(null);
    expect(state.cleanupTiming?.deletionAttempt.startedAt).toBe(deletionStartedAt);
    expect(cleanupCompletedAt).toBeDefined();
    if (cleanupCompletedAt === undefined) return;
    expect(cleanupCompletedAt).toBeLessThanOrEqual(deletionDeadlineAt);
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

it.live("uses a bounded report fallback only when no deletion attempt exists", () =>
  Effect.gen(function* () {
    const reportInspectionStarted = yield* Deferred.make<void>();
    let proofSucceeds = true;
    let failProofFenceWrite = false;
    let deleteCalls = 0;
    const f = yield* makeCleanupReportFixture("cleanup-report-absent-attempt-failure", {
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
      adapter: {
        proveCleanup: () => Effect.succeed(proofSucceeds),
        deleteOwned: () => Effect.sync(() => void deleteCalls++),
      },
      sqlDecorator: (sql) =>
        new Proxy(sql, {
          apply: (target, thisArgument, argumentsList) => {
            const statement = Reflect.apply(target, thisArgument, argumentsList);
            const [query] = statement.compile();
            if (
              !failProofFenceWrite ||
              !query.includes("UPDATE preview_cleanup_proof_fences") ||
              !query.includes("SET generation=generation+1")
            )
              return statement;
            failProofFenceWrite = false;
            return Effect.fail(
              new SqlError.SqlError({
                reason: new SqlError.UnknownError({
                  cause: new Error("proof-fence-write-unavailable"),
                  message: "proof fence write unavailable",
                  operation: "invalidate cleanup proof",
                }),
              }),
            );
          },
        }),
    });
    proofSucceeds = false;
    failProofFenceWrite = true;

    let cleanupCompletedAt: number | undefined;
    let inspectionCalls = 0;
    const allocationsWithStalledReport: PreviewAllocationApi = {
      ...f.allocations,
      inspect: () =>
        Effect.gen(function* () {
          inspectionCalls += 1;
          yield* Deferred.succeed(reportInspectionStarted, undefined);
          return yield* Effect.never;
        }),
    };
    const cleanupStartedAt = f.now();
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: allocationsWithStalledReport,
      previewGateway: f.gateway,
    })
      .pipe(Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))))
      .pipe(Effect.forkChild);

    yield* Deferred.await(reportInspectionStarted);
    yield* TestClock.adjust(Duration.seconds(5));
    const result = yield* Fiber.join(cleanup);
    const state = yield* f.allocations.inspect(f.created.session.id);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });

    expect(result.ok).toBe(false);
    expect(result.readiness).toBe("blocked");
    expect(result.errors[0]?.message).toContain("reservation state is unknown");
    expect(inspectionCalls).toBe(1);
    expect(deleteCalls).toBe(0);
    expect(state.cleanupTiming?.deletionAttempt.status).toBe("not-started");
    expect(state.reservations[0]?.releasedAt).toBe(null);
    expect(cleanupCompletedAt).toBeDefined();
    if (cleanupCompletedAt === undefined) return;
    expect(cleanupCompletedAt - cleanupStartedAt).toBeLessThanOrEqual(
      Duration.toMillis(Duration.seconds(5)),
    );
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

it.live(
  "preserves an active deletion deadline when the proof budget expires after its coherent snapshot",
  () =>
    Effect.gen(function* () {
      let delayAuthorizationSnapshot = false;
      let extraUnknownResourceReads = 0;
      let deleteCalls = 0;
      const f = yield* makeCleanupReportFixture("cleanup-proof-budget-expired-after-snapshot", {
        liveClock: true,
        primeProof: false,
        adapter: {
          deleteOwned: () => Effect.sync(() => void deleteCalls++),
        },
        sqlDecorator: (sql) =>
          new Proxy(sql, {
            apply: (target, thisArgument, argumentsList) => {
              const statement = Reflect.apply(target, thisArgument, argumentsList);
              const [query] = statement.compile();
              if (
                query.includes("provider_resource_id IS NULL") &&
                query.includes("provider_resource_id=''") &&
                query.includes("state IN")
              )
                extraUnknownResourceReads += 1;
              if (!delayAuthorizationSnapshot || !query.includes("AS proof_generation"))
                return statement;
              delayAuthorizationSnapshot = false;
              return statement.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 75);
                  }),
                ),
              );
            },
          }),
      });

      expect(yield* f.allocations.cleanup({ sessionId: f.created.session.id })).toBe("waiting");
      const proofAt = f.now() - Duration.toMillis(Duration.minutes(10));
      const deletionStartedAt = f.now() - Duration.toMillis(Duration.minutes(1));
      yield* f.sql`UPDATE preview_cleanup_state SET proof_at=${proofAt} WHERE session_id=${f.created.session.id}`;
      yield* f.sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;

      extraUnknownResourceReads = 0;
      delayAuthorizationSnapshot = true;
      const callStartedAt = f.now();
      const preDeletionDeadlineAt = callStartedAt + 5_000 + 25;
      const result = yield* f.allocations.cleanupWithDeadline({
        sessionId: f.created.session.id,
        preDeletionDeadlineAt,
      });
      const state = yield* f.allocations.inspect(f.created.session.id);

      expect(result.reportAttemptState).toBe("known");
      expect(f.now()).toBeGreaterThan(preDeletionDeadlineAt - 5_000);
      expect(result.deletionDeadlineAt).toBe(
        deletionStartedAt + Duration.toMillis(Duration.minutes(5)),
      );
      expect(extraUnknownResourceReads).toBe(0);
      expect(deleteCalls).toBe(0);
      expect(state.allocations[0]?.state).toBe("owned");
      expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(true);
      yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          SqliteClient.layer({ filename: ":memory:" }),
          NodeServices.layer,
          FetchHttpClient.layer,
        ),
      ),
    ),
);

it.live(
  "preserves the persisted deadline and skips expired reporting after an async proof timeout",
  () =>
    Effect.gen(function* () {
      const proofStarted = yield* Deferred.make<void>();
      let stallProof = false;
      let deleteCalls = 0;
      let reportInspectCalls = 0;
      let quarantineWriteCalls = 0;
      let reportInspectAt: number | undefined;
      let cleanupCompletedAt: number | undefined;
      const f = yield* makeCleanupReportFixture("cleanup-async-proof-timeout-active-deadline", {
        adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
        adapter: {
          proveCleanup: () =>
            stallProof
              ? Deferred.succeed(proofStarted, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(true),
          deleteOwned: () => Effect.sync(() => void deleteCalls++),
        },
      });
      const deletionStartedAt = f.now() - Duration.toMillis(Duration.minutes(1));
      const proofAt = deletionStartedAt - Duration.toMillis(Duration.minutes(10));
      const deletionDeadlineAt = deletionStartedAt + Duration.toMillis(Duration.minutes(5));
      yield* f.sql`UPDATE preview_cleanup_state SET proof_at=${proofAt} WHERE session_id=${f.created.session.id}`;
      yield* f.sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;
      stallProof = true;
      const allocations: PreviewAllocationApi = {
        ...f.allocations,
        inspect: (sessionId) =>
          Effect.gen(function* () {
            reportInspectCalls += 1;
            reportInspectAt = yield* Clock.currentTimeMillis;
            return yield* f.allocations.inspect(sessionId);
          }),
        markCleanupUnconfirmed: (input) => {
          quarantineWriteCalls += 1;
          return f.allocations.markCleanupUnconfirmed(input);
        },
      };
      const gateway: PreviewGatewayApi = {
        ...f.gateway,
        cleanupSession: () => Effect.void,
      };
      const controllerWithConfirmedStop: PreviewSessionControllerApi = {
        ...f.controller,
        stop: (sessionId) => f.controller.status(sessionId),
      };
      const cleanup = yield* connectedPreviewOutput(f.command, {
        env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
        previewSessionController: controllerWithConfirmedStop,
        previewAllocationController: allocations,
        previewGateway: gateway,
      })
        .pipe(Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))))
        .pipe(Effect.forkChild);

      yield* Deferred.await(proofStarted);
      yield* TestClock.adjust(Duration.millis(Duration.toMillis(Duration.minutes(5)) + 1));
      const output = yield* Fiber.join(cleanup);
      const state = yield* f.allocations.inspect(f.created.session.id);

      expect(output.ok).toBe(false);
      expect(output.readiness).toBe("blocked");
      expect(reportInspectCalls).toBeLessThanOrEqual(1);
      expect(cleanupCompletedAt).toBeDefined();
      if (cleanupCompletedAt === undefined) return;
      expect(cleanupCompletedAt).toBeLessThanOrEqual(deletionDeadlineAt);
      if (reportInspectAt !== undefined)
        expect(reportInspectAt).toBeLessThanOrEqual(deletionDeadlineAt);
      expect(quarantineWriteCalls).toBe(0);
      expect(deleteCalls).toBe(0);
      expect(state.cleanupTiming?.deletionAttempt.startedAt).toBe(deletionStartedAt);
      expect(state.allocations[0]?.state).toBe("owned");
      expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(true);
      yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

it.live("retains the persisted deadline when proof invalidation is confirmed", () =>
  Effect.gen(function* () {
    let proofSucceeds = true;
    let deleteCalls = 0;
    const f = yield* makeCleanupReportFixture(
      "cleanup-confirmed-proof-invalidation-active-deadline",
      {
        adapter: {
          proveCleanup: () => Effect.succeed(proofSucceeds),
          deleteOwned: () => Effect.sync(() => void deleteCalls++),
        },
      },
    );
    const deletionStartedAt = f.now();
    yield* f.sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;
    const beforeRows =
      yield* f.sql`SELECT generation FROM preview_cleanup_proof_fences WHERE session_id=${f.created.session.id}`;
    const generationBefore = Number(
      (beforeRows[0] as Record<string, unknown> | undefined)?.generation,
    );
    proofSucceeds = false;

    const result = yield* f.allocations.cleanupWithDeadline({
      sessionId: f.created.session.id,
      preDeletionDeadlineAt: f.now() + Duration.toMillis(Duration.minutes(5)),
    });
    const proofRows =
      yield* f.sql`SELECT proof_at FROM preview_cleanup_state WHERE session_id=${f.created.session.id}`;
    const fenceRows =
      yield* f.sql`SELECT generation FROM preview_cleanup_proof_fences WHERE session_id=${f.created.session.id}`;
    const state = yield* f.allocations.inspect(f.created.session.id);

    expect(result.reportAttemptState).toBe("known");
    expect(result.deletionDeadlineAt).toBe(
      deletionStartedAt + Duration.toMillis(Duration.minutes(5)),
    );
    expect(proofRows[0]?.proof_at).toBe(null);
    expect(
      Number((fenceRows[0] as Record<string, unknown> | undefined)?.generation),
    ).toBeGreaterThan(generationBefore);
    expect(deleteCalls).toBe(0);
    expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(true);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

it.live(
  "does not open a fresh report window on a public retry after proof invalidates a persisted attempt",
  () =>
    Effect.gen(function* () {
      const proofStarted = yield* Deferred.make<void>();
      let proofMode: "normal" | "invalidate" | "stall" = "normal";
      let deleteCalls = 0;
      let reportInspectCalls = 0;
      let reportInspectAt: number | undefined;
      let cleanupCompletedAt: number | undefined;
      let cleanupReportAttemptState: string | undefined;
      const f = yield* makeCleanupReportFixture("cleanup-invalidation-follow-up-report-window", {
        adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
        adapter: {
          proveCleanup: () => {
            if (proofMode === "invalidate") return Effect.succeed(false);
            if (proofMode === "stall")
              return Deferred.succeed(proofStarted, undefined).pipe(Effect.andThen(Effect.never));
            return Effect.succeed(true);
          },
          deleteOwned: () => Effect.sync(() => void deleteCalls++),
        },
      });
      const deletionStartedAt = f.now();
      const deletionDeadlineAt = deletionStartedAt + Duration.toMillis(Duration.minutes(5));
      yield* f.sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;

      proofMode = "invalidate";
      const invalidation = yield* f.allocations.cleanupWithDeadline({
        sessionId: f.created.session.id,
        preDeletionDeadlineAt: f.now() + Duration.toMillis(Duration.minutes(5)),
      });
      expect(invalidation.reportAttemptState).toBe("known");
      expect(invalidation.deletionDeadlineAt).toBe(deletionDeadlineAt);

      proofMode = "stall";
      yield* TestClock.adjust(Duration.minutes(1));
      const publicCallStartedAt = f.now();
      const allocations: PreviewAllocationApi = {
        ...f.allocations,
        cleanupWithDeadline: (input) =>
          Effect.gen(function* () {
            const result = yield* f.allocations.cleanupWithDeadline(input);
            cleanupReportAttemptState = result.reportAttemptState;
            return result;
          }),
        inspect: (sessionId) =>
          Effect.gen(function* () {
            reportInspectCalls += 1;
            reportInspectAt = yield* Clock.currentTimeMillis;
            return yield* f.allocations.inspect(sessionId);
          }),
      };
      const gateway: PreviewGatewayApi = { ...f.gateway, cleanupSession: () => Effect.void };
      const controllerWithConfirmedStop: PreviewSessionControllerApi = {
        ...f.controller,
        stop: (sessionId) => f.controller.status(sessionId),
      };
      const cleanup = yield* connectedPreviewOutput(f.command, {
        env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
        previewSessionController: controllerWithConfirmedStop,
        previewAllocationController: allocations,
        previewGateway: gateway,
      }).pipe(
        Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))),
        Effect.forkChild,
      );

      yield* Deferred.await(proofStarted);
      yield* TestClock.adjust(Duration.minutes(5));
      const output = yield* Fiber.join(cleanup);
      const state = yield* f.allocations.inspect(f.created.session.id);

      expect(output.ok).toBe(false);
      expect(output.readiness).toBe("blocked");
      expect(output.errors[0]?.message).toContain("proof");
      expect(cleanupReportAttemptState).toBe("unverified");
      expect(reportInspectCalls).toBe(0);
      expect(reportInspectAt).toBeUndefined();
      expect(cleanupCompletedAt).toBeDefined();
      if (cleanupCompletedAt === undefined) return;
      expect(cleanupCompletedAt).toBeLessThanOrEqual(
        publicCallStartedAt + Duration.toMillis(Duration.minutes(5)),
      );
      expect(deleteCalls).toBe(0);
      expect(state.cleanupTiming?.proofValidation.status).toBe("unverified");
      expect(state.cleanupTiming?.deletionAttempt.status).toBe("unverified");
      expect(state.cleanupTiming?.deletionAttempt.startedAt).toBe(deletionStartedAt);
      expect(state.allocations[0]?.state).toBe("owned");
      expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(true);
      yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

it.live("keeps a persisted deletion timestamp unverified while reproof is still stabilizing", () =>
  Effect.gen(function* () {
    let reportInspectCalls = 0;
    let deleteCalls = 0;
    let proofCalls = 0;
    let secondAttemptState: string | undefined;
    let proofMode: "verified" | "invalidated" = "verified";
    const f = yield* makeCleanupReportFixture("cleanup-pending-reproof-retains-old-attempt", {
      primeProof: false,
      adapter: {
        proveCleanup: () =>
          Effect.sync(() => {
            proofCalls += 1;
            return proofMode === "verified";
          }),
        deleteOwned: () => Effect.sync(() => void deleteCalls++),
      },
    });
    const initialAttempt = yield* f.allocations.cleanupWithDeadline({
      sessionId: f.created.session.id,
      preDeletionDeadlineAt: f.now() + Duration.toMillis(Duration.minutes(5)),
    });
    expect(initialAttempt.reportAttemptState).toBe("absent");
    const initialProofRows =
      yield* f.sql`SELECT proof_at FROM preview_cleanup_state WHERE session_id=${f.created.session.id}`;
    expect(initialProofRows[0]?.proof_at).toBe(f.now());

    const deletionStartedAt = f.now() - Duration.toMillis(Duration.minutes(2));
    yield* f.sql.withTransaction(
      Effect.gen(function* () {
        yield* f.sql`UPDATE preview_cleanup_timing SET deletion_started_at=${deletionStartedAt} WHERE session_id=${f.created.session.id}`;
        yield* f.sql`UPDATE preview_cleanup_state SET proof_at=NULL WHERE session_id=${f.created.session.id}`;
        yield* f.sql`UPDATE preview_cleanup_proof_fences SET generation=generation+1 WHERE session_id=${f.created.session.id}`;
      }),
    );

    proofMode = "invalidated";
    const invalidation = yield* f.allocations.cleanupWithDeadline({
      sessionId: f.created.session.id,
      preDeletionDeadlineAt: f.now() + Duration.toMillis(Duration.minutes(5)),
    });
    expect(invalidation.reportAttemptState).toBe("invalidated");

    proofMode = "verified";

    const firstRetry = yield* f.allocations.cleanupWithDeadline({
      sessionId: f.created.session.id,
      preDeletionDeadlineAt: f.now() + Duration.toMillis(Duration.minutes(5)),
    });
    const newlyStampedProofRows =
      yield* f.sql`SELECT proof_at FROM preview_cleanup_state WHERE session_id=${f.created.session.id}`;
    expect(firstRetry.reportAttemptState).toBe("unverified");
    expect(newlyStampedProofRows[0]?.proof_at).toBe(f.now());

    const allocations: PreviewAllocationApi = {
      ...f.allocations,
      cleanupWithDeadline: (input) =>
        Effect.gen(function* () {
          const result = yield* f.allocations.cleanupWithDeadline(input);
          secondAttemptState = result.reportAttemptState;
          return result;
        }),
      inspect: (sessionId) =>
        Effect.gen(function* () {
          reportInspectCalls += 1;
          return yield* f.allocations.inspect(sessionId);
        }),
    };
    const controllerWithConfirmedStop: PreviewSessionControllerApi = {
      ...f.controller,
      stop: (sessionId) => f.controller.status(sessionId),
    };
    const output = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: controllerWithConfirmedStop,
      previewAllocationController: allocations,
      previewGateway: { ...f.gateway, cleanupSession: () => Effect.void },
    });
    const state = yield* f.allocations.inspect(f.created.session.id);

    expect(output.ok).toBe(false);
    expect(output.readiness).toBe("blocked");
    expect(output.errors[0]?.message).toContain("proof");
    expect(output.errors[0]?.remediation).toContain("proof");
    expect(secondAttemptState).toBe("unverified");
    expect(reportInspectCalls).toBe(0);
    expect(deleteCalls).toBe(0);
    expect(state.cleanupTiming?.proofValidation.status).toBe("validating");
    expect(state.cleanupTiming?.deletionAttempt.status).toBe("unverified");
    expect(state.cleanupTiming?.deletionAttempt.startedAt).toBe(deletionStartedAt);
    expect(state.allocations[0]?.state).toBe("owned");
    expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(true);

    yield* f.sql`UPDATE preview_allocation_ledger SET state='deleting', updated_at=${f.now()} WHERE session_id=${f.created.session.id} AND resource='auth'`;
    const proofCallsBeforeFreshClaim = proofCalls;
    const claimedAttempt = yield* f.allocations.cleanupWithDeadline({
      sessionId: f.created.session.id,
      preDeletionDeadlineAt: f.now() + Duration.toMillis(Duration.minutes(5)),
    });
    expect(claimedAttempt.reportAttemptState).toBe("unverified");
    expect(proofCalls).toBe(proofCallsBeforeFreshClaim);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

it.live("reports resolved cleanup guidance on an inspected quarantined response", () =>
  Effect.gen(function* () {
    const f = yield* makeCleanupReportFixture("cleanup-inspected-quarantine-response");
    yield* f.sql`UPDATE preview_allocation_ledger
      SET provider_resource_id=NULL, state='quarantined', failure='provider-resource-id-missing'
      WHERE session_id=${f.created.session.id} AND resource='auth'`;
    const controllerWithConfirmedStop: PreviewSessionControllerApi = {
      ...f.controller,
      stop: (sessionId) => f.controller.status(sessionId),
    };
    const output = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: controllerWithConfirmedStop,
      previewAllocationController: f.allocations,
      previewGateway: { ...f.gateway, cleanupSession: () => Effect.void },
    });
    const state = yield* f.allocations.inspect(f.created.session.id);

    expect(output.ok).toBe(false);
    expect(output.readiness).toBe("blocked");
    expect(output.previewSession?.allocations?.cleanup).toBe("quarantined");
    expect(output.errors[0]?.remediation).toContain("preview resolve");
    expect(state.allocations[0]?.state).toBe("quarantined");
    expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(true);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

it.live(
  "does not treat a timing write fenced by concurrent proof invalidation as an absent attempt",
  () =>
    Effect.gen(function* () {
      let invalidateAtTimingWrite = false;
      let invalidatedSessionId: string | undefined;
      let timingWriteInterleavings = 0;
      let reportInspectCalls = 0;
      let cleanupCompletedAt: number | undefined;
      let cleanupReportAttemptState: string | undefined;
      const f = yield* makeCleanupReportFixture("cleanup-proof-invalidation-timing-write-race", {
        sqlDecorator: (sql) =>
          new Proxy(sql, {
            apply: (target, thisArgument, argumentsList) => {
              const statement = Reflect.apply(target, thisArgument, argumentsList);
              const [query] = statement.compile();
              if (
                !invalidateAtTimingWrite ||
                !query.includes("UPDATE preview_cleanup_timing") ||
                !query.includes("SET deletion_started_at") ||
                invalidatedSessionId === undefined
              )
                return statement;
              invalidateAtTimingWrite = false;
              timingWriteInterleavings += 1;
              const sessionId = invalidatedSessionId;
              return Effect.gen(function* () {
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`UPDATE preview_allocation_ledger
                      SET state='deleted', failure='provider-verified-absent', updated_at=${0}
                      WHERE session_id=${sessionId} AND resource='auth' AND state='owned'`;
                    yield* sql`UPDATE preview_cleanup_proof_fences
                      SET generation=generation+1 WHERE session_id=${sessionId}`;
                    yield* sql`UPDATE preview_cleanup_state SET proof_at=NULL WHERE session_id=${sessionId}`;
                  }),
                );
                return yield* statement;
              });
            },
          }),
      });
      invalidatedSessionId = f.created.session.id;
      invalidateAtTimingWrite = true;
      const allocations: PreviewAllocationApi = {
        ...f.allocations,
        cleanupWithDeadline: (input) =>
          Effect.gen(function* () {
            const result = yield* f.allocations.cleanupWithDeadline(input);
            cleanupReportAttemptState = result.reportAttemptState;
            return result;
          }),
        inspect: (sessionId) =>
          Effect.gen(function* () {
            reportInspectCalls += 1;
            return yield* f.allocations.inspect(sessionId);
          }),
      };
      const gateway: PreviewGatewayApi = { ...f.gateway, cleanupSession: () => Effect.void };
      const controllerWithConfirmedStop: PreviewSessionControllerApi = {
        ...f.controller,
        stop: (sessionId) => f.controller.status(sessionId),
      };
      const cleanup = yield* connectedPreviewOutput(f.command, {
        env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
        previewSessionController: controllerWithConfirmedStop,
        previewAllocationController: allocations,
        previewGateway: gateway,
      }).pipe(
        Effect.tap(() => Effect.sync(() => (cleanupCompletedAt = f.now()))),
        Effect.forkChild,
      );
      const output = yield* Fiber.join(cleanup);
      const proofRows =
        yield* f.sql`SELECT proof_at FROM preview_cleanup_state WHERE session_id=${f.created.session.id}`;
      const generationRows =
        yield* f.sql`SELECT generation FROM preview_cleanup_proof_fences WHERE session_id=${f.created.session.id}`;
      const state = yield* f.allocations.inspect(f.created.session.id);

      expect(timingWriteInterleavings).toBe(1);
      expect(output.ok).toBe(false);
      expect(output.readiness).toBe("blocked");
      expect(output.errors[0]?.message).toContain("invalidat");
      expect(output.errors[0]?.remediation).toContain("proof");
      expect(cleanupReportAttemptState).toBe("invalidated");
      expect(reportInspectCalls).toBe(0);
      expect(cleanupCompletedAt).toBeDefined();
      expect(proofRows[0]?.proof_at).toBe(null);
      expect(Number(generationRows[0]?.generation)).toBeGreaterThan(0);
      expect(state.cleanupTiming?.proofValidation.status).toBe("unverified");
      expect(state.cleanupTiming?.deletionAttempt.status).toBe("not-started");
      expect(state.allocations[0]?.state).toBe("deleted");
      expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(true);
      yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

it.live(
  "keeps an unreadable cleanup authorization snapshot unknown at controller and public boundaries",
  () =>
    Effect.gen(function* () {
      let failAuthorizationSnapshot = false;
      let authorizationSnapshotReads = 0;
      let deleteCalls = 0;
      let reportInspectCalls = 0;
      let reportQuarantineWrites = 0;
      const f = yield* makeCleanupReportFixture("cleanup-authorization-snapshot-unreadable", {
        adapter: {
          deleteOwned: () => Effect.sync(() => void deleteCalls++),
        },
        sqlDecorator: (sql) =>
          new Proxy(sql, {
            apply: (target, thisArgument, argumentsList) => {
              const statement = Reflect.apply(target, thisArgument, argumentsList);
              const [query] = statement.compile();
              if (!query.includes("AS proof_generation")) return statement;
              authorizationSnapshotReads += 1;
              return failAuthorizationSnapshot
                ? Effect.fail(
                    new SqlError.SqlError({
                      reason: new SqlError.UnknownError({
                        cause: new Error("cleanup-authorization-unavailable"),
                        message: "cleanup authorization unavailable",
                        operation: "read cleanup authorization",
                      }),
                    }),
                  )
                : statement;
            },
          }),
      });
      failAuthorizationSnapshot = true;

      const controllerResult = yield* f.allocations.cleanupWithDeadline({
        sessionId: f.created.session.id,
        preDeletionDeadlineAt: f.now() + Duration.toMillis(Duration.minutes(5)),
      });
      expect(controllerResult.reportAttemptState).toBe("unknown");
      expect(controllerResult.deletionDeadlineAt).toBe(null);
      expect(controllerResult.remainingDeletionMs).toBe(null);
      expect(controllerResult.failure).not.toBe(null);
      expect(deleteCalls).toBe(0);

      const allocationsWithTrackedReportCalls: PreviewAllocationApi = {
        ...f.allocations,
        inspect: (sessionId) => {
          reportInspectCalls += 1;
          return f.allocations.inspect(sessionId);
        },
        markCleanupUnconfirmed: (input) => {
          reportQuarantineWrites += 1;
          return f.allocations.markCleanupUnconfirmed(input);
        },
      };
      const output = yield* connectedPreviewOutput(f.command, {
        env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
        previewSessionController: f.controller,
        previewAllocationController: allocationsWithTrackedReportCalls,
        previewGateway: f.gateway,
      });
      expect(output.ok).toBe(false);
      expect(output.readiness).toBe("blocked");
      expect(output.errors[0]?.message).toContain("could not be read coherently");
      expect(output.errors[0]?.message).toContain(
        "do not infer whether capacity is held or released",
      );
      expect(reportInspectCalls).toBe(0);
      expect(reportQuarantineWrites).toBe(0);
      expect(authorizationSnapshotReads).toBe(3);
      expect(deleteCalls).toBe(0);

      const state = yield* f.allocations.inspect(f.created.session.id);
      expect(state.allocations[0]?.state).toBe("owned");
      expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(true);
      yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

it.live("gives deletion its own five-minute phase after bounded route cleanup", () =>
  Effect.gen(function* () {
    const deletionStarted = yield* Deferred.make<void>();
    let deletionCalls = 0;
    const f = yield* makeCleanupReportFixture("cleanup-separate-deletion-phase", {
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(2)),
      adapter: {
        deleteOwned: () =>
          Effect.gen(function* () {
            deletionCalls += 1;
            yield* Deferred.succeed(deletionStarted, undefined);
            yield* Effect.never;
          }),
      },
    });
    const routeStarted = yield* Deferred.make<void>();
    const routeCleanupComplete = yield* Deferred.make<void>();
    const gateway: PreviewGatewayApi = {
      ...f.gateway,
      cleanupSession: () =>
        Deferred.succeed(routeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(routeCleanupComplete)),
        ),
    };
    const cleanupStartedAt = f.now();
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: f.allocations,
      previewGateway: gateway,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(routeStarted);
    yield* TestClock.adjust(Duration.minutes(4));
    yield* Deferred.succeed(routeCleanupComplete, undefined);
    yield* Effect.yieldNow;
    yield* Deferred.await(deletionStarted);
    expect(f.now() - cleanupStartedAt).toBe(Duration.toMillis(Duration.minutes(4)));
    expect(deletionCalls).toBe(1);

    yield* TestClock.adjust(Duration.minutes(1));
    yield* Effect.yieldNow;
    expect(cleanup.pollUnsafe()).toBeUndefined();

    yield* TestClock.adjust(Duration.minutes(1));
    yield* Effect.yieldNow;
    const result = yield* Fiber.join(cleanup);
    expect(result.ok).toBe(false);
    expect(result.readiness).toBe("blocked");
    expect(result.errors[0]?.code).toBe("cleanup-failed");
    expect(result.errors[0]?.message).toContain(
      "Capacity reservations recorded as held: 4; released: 0.",
    );
    expect(result.previewSession?.allocations?.cleanup).toBe("quarantined");
    expect(result.previewSession?.allocations?.cleanupTiming?.totalElapsedMs).toBe(
      Duration.toMillis(Duration.minutes(11)),
    );
    expect(result.previewSession?.allocations?.cleanupTiming?.proofValidation.status).toBe(
      "complete",
    );
    expect(result.previewSession?.allocations?.cleanupTiming?.deletionAttempt.status).toBe(
      "failed",
    );
    expect(result.previewSession?.allocations?.cleanupTiming?.deletionAttempt.elapsedMs).toBe(
      Duration.toMillis(Duration.minutes(2)),
    );
    const state = yield* f.allocations.inspect(f.created.session.id);
    expect(state.allocations[0]?.state).toBe("quarantined");
    expect(state.reservations[0]?.releasedAt).toBe(null);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

it.live("bounds provider proof acquisition inside the pre-deletion phase", () =>
  Effect.gen(function* () {
    const proofStarted = yield* Deferred.make<void>();
    let deletionCalls = 0;
    const f = yield* makeCleanupReportFixture("cleanup-proof-acquisition-timeout", {
      primeProof: false,
      adapterTimeoutMs: Duration.toMillis(Duration.minutes(10)),
      adapter: {
        proveCleanup: () =>
          Deferred.succeed(proofStarted, undefined).pipe(Effect.andThen(Effect.never)),
        deleteOwned: () => Effect.sync(() => void deletionCalls++),
      },
    });
    const gateway: PreviewGatewayApi = {
      ...f.gateway,
      cleanupSession: () => Effect.void,
    };
    const cleanup = yield* connectedPreviewOutput(f.command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
      previewSessionController: f.controller,
      previewAllocationController: f.allocations,
      previewGateway: gateway,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(proofStarted);
    yield* TestClock.adjust(Duration.minutes(5));
    yield* Effect.yieldNow;
    const completion = yield* Fiber.join(cleanup).pipe(
      Effect.timeoutOption(Duration.seconds(1)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(1));
    const result = yield* Fiber.join(completion);
    if (Option.isNone(result)) yield* Fiber.interrupt(cleanup);

    expect(Option.isSome(result)).toBe(true);
    if (Option.isNone(result)) return;
    expect(result.value.ok).toBe(false);
    expect(result.value.previewSession?.allocations?.cleanup).toBe("waiting");
    expect(deletionCalls).toBe(0);
    const state = yield* f.allocations.inspect(f.created.session.id);
    expect(state.allocations[0]?.state).toBe("owned");
    expect(state.reservations[0]?.releasedAt).toBe(null);
    yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
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

const makeCleanupReportFixture = (
  owner: string,
  options: {
    readonly adapter?: Partial<import("./preview-allocations").PreviewResourceAdapter>;
    readonly adapterTimeoutMs?: number;
    readonly liveClock?: boolean;
    readonly primeProof?: boolean;
    readonly sqlDecorator?: (sql: SqlClientType.SqlClient) => SqlClientType.SqlClient;
  } = {},
) =>
  Effect.gen(function* () {
    let now: () => number;
    if (options.liveClock) now = Date.now;
    else {
      const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
      now = () => testClock.currentTimeMillisUnsafe();
    }
    const sql = yield* SqlClient.SqlClient;
    const allocationSql = options.sqlDecorator?.(sql) ?? sql;
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner,
      checkout: `/tmp/${owner}`,
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "revision-a",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "revision-a",
    );
    const allocations = yield* makePreviewAllocationController(
      {
        planProfile: () => Effect.fail(new Error("unused")),
        validateProfileAllocation: () => Effect.void,
        allocate: () => Effect.succeed("owned-resource"),
        deleteOwned: () => Effect.void,
        proveCleanup: () => Effect.succeed(true),
        resolveUnknown: () => Effect.fail(new Error("unused")),
        ...options.adapter,
      },
      now,
      undefined,
      true,
      options.adapterTimeoutMs ?? 10 * 60_000,
    ).pipe(Effect.provideService(SqlClient.SqlClient, allocationSql));
    yield* Effect.forEach(previewCapacityDimensionsByGroup.auth, (dimension) =>
      allocations.observeCapacity({
        provider: "local-test",
        identity: "disposable",
        dimension,
        observedAt: now(),
        total: 2,
        inUse: 0,
        grantsVerified: true,
      }),
    );
    yield* allocations.reserveAndAllocate({
      sessionId: created.session.id,
      demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
        dimension,
        amount: 1,
        provider: "local-test",
        identity: "disposable",
      })),
      resources: ["auth"],
    });
    yield* controller.stop(created.session.id, created.ownerIdentity);
    if (options.primeProof !== false) {
      expect(yield* allocations.cleanup({ sessionId: created.session.id })).toBe("waiting");
      yield* TestClock.adjust(Duration.minutes(5));
    }

    const sessionDatabase = path.join("/tmp", `preview-cleanup-report-${randomUUID()}.sqlite`);
    const credentialsDirectory = `${sessionDatabase}.credentials`;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(credentialsDirectory, { recursive: true, mode: 0o700 });
    yield* fileSystem.writeFileString(
      path.join(credentialsDirectory, created.session.id),
      JSON.stringify({
        ownerIdentity: created.ownerIdentity,
        supervisorIdentity: created.supervisorIdentity,
      }),
      { mode: 0o600 },
    );
    const command = parsePreviewAction(
      ["preview", "cleanup", "--session", created.session.id, "--json"],
      "cleanup",
    );
    const gateway = yield* makePreviewGateway({ domain: "", controller, now });
    return {
      allocations,
      command,
      controller,
      created,
      credentialsDirectory,
      fileSystem,
      gateway,
      now,
      sessionDatabase,
      sql,
    };
  });

it.live("cleans route-only preview metadata through the public command without adapters", () =>
  makeCleanupReportFixture("offline-route-only-command")
    .pipe(
      Effect.flatMap((f) =>
        Effect.gen(function* () {
          const target: PreviewGatewayTarget = {
            sessionId: f.created.session.id,
            generation: f.created.session.generation,
            role: "sheet-web",
            processId: "offline-route-only-command",
            revision: f.created.session.requestedRevision,
            artifactDigest: `sha256:${"a".repeat(64)}`,
            catalogDigest: `sha256:${"b".repeat(64)}`,
            stateGroup: "application-zero",
            serviceFqdn: "web.preview-relays.svc.cluster.local",
            serviceResourceId: "offline-route-only-service",
            attachmentResourceId: "offline-route-only-attachment",
            port: 4100,
            kind: "application",
          };
          const hostname = `p-${f.created.session.id}-sheet-web.dev.example.test`;
          yield* f.sql`INSERT INTO preview_gateway_routes
            (hostname, session_id, generation, target)
            VALUES (${hostname}, ${target.sessionId}, ${target.generation}, ${JSON.stringify(target)})`;
          yield* f.sql`INSERT INTO preview_gateway_grants (hostname, user_id)
            VALUES (${hostname}, 'offline-command-guest')`;
          yield* f.sql`INSERT INTO preview_gateway_dependency_routes
            (session_id, role, group_id, target, removed)
            VALUES (${target.sessionId}, ${target.role}, 'auth', '{}', 0)`;

          const result = yield* connectedPreviewOutput(f.command, {
            env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
            previewSessionController: f.controller,
            previewAllocationController: f.allocations,
            previewGateway: f.gateway,
          });
          const routes = yield* f.sql`SELECT removed FROM preview_gateway_routes
            WHERE session_id=${target.sessionId}`;
          const grants =
            yield* f.sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${hostname}`;
          const dependencies = yield* f.sql`SELECT group_id FROM preview_gateway_dependency_routes
            WHERE session_id=${target.sessionId}`;
          const allocationState = yield* f.allocations.inspect(target.sessionId);
          expect({
            ok: result.ok,
            readiness: result.readiness,
            cleanup: result.previewSession?.allocations?.cleanup,
            removedRoutes: routes.map((row) => row.removed),
            grants: grants.map((row) => row.user_id),
            dependencies: dependencies.map((row) => row.group_id),
            reservationsReleased: allocationState.reservations.every(
              (reservation) => reservation.releasedAt !== null,
            ),
          }).toEqual({
            ok: true,
            readiness: "stopped",
            cleanup: "cleaned",
            removedRoutes: [1],
            grants: [],
            dependencies: [],
            reservationsReleased: true,
          });
          yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
          yield* f.fileSystem.remove(f.sessionDatabase, { force: true });
        }),
      ),
    )
    .pipe(
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

it.live("reports unknown reservations after a gateway timeout defect and failed inspection", () =>
  makeCleanupReportFixture("cleanup-inspection-unavailable")
    .pipe(
      Effect.flatMap((f) =>
        Effect.gen(function* () {
          const unavailableInspection: PreviewAllocationApi = {
            ...f.allocations,
            inspect: () =>
              Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.UnknownError({
                    cause: new Error("allocation-status-unavailable"),
                    message: "allocation status unavailable",
                    operation: "inspect allocation",
                  }),
                }),
              ),
          };
          const gateway: PreviewGatewayApi = {
            ...f.gateway,
            cleanupSession: () => Effect.die(new PreviewGatewayError({ reason: "unavailable" })),
          };
          const outputExit = yield* Effect.exit(
            connectedPreviewOutput(f.command, {
              env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
              previewSessionController: f.controller,
              previewAllocationController: unavailableInspection,
              previewGateway: gateway,
            }),
          );
          if (outputExit._tag === "Failure") {
            yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
            expect(outputExit._tag).toBe("Success");
            return;
          }
          const output = outputExit.value;
          const errorText = [output.errors[0]?.message, output.errors[0]?.remediation]
            .filter((value) => value !== undefined)
            .join(" ");
          expect(output.ok).toBe(false);
          expect(output.readiness).toBe("blocked");
          expect(output.errors[0]?.message).toContain("reservation state is unknown");
          expect(errorText).toContain("reservation state is unknown");
          expect(errorText).not.toContain("reservations remain held");
          expect(errorText).not.toContain("reservations were released");
          const state = yield* f.allocations.inspect(f.created.session.id);
          expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(
            true,
          );
          const cleanupState =
            yield* f.sql`SELECT quarantine_reason FROM preview_cleanup_state WHERE session_id=${f.created.session.id}`;
          expect(cleanupState[0]?.quarantine_reason).toBe("gateway-cleanup-unconfirmed");
          yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
        }),
      ),
    )
    .pipe(
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

it.live("preserves mixed gateway cleanup causes through the public cleanup boundary", () =>
  makeCleanupReportFixture("cleanup-mixed-gateway-cause")
    .pipe(
      Effect.flatMap((f) =>
        Effect.gen(function* () {
          const parallelTimeout = new PreviewGatewayError({ reason: "unavailable" });
          const parallelDefect = new Error("parallel-adapter-close-defect");
          const sequentialTimeout = new PreviewGatewayError({ reason: "unavailable" });
          const sequentialDefect = new Error("sequential-cleanup-finalizer-defect");
          const finalizerTimeout = new PreviewGatewayError({ reason: "unavailable" });
          const finalizerDefect = new Error("sequential-finalizer-defect");
          const interruptedFailure = new PreviewGatewayError({ reason: "unavailable" });
          const interruptedDefect = new Error("interrupted-cleanup-defect");
          const nonTimeoutGatewayDefect = new PreviewGatewayError({ reason: "identity-mismatch" });
          const scenarios = [
            {
              cleanup: Effect.forEach(
                [() => Effect.fail(parallelTimeout), () => Effect.die(parallelDefect)],
                (close) => Effect.exit(close()),
                { concurrency: "unbounded" },
              ).pipe(
                Effect.flatMap((exits) => {
                  const causes = exits.flatMap((exit) =>
                    Exit.isFailure(exit) ? [exit.cause] : [],
                  );
                  const cause = causes.reduce(
                    (combined, next) => Cause.combine(combined, next),
                    Cause.empty,
                  );
                  return Effect.failCause(cause);
                }),
              ),
              expectedFailure: parallelTimeout,
              expectedDefect: parallelDefect,
              expectedInterrupt: false,
              expectedReasons: 2,
            },
            {
              cleanup: Effect.gen(function* () {
                const cleanupExit = yield* Effect.exit(Effect.fail(sequentialTimeout));
                const finalizerExit = yield* Effect.exit(Effect.die(sequentialDefect));
                const cleanupCause = Exit.isFailure(cleanupExit) ? cleanupExit.cause : Cause.empty;
                const finalizerCause = Exit.isFailure(finalizerExit)
                  ? finalizerExit.cause
                  : Cause.empty;
                return yield* Effect.failCause(Cause.combine(cleanupCause, finalizerCause));
              }),
              expectedFailure: sequentialTimeout,
              expectedDefect: sequentialDefect,
              expectedInterrupt: false,
              expectedReasons: 2,
            },
            {
              cleanup: Effect.acquireUseRelease(
                Effect.void,
                () => Effect.fail(finalizerTimeout),
                () => Effect.die(finalizerDefect),
              ),
              expectedFailure: undefined,
              expectedDefect: finalizerDefect,
              expectedInterrupt: false,
              expectedReasons: 1,
            },
            {
              cleanup: Effect.failCause(
                Cause.combine(Cause.interrupt(), Cause.fail(interruptedFailure)),
              ),
              expectedFailure: interruptedFailure,
              expectedDefect: undefined,
              expectedInterrupt: true,
              expectedReasons: 2,
            },
            {
              cleanup: Effect.failCause(
                Cause.combine(Cause.interrupt(), Cause.die(interruptedDefect)),
              ),
              expectedFailure: undefined,
              expectedDefect: interruptedDefect,
              expectedInterrupt: true,
              expectedReasons: 2,
            },
            {
              cleanup: Effect.die(nonTimeoutGatewayDefect),
              expectedFailure: undefined,
              expectedDefect: nonTimeoutGatewayDefect,
              expectedInterrupt: false,
              expectedReasons: 1,
            },
          ] as const;

          const summaries = [];
          for (const scenario of scenarios) {
            const gateway: PreviewGatewayApi = {
              ...f.gateway,
              cleanupSession: () => scenario.cleanup,
            };
            const exit = yield* Effect.exit(
              connectedPreviewOutput(f.command, {
                env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
                previewSessionController: f.controller,
                previewAllocationController: f.allocations,
                previewGateway: gateway,
              }),
            );
            if (Exit.isSuccess(exit)) {
              summaries.push({ tag: "success" });
              continue;
            }
            const reasons = exit.cause.reasons;
            summaries.push({
              tag: "failure",
              expectedFailurePreserved:
                scenario.expectedFailure !== undefined &&
                reasons.some(
                  (reason) =>
                    Cause.isFailReason(reason) &&
                    Object.is(reason.error as unknown, scenario.expectedFailure),
                ),
              expectedDefectPreserved:
                scenario.expectedDefect !== undefined &&
                reasons.some(
                  (reason) =>
                    Cause.isDieReason(reason) && Object.is(reason.defect, scenario.expectedDefect),
                ),
              interruptionPreserved: reasons.some(Cause.isInterruptReason),
              reasonCount: reasons.length,
            });
          }

          expect(summaries).toEqual(
            scenarios.map((scenario) => ({
              tag: "failure",
              expectedFailurePreserved: scenario.expectedFailure !== undefined,
              expectedDefectPreserved: scenario.expectedDefect !== undefined,
              interruptionPreserved: scenario.expectedInterrupt,
              reasonCount: scenario.expectedReasons,
            })),
          );
          const state = yield* f.allocations.inspect(f.created.session.id);
          expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(
            true,
          );
        }).pipe(
          Effect.ensuring(
            f.fileSystem
              .remove(f.credentialsDirectory, { recursive: true, force: true })
              .pipe(Effect.ignore),
          ),
        ),
      ),
    )
    .pipe(
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

it.live("reports a pure typed gateway cleanup failure as unconfirmed", () =>
  makeCleanupReportFixture("cleanup-typed-gateway-failure")
    .pipe(
      Effect.flatMap((f) =>
        Effect.gen(function* () {
          const gateway: PreviewGatewayApi = {
            ...f.gateway,
            cleanupSession: () => Effect.fail(new PreviewGatewayError({ reason: "unavailable" })),
          };
          const exit = yield* Effect.exit(
            connectedPreviewOutput(f.command, {
              env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
              previewSessionController: f.controller,
              previewAllocationController: f.allocations,
              previewGateway: gateway,
            }),
          );
          if (Exit.isFailure(exit)) {
            expect(Exit.isSuccess(exit)).toBe(true);
            return;
          }

          expect(exit.value.ok).toBe(false);
          expect(exit.value.readiness).toBe("blocked");
          expect(exit.value.previewSession?.allocations?.cleanup).toBe("quarantined");
          expect(exit.value.errors[0]?.message).toContain("Gateway route or channel cleanup");
          const state = yield* f.allocations.inspect(f.created.session.id);
          expect(state.cleanup).toBe("quarantined");
          expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(
            true,
          );
        }).pipe(
          Effect.ensuring(
            f.fileSystem
              .remove(f.credentialsDirectory, { recursive: true, force: true })
              .pipe(Effect.ignore),
          ),
        ),
      ),
    )
    .pipe(
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

it.live("preserves every gateway error in a composite cleanup cause", () =>
  makeCleanupReportFixture("cleanup-composite-gateway-errors")
    .pipe(
      Effect.flatMap((f) =>
        Effect.gen(function* () {
          const unavailable = new PreviewGatewayError({ reason: "unavailable" });
          const identityMismatch = new PreviewGatewayError({ reason: "identity-mismatch" });
          const gateway: PreviewGatewayApi = {
            ...f.gateway,
            cleanupSession: () =>
              Effect.failCause(
                Cause.combine(Cause.fail(unavailable), Cause.fail(identityMismatch)),
              ),
          };
          const exit = yield* Effect.exit(
            connectedPreviewOutput(f.command, {
              env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
              previewSessionController: f.controller,
              previewAllocationController: f.allocations,
              previewGateway: gateway,
            }),
          );

          expect(exit._tag).toBe("Failure");
          if (Exit.isFailure(exit)) {
            const failures = exit.cause.reasons.flatMap((reason) =>
              Cause.isFailReason(reason) ? [reason.error] : [],
            );
            expect(failures).toContain(unavailable);
            expect(failures).toContain(identityMismatch);
            expect(exit.cause.reasons).toHaveLength(2);
          }
        }).pipe(
          Effect.ensuring(
            f.fileSystem
              .remove(f.credentialsDirectory, { recursive: true, force: true })
              .pipe(Effect.ignore),
          ),
        ),
      ),
    )
    .pipe(
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

it.live("retains mixed cleanup causes through the launcher runtime boundary", () =>
  makeCleanupReportFixture("cleanup-launcher-mixed-cause")
    .pipe(
      Effect.flatMap((f) =>
        Effect.gen(function* () {
          const gatewayFailure = new PreviewGatewayError({ reason: "unavailable" });
          const adapterDefect = new Error("launcher-adapter-close-defect");
          const gateway: PreviewGatewayApi = {
            ...f.gateway,
            cleanupSession: () =>
              Effect.failCause(Cause.combine(Cause.fail(gatewayFailure), Cause.die(adapterDefect))),
          };
          const thrown = yield* Effect.exit(
            Effect.tryPromise({
              try: () =>
                runLauncher(["preview", "cleanup", "--session", f.created.session.id, "--json"], {
                  env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
                  previewSessionController: f.controller,
                  previewAllocationController: f.allocations,
                  previewGateway: gateway,
                }),
              catch: (cause) => cause,
            }),
          );

          expect(thrown._tag).toBe("Failure");
          if (Exit.isFailure(thrown)) {
            const error = Cause.findErrorOption(thrown.cause);
            expect(error._tag).toBe("Some");
            if (error._tag === "Some" && error.value instanceof Error) {
              expect(error.value.message).toBe(
                "Preview command failed with an unrecoverable cause.",
              );
              expect(error.value.message).not.toContain(adapterDefect.message);
              expect(Cause.isCause(error.value.cause)).toBe(true);
              if (Cause.isCause(error.value.cause)) {
                expect(Cause.hasFails(error.value.cause)).toBe(true);
                expect(Cause.hasDies(error.value.cause)).toBe(true);
                expect(
                  error.value.cause.reasons.some(
                    (reason) => Cause.isDieReason(reason) && reason.defect === adapterDefect,
                  ),
                ).toBe(true);
              }
            }
          }
          const state = yield* f.allocations.inspect(f.created.session.id);
          expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(
            true,
          );
        }).pipe(
          Effect.ensuring(
            f.fileSystem
              .remove(f.credentialsDirectory, { recursive: true, force: true })
              .pipe(Effect.ignore),
          ),
        ),
      ),
    )
    .pipe(
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

it.live("reports the inspected reservation state after completion-marker persistence fails", () =>
  makeCleanupReportFixture("cleanup-completion-write-failure")
    .pipe(
      Effect.flatMap((f) =>
        Effect.gen(function* () {
          yield* f.sql`CREATE TRIGGER fail_cleanup_completion
          BEFORE UPDATE OF completed_at ON preview_cleanup_state
          BEGIN SELECT RAISE(FAIL, 'injected completion write failure'); END`;
          const output = yield* connectedPreviewOutput(f.command, {
            env: { TIARA_PREVIEW_SESSION_DATABASE: f.sessionDatabase },
            previewSessionController: f.controller,
            previewAllocationController: f.allocations,
            previewGateway: f.gateway,
          });
          const state = yield* f.allocations.inspect(f.created.session.id);
          const held = state.reservations.filter(
            (reservation) => reservation.releasedAt === null,
          ).length;
          const released = state.reservations.length - held;
          expect(output.ok).toBe(false);
          expect(output.previewSession?.allocations?.cleanup).toBe("quarantined");
          expect(state.allocations.every((allocation) => allocation.state === "deleted")).toBe(
            true,
          );
          expect(state.reservations.every((reservation) => reservation.releasedAt === null)).toBe(
            true,
          );
          expect(output.previewSession?.allocations?.reservations).toEqual(state.reservations);
          expect(output.errors[0]?.message).toContain(
            `Capacity reservations recorded as held: ${held}; released: ${released}.`,
          );
          yield* f.sql`DROP TRIGGER fail_cleanup_completion`;
          yield* f.fileSystem.remove(f.credentialsDirectory, { recursive: true, force: true });
        }),
      ),
    )
    .pipe(
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

it.live("reports the ledger state when quarantine persistence fails after cleanup timeout", () =>
  Effect.gen(function* () {
    const testClock = yield* TestClock.testClockWith((clock) => Effect.succeed(clock));
    const now = () => testClock.currentTimeMillisUnsafe();
    const controller = yield* makePreviewSessionController(now);
    const created = yield* controller.create({
      owner: "cleanup-owner",
      checkout: "/tmp/cleanup-marker-write-failure",
      manifests: { "sheet-web": "sha256:manifest" },
      requestedRevision: "cleanup-marker-write-failure",
    });
    yield* controller.activate(
      created.session.id,
      created.session.generation,
      created.supervisorIdentity,
      "cleanup-marker-write-failure",
    );
    const allocations = yield* makePreviewAllocationController(
      {
        planProfile: () => Effect.fail(new Error("unused")),
        validateProfileAllocation: () => Effect.void,
        allocate: () => Effect.succeed("owned-resource"),
        deleteOwned: () => Effect.void,
        proveCleanup: () => Effect.succeed(true),
        resolveUnknown: () => Effect.fail(new Error("unused")),
      },
      now,
      undefined,
      true,
      10 * 60_000,
    );
    yield* Effect.forEach(previewCapacityDimensionsByGroup.auth, (dimension) =>
      allocations.observeCapacity({
        provider: "local-test",
        identity: "disposable",
        dimension,
        observedAt: now(),
        total: 1,
        inUse: 0,
        grantsVerified: true,
      }),
    );
    yield* allocations.reserveAndAllocate({
      sessionId: created.session.id,
      demands: previewCapacityDimensionsByGroup.auth.map((dimension) => ({
        dimension,
        amount: 1,
        provider: "local-test",
        identity: "disposable",
      })),
      resources: ["auth"],
    });
    yield* controller.stop(created.session.id, created.ownerIdentity);
    expect(yield* allocations.cleanup({ sessionId: created.session.id })).toBe("waiting");
    yield* TestClock.adjust(Duration.minutes(5));

    const sessionDatabase = path.join("/tmp", `preview-cleanup-marker-${randomUUID()}.sqlite`);
    const credentialsDirectory = `${sessionDatabase}.credentials`;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(credentialsDirectory, { recursive: true, mode: 0o700 });
    yield* fileSystem.writeFileString(
      path.join(credentialsDirectory, created.session.id),
      JSON.stringify({
        ownerIdentity: created.ownerIdentity,
        supervisorIdentity: created.supervisorIdentity,
      }),
      { mode: 0o600 },
    );
    const routeCleanupStarted = yield* Deferred.make<void>();
    const actualGateway = yield* makePreviewGateway({ domain: "", controller, now });
    const gateway: PreviewGatewayApi = {
      ...actualGateway,
      cleanupSession: () =>
        Deferred.succeed(routeCleanupStarted, undefined).pipe(Effect.andThen(Effect.never)),
    };
    const allocationsWithFailedQuarantineWrite: PreviewAllocationApi = {
      ...allocations,
      markCleanupUnconfirmed: () =>
        Effect.fail(new PreviewAllocationError({ reason: "test-marker-write-failure" })),
    };
    const command = parsePreviewAction(
      ["preview", "cleanup", "--session", created.session.id, "--json"],
      "cleanup",
    );
    const cleanup = yield* connectedPreviewOutput(command, {
      env: { TIARA_PREVIEW_SESSION_DATABASE: sessionDatabase },
      previewSessionController: controller,
      previewAllocationController: allocationsWithFailedQuarantineWrite,
      previewGateway: gateway,
    }).pipe(Effect.forkChild);
    yield* Deferred.await(routeCleanupStarted);
    yield* TestClock.adjust(Duration.minutes(5));
    yield* Effect.yieldNow;
    const observed = yield* Fiber.join(cleanup).pipe(
      Effect.timeoutOption(Duration.seconds(1)),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(1));
    const completed = yield* Fiber.join(observed);
    if (Option.isNone(completed)) yield* Fiber.interrupt(cleanup);

    expect(Option.isSome(completed)).toBe(true);
    if (Option.isNone(completed)) return;
    expect(completed.value.ok).toBe(false);
    expect(completed.value.previewSession?.allocations?.cleanup).toBe("waiting");
    expect(completed.value.errors[0]?.message).toContain("Quarantine could not be confirmed");
    expect(completed.value.errors[0]?.message).not.toContain("leftovers are quarantined");
    expect(completed.value.errors[0]?.message).not.toContain("test-marker-write-failure");
    const state = yield* allocations.inspect(created.session.id);
    expect(state.cleanup).toBe("waiting");
    expect(state.allocations[0]?.state).toBe("owned");
    expect(state.reservations[0]?.releasedAt).toBeNull();
    yield* fileSystem.remove(credentialsDirectory, { recursive: true, force: true });
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
