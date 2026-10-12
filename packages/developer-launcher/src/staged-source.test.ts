import { it } from "@effect/vitest";
import { Clock, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect";
import { TestClock as TestClockService } from "effect/testing";
import { describe, expect } from "vitest";
import { stagedSourceActivationTimeouts } from "sheet-workflow-contracts";
import {
  classifyWorkflowPreviewTransition,
  workflowRecreationTimeouts,
  workflowExecutionGroupIdentity,
  WorkflowExecutionError,
  type WorkflowExecutionArtifacts,
} from "./owned-workflow-execution";
import {
  activateCoalescedRunnerSnapshots,
  activateRunnerSnapshot,
  affectedRunnerRoles,
  classifySnapshotChange,
  coalesceSnapshotSaves,
  sealStagedSourceSnapshot,
  StagedRunnerRuntime,
  SnapshotRuntimeError,
  validateStagedSnapshot,
  type StagedRunnerRuntimeApi,
  type StagedSourceSnapshot,
} from "./staged-source";
import { workflowPreviewRuntimeContractCatalogIdentity } from "./workflow-runtime-contract-catalog";
import {
  boundOldCessation,
  boundOldWork,
  cessationEvidence,
  type OldProducerFenceInput,
  type OldWorkDrainInput,
  type OldWorkCessationInput,
  type OldWorkSettlementInput,
  drainedOldWork,
  producerFenceEvidence,
  settledOldWork,
  workflowDefinition,
} from "./workflow-recreation.test-fixtures";

const utf8File = (path: string, content: string, mode = 0o644) => ({
  path,
  contentEncoding: "utf8" as const,
  content,
  mode,
});

const snapshot = (
  revision: string,
  files: ReadonlyArray<readonly [string, string]> = [],
): StagedSourceSnapshot =>
  sealStagedSourceSnapshot(revision, [
    utf8File("package.json", '{"name":"workspace"}'),
    utf8File("pnpm-lock.yaml", "lockfileVersion: '9.0'"),
    ...files.map(([path, content]) => utf8File(path, content)),
  ]);

const withFileMode = (
  tree: StagedSourceSnapshot,
  path: string,
  mode: number,
): StagedSourceSnapshot =>
  sealStagedSourceSnapshot(
    tree.revision,
    tree.files.map((file) => (file.path === path ? { ...file, mode } : file)),
  );

const testWorkflowArtifacts = {
  api: "a".repeat(64),
  runner: "b".repeat(64),
  contracts: "c".repeat(64),
  deployment: "d".repeat(64),
  workflowVersion: "1.0.0",
  actionVersions: { "main-action": "1" },
};
const compatibleWorkflowTransition = (
  previous: StagedSourceSnapshot,
  proposed: StagedSourceSnapshot,
) => ({
  oldGroup: workflowExecutionGroupIdentity({
    sessionId: "test-old-session",
    ownerToken: "test-old-owner",
    generation: 1,
    database: "test_old_db",
    apiEndpoint: "https://test-old.dev.test",
    observationEndpoint: "https://test-old.dev.test/observe",
    artifacts: testWorkflowArtifacts,
    workloadOAuthClientIds: { ordinary_runner: "test-old-client" },
  }),
  previous: {
    ...workflowDefinition(previous.revision, testWorkflowArtifacts, [], ["ordinary_runner"]),
  },
  proposed: {
    ...workflowDefinition(proposed.revision, testWorkflowArtifacts, [], ["ordinary_runner"]),
  },
  explicitlyRequested: false,
});

const incompatibleWorkflowTransition = (
  previous: StagedSourceSnapshot,
  proposed: StagedSourceSnapshot,
) => ({
  ...compatibleWorkflowTransition(previous, proposed),
  proposed: workflowDefinition(
    proposed.revision,
    { ...testWorkflowArtifacts, workflowVersion: "2.0.0", actionVersions: { "main-action": "2" } },
    [],
    ["ordinary_runner"],
  ),
  explicitlyRequested: true,
});

const runtimeLayer = (
  overrides: Partial<StagedRunnerRuntimeApi> = {},
  options: { readonly omitActivationAuthority?: boolean } = {},
) =>
  Layer.sync(StagedRunnerRuntime, () => {
    const runtime: StagedRunnerRuntimeApi = {
      stageComplete: () => Effect.void,
      fenceOldOwner: () => Effect.void,
      activateComplete: () => Effect.void,
      retainImmutableRevision: () => Effect.void,
      rebuildArtifacts: () => Effect.void,
      restartRole: () => Effect.void,
      verifyActualReadiness: () => Effect.succeed(true),
      authorizeActivation: () => Effect.void,
      resolveWorkflowArtifacts: () => Effect.succeed(testWorkflowArtifacts),
      persistWorkflowRecreationDiagnostic: () => Effect.void,
      ...overrides,
    };
    if (!options.omitActivationAuthority) return runtime;
    const { authorizeActivation: _authorizeActivation, ...runtimeWithoutAuthority } = runtime;
    return runtimeWithoutAuthority;
  });

const activateWithRuntime = ({
  runtime: layer,
  ...input
}: Parameters<typeof activateRunnerSnapshot>[0] & {
  readonly runtime: ReturnType<typeof runtimeLayer>;
}) =>
  activateRunnerSnapshot({
    ...input,
    workflowTransition:
      input.workflowTransition ??
      (input.previous === null
        ? undefined
        : compatibleWorkflowTransition(input.previous, input.snapshot)),
  }).pipe(Effect.provide(layer));

const activateCoalescedWithRuntime = ({
  runtime: layer,
  ...input
}: Parameters<typeof activateCoalescedRunnerSnapshots>[0] & {
  readonly runtime: ReturnType<typeof runtimeLayer>;
}) => {
  const coalesced = coalesceSnapshotSaves(input.snapshots);
  const workflowTransition =
    input.workflowTransition ??
    (input.previous === null || coalesced === undefined
      ? undefined
      : compatibleWorkflowTransition(input.previous, coalesced));
  return activateCoalescedRunnerSnapshots({
    ...input,
    workflowTransition,
  }).pipe(Effect.provide(layer));
};

describe("staged source snapshots", () => {
  it.effect(
    "rejects a supplied transition without a previous snapshot before direct activation effects",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r0", [["src/workflow.ts", "old"]]);
        const proposed = snapshot("r1", [["src/workflow.ts", "new"]]);
        const events: string[] = [];
        const transition = incompatibleWorkflowTransition(previous, proposed);
        expect(
          classifyWorkflowPreviewTransition(transition.previous, transition.proposed)
            .classification,
        ).toBe("incompatible");
        const status = yield* activateWithRuntime({
          snapshot: proposed,
          previous: null,
          owner: "old-owner",
          nextOwner: "new-owner",
          workflowTransition: transition,
          runtime: runtimeLayer({
            stageComplete: () => Effect.sync(() => void events.push("stage")),
            fenceOldOwner: () => Effect.sync(() => void events.push("fence")),
            activateComplete: () => Effect.sync(() => void events.push("activate")),
          }),
        });

        expect(status.failure).toBe("workflow-transition-previous-snapshot-required");
        expect(status.activeRevision).toBeNull();
        expect(events).toEqual([]);
      }),
  );

  it.effect(
    "rejects a supplied transition without a previous snapshot through coalesced activation",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r0", [["src/workflow.ts", "old"]]);
        const proposed = snapshot("r1", [["src/workflow.ts", "new"]]);
        const events: string[] = [];
        const transition = incompatibleWorkflowTransition(previous, proposed);
        expect(
          classifyWorkflowPreviewTransition(transition.previous, transition.proposed)
            .classification,
        ).toBe("incompatible");
        const status = yield* activateCoalescedWithRuntime({
          snapshots: [proposed],
          previous: null,
          owner: "old-owner",
          nextOwner: "new-owner",
          workflowTransition: transition,
          runtime: runtimeLayer({
            stageComplete: () => Effect.sync(() => void events.push("stage")),
            fenceOldOwner: () => Effect.sync(() => void events.push("fence")),
            activateComplete: () => Effect.sync(() => void events.push("activate")),
          }),
        });

        expect(status.failure).toBe("workflow-transition-previous-snapshot-required");
        expect(status.activeRevision).toBeNull();
        expect(events).toEqual([]);
      }),
  );

  it.effect("allows a transition-free first activation without a previous snapshot", () =>
    Effect.gen(function* () {
      const first = snapshot("r1", [["src/workflow.ts", "initial"]]);
      const events: string[] = [];
      const status = yield* activateWithRuntime({
        snapshot: first,
        previous: null,
        owner: "first-owner",
        nextOwner: "first-owner",
        runtime: runtimeLayer({
          stageComplete: () => Effect.sync(() => void events.push("stage")),
          fenceOldOwner: () => Effect.sync(() => void events.push("fence")),
          activateComplete: () => Effect.sync(() => void events.push("activate")),
          verifyActualReadiness: () =>
            Effect.sync(() => {
              events.push("ready");
              return true;
            }),
        }),
      });

      expect(status.failure).toBeNull();
      expect(status.activeRevision).toBe("r1");
      expect(events).toEqual(["stage", "fence", "activate", "ready"]);
    }),
  );

  it.effect(
    "fails closed on missing or rejected compatible activation authority before staging",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
        const proposed = snapshot("r2", [["src/workflow.ts", "compatible update"]]);
        const transition = compatibleWorkflowTransition(previous, proposed);
        const missingEvents: Array<string> = [];
        const missing = yield* activateWithRuntime({
          snapshot: proposed,
          previous,
          owner: "old-owner",
          nextOwner: "next-owner",
          workflowTransition: transition,
          runtime: runtimeLayer(
            {
              stageComplete: () => Effect.sync(() => void missingEvents.push("stage")),
              fenceOldOwner: () => Effect.sync(() => void missingEvents.push("fence")),
              activateComplete: () => Effect.sync(() => void missingEvents.push("activate")),
            },
            { omitActivationAuthority: true },
          ),
        });

        expect(transition.proposed.compatibility.declarations[0]?.classification).toBe(
          "compatible",
        );
        expect(missing.failure).toBe("snapshot-activation-authority-unavailable");
        expect(missing.activeRevision).toBe("r1");
        expect(missingEvents).toEqual([]);

        const rejectedEvents: Array<string> = [];
        const rejected = yield* activateWithRuntime({
          snapshot: proposed,
          previous,
          owner: "old-owner",
          nextOwner: "next-owner",
          workflowTransition: transition,
          runtime: runtimeLayer({
            authorizeActivation: (request) =>
              Effect.sync(() => {
                expect(request.previous?.revision).toBe(previous.revision);
                expect(request.proposed.revision).toBe(proposed.revision);
                expect(request.workflowTransition?.explicitlyRequested).toBe(false);
                rejectedEvents.push("authorize");
              }).pipe(
                Effect.andThen(
                  Effect.fail(new SnapshotRuntimeError({ reason: "controlled-authority-denial" })),
                ),
              ),
            stageComplete: () => Effect.sync(() => void rejectedEvents.push("stage")),
            fenceOldOwner: () => Effect.sync(() => void rejectedEvents.push("fence")),
            activateComplete: () => Effect.sync(() => void rejectedEvents.push("activate")),
          }),
        });

        expect(rejected.failure).toBe("snapshot-activation-authority-rejected");
        expect(rejected.activeRevision).toBe("r1");
        expect(rejectedEvents).toEqual(["authorize"]);

        const timeoutStarted = yield* Deferred.make<void>();
        const timeoutEvents: Array<string> = [];
        const timeoutFiber = yield* activateWithRuntime({
          snapshot: proposed,
          previous,
          owner: "old-owner",
          nextOwner: "next-owner",
          workflowTransition: transition,
          runtime: runtimeLayer({
            authorizeActivation: () =>
              Effect.sync(() => {
                timeoutEvents.push("authorize");
                return Deferred.succeed(timeoutStarted, undefined);
              }).pipe(Effect.flatten, Effect.andThen(Effect.never)),
            stageComplete: () => Effect.sync(() => void timeoutEvents.push("stage")),
            fenceOldOwner: () => Effect.sync(() => void timeoutEvents.push("fence")),
            activateComplete: () => Effect.sync(() => void timeoutEvents.push("activate")),
          }),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(timeoutStarted);
        yield* TestClockService.adjust(stagedSourceActivationTimeouts.authority);
        yield* Effect.yieldNow;
        const timedOut = yield* Fiber.join(timeoutFiber);
        expect(timedOut.failure).toBe("snapshot-activation-authority-timeout");
        expect(timedOut.activeRevision).toBe("r1");
        expect(timeoutEvents).toEqual(["authorize"]);
      }),
  );

  it.effect(
    "rejects missing activation authority before an incompatible recreation lifecycle",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
        const proposed = snapshot("r2", [["src/workflow.ts", "new"]]);
        const transition = incompatibleWorkflowTransition(previous, proposed);
        const events: Array<string> = [];
        const record = (event: string) =>
          Effect.sync(() => {
            events.push(event);
          });
        const workflowRecreation = {
          presentProposal: () => record("proposal"),
          pauseAdmission: () => record("admission-pause"),
          fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
            Effect.sync(() => {
              events.push("producer-fence");
              return producerFenceEvidence(expectedBinding);
            }),
          drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
            Effect.succeed(drainedOldWork(expectedBinding)),
          settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
            Effect.sync(() => {
              events.push("old-work-settlement");
              return settledOldWork(expectedBinding);
            }),
          proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
            Effect.sync(() => {
              events.push("old-cessation");
              return cessationEvidence(expectedBinding);
            }),
          endOldSessionAndCleanup: () =>
            Effect.sync(() => {
              events.push("old-session-cleanup");
              return "cleanup-r1";
            }),
          provisionFreshGroup: () =>
            Effect.sync(() => {
              events.push("fresh-group-provision");
              return {};
            }),
          quarantine: () => record("old-group-quarantine"),
          blockOrdinaryReassignment: () =>
            Effect.sync(() => {
              events.push("reassignment-fence");
              return false;
            }),
        };
        const status = yield* activateWithRuntime({
          snapshot: proposed,
          previous,
          owner: "old-owner",
          nextOwner: "new-owner",
          workflowTransition: transition,
          runtime: runtimeLayer(
            {
              stageComplete: () => record("stage"),
              fenceOldOwner: () => record("fence-source-owner"),
              activateComplete: () => record("activate"),
              workflowRecreation,
              resolveWorkflowArtifacts: () => Effect.succeed(transition.proposed.artifacts),
            },
            { omitActivationAuthority: true },
          ),
        });

        expect(transition.proposed.artifacts.workflowVersion).toBe("2.0.0");
        expect(status.failure).toBe("snapshot-activation-authority-unavailable");
        expect(status.activeRevision).toBe(previous.revision);
        expect(events).toEqual([]);
      }),
  );

  it.effect(
    "rejects denied or timed-out authority before destructive incompatible recreation",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
        const proposed = snapshot("r2", [["src/workflow.ts", "new"]]);
        const transition = incompatibleWorkflowTransition(previous, proposed);
        const makeLifecycle = (events: Array<string>) => {
          const record = (event: string) =>
            Effect.sync(() => {
              events.push(event);
            });
          return {
            presentProposal: () => record("proposal"),
            pauseAdmission: () => record("admission-pause"),
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.sync(() => {
                events.push("producer-fence");
                return producerFenceEvidence(expectedBinding);
              }),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Effect.succeed(drainedOldWork(expectedBinding)),
            settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
              Effect.sync(() => {
                events.push("old-work-settlement");
                return settledOldWork(expectedBinding);
              }),
            proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
              Effect.sync(() => {
                events.push("old-cessation");
                return cessationEvidence(expectedBinding);
              }),
            endOldSessionAndCleanup: () =>
              Effect.sync(() => {
                events.push("old-session-cleanup");
                return "cleanup-r1";
              }),
            provisionFreshGroup: () =>
              Effect.sync(() => {
                events.push("fresh-group-provision");
                return {};
              }),
            quarantine: () => record("old-group-quarantine"),
            blockOrdinaryReassignment: () =>
              Effect.sync(() => {
                events.push("reassignment-fence");
                return false;
              }),
          };
        };

        const deniedEvents: Array<string> = [];
        const denied = yield* activateWithRuntime({
          snapshot: proposed,
          previous,
          owner: "old-owner",
          nextOwner: "new-owner",
          workflowTransition: transition,
          runtime: runtimeLayer({
            authorizeActivation: (request) =>
              Effect.sync(() => {
                expect(request.workflowTransition?.explicitlyRequested).toBe(true);
                expect(request.workflowTransition?.proposed.artifacts).toEqual(
                  transition.proposed.artifacts,
                );
                deniedEvents.push("authorize");
              }).pipe(
                Effect.andThen(
                  Effect.fail(new SnapshotRuntimeError({ reason: "controlled-authority-denial" })),
                ),
              ),
            stageComplete: () => Effect.sync(() => void deniedEvents.push("stage")),
            workflowRecreation: makeLifecycle(deniedEvents),
            resolveWorkflowArtifacts: () => Effect.succeed(transition.proposed.artifacts),
          }),
        });
        expect(denied.failure).toBe("snapshot-activation-authority-rejected");
        expect(denied.activeRevision).toBe(previous.revision);
        expect(deniedEvents).toEqual(["authorize"]);

        const timeoutStarted = yield* Deferred.make<void>();
        const timeoutEvents: Array<string> = [];
        const timeoutFiber = yield* activateWithRuntime({
          snapshot: proposed,
          previous,
          owner: "old-owner",
          nextOwner: "new-owner",
          workflowTransition: transition,
          runtime: runtimeLayer({
            authorizeActivation: () =>
              Effect.sync(() => {
                timeoutEvents.push("authorize");
                return Deferred.succeed(timeoutStarted, undefined);
              }).pipe(Effect.flatten, Effect.andThen(Effect.never)),
            stageComplete: () => Effect.sync(() => void timeoutEvents.push("stage")),
            workflowRecreation: makeLifecycle(timeoutEvents),
            resolveWorkflowArtifacts: () => Effect.succeed(transition.proposed.artifacts),
          }),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(timeoutStarted);
        yield* TestClockService.adjust(stagedSourceActivationTimeouts.authority);
        yield* Effect.yieldNow;
        const timedOut = yield* Fiber.join(timeoutFiber);
        expect(timedOut.failure).toBe("snapshot-activation-authority-timeout");
        expect(timedOut.activeRevision).toBe(previous.revision);
        expect(timeoutEvents).toEqual(["authorize"]);
      }),
  );

  it.effect("does not activate a changed snapshot with missing compatibility declarations", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
      const next = snapshot("r2", [["src/workflow.ts", "new"]]);
      const oldGroup = workflowExecutionGroupIdentity({
        sessionId: "unverified-transition-session",
        ownerToken: "old-owner",
        generation: 1,
        database: "unverified_transition_db",
        apiEndpoint: "https://unverified-transition.dev.test",
        observationEndpoint: "https://unverified-transition.dev.test/observe",
        artifacts: testWorkflowArtifacts,
        workloadOAuthClientIds: { ordinary_runner: "unverified-transition-client" },
      });
      const events: string[] = [];
      const status = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "old-owner",
        nextOwner: "new-owner",
        workflowTransition: {
          oldGroup,
          previous: workflowDefinition(
            previous.revision,
            testWorkflowArtifacts,
            ["workflow-execution"],
            ["ordinary_runner"],
          ),
          proposed: {
            ...workflowDefinition(
              next.revision,
              testWorkflowArtifacts,
              ["workflow-execution"],
              ["ordinary_runner"],
            ),
            compatibility: {
              catalogVersion: 1,
              catalogDigest: workflowPreviewRuntimeContractCatalogIdentity.digest,
              declarations: [],
            },
          },
          explicitlyRequested: true,
        },
        runtime: runtimeLayer({
          stageComplete: () => Effect.sync(() => void events.push("stage")),
          activateComplete: () => Effect.sync(() => void events.push("activate")),
        }),
      });

      expect(status.failure).toBe("workflow-transition-compatibility-evidence-unverified");
      expect(events).toEqual([]);
    }),
  );

  it.effect("does not stage when a known workflow role lacks its expected runner digest", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
      const next = snapshot("r2", [["src/workflow.ts", "new"]]);
      const completeArtifacts: WorkflowExecutionArtifacts = {
        ...testWorkflowArtifacts,
        runner: "e".repeat(64),
        runnerArtifacts: {
          ordinary_runner: "e".repeat(64),
          browser_runner: "f".repeat(64),
        },
      };
      const missingBrowserDigest: WorkflowExecutionArtifacts = {
        ...completeArtifacts,
        runnerArtifacts: { ordinary_runner: "e".repeat(64) },
      };
      const roles = ["workflow_api", "ordinary_runner", "browser_runner"];
      const oldGroup = workflowExecutionGroupIdentity({
        sessionId: "missing-browser-digest-session",
        ownerToken: "old-owner",
        generation: 1,
        database: "missing_browser_digest_db",
        apiEndpoint: "https://missing-browser-digest.dev.test",
        observationEndpoint: "https://missing-browser-digest.dev.test/observe",
        artifacts: completeArtifacts,
        workloadOAuthClientIds: {
          workflow_api: "old-api-client",
          ordinary_runner: "old-ordinary-client",
          browser_runner: "old-browser-client",
        },
      });
      const events: string[] = [];
      const status = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "old-owner",
        nextOwner: "new-owner",
        workflowTransition: {
          oldGroup,
          previous: workflowDefinition(
            previous.revision,
            completeArtifacts,
            ["workflow-execution"],
            roles,
          ),
          proposed: workflowDefinition(
            next.revision,
            missingBrowserDigest,
            ["workflow-execution"],
            roles,
          ),
          explicitlyRequested: false,
        },
        runtime: runtimeLayer({
          resolveWorkflowArtifacts: () => Effect.succeed(missingBrowserDigest),
          stageComplete: () => Effect.sync(() => void events.push("stage")),
          activateComplete: () => Effect.sync(() => void events.push("activate")),
        }),
      });

      expect(status.failure).toBe("workflow-transition-compatibility-evidence-unverified");
      expect(events).toEqual([]);
    }),
  );

  it.effect("rejects automatic incompatible activation at the common staged-source lifecycle", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
      const next = snapshot("r2", [["src/workflow.ts", "new"]]);
      const artifacts = {
        api: "a".repeat(64),
        runner: "b".repeat(64),
        contracts: "c".repeat(64),
        deployment: "d".repeat(64),
        workflowVersion: "1.0.0",
        actionVersions: { "main-action": "1" },
      };
      const oldGroup = workflowExecutionGroupIdentity({
        sessionId: "old-session",
        ownerToken: "old-owner",
        generation: 1,
        database: "old_database",
        apiEndpoint: "https://old.dev.test",
        observationEndpoint: "https://old.dev.test/observe",
        artifacts,
        workloadOAuthClientIds: { ordinary_runner: "old-client" },
      });
      const events: string[] = [];
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "old-owner",
        nextOwner: "new-owner",
        workflowTransition: {
          oldGroup,
          previous: workflowDefinition(
            previous.revision,
            artifacts,
            ["workflow-execution"],
            ["ordinary_runner"],
          ),
          proposed: workflowDefinition(
            next.revision,
            { ...artifacts, workflowVersion: "2.0.0" },
            ["workflow-execution"],
            ["ordinary_runner"],
          ),
          explicitlyRequested: false,
        },
        runtime: runtimeLayer({
          workflowRecreation: {
            presentProposal: () => Effect.sync(() => void events.push("proposal")),
            pauseAdmission: () => Effect.sync(() => void events.push("pause")),
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.succeed(producerFenceEvidence(expectedBinding)),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Effect.succeed(drainedOldWork(expectedBinding)),
            settleWithOldCode: boundOldWork,
            proveOldCessation: boundOldCessation,
            endOldSessionAndCleanup: () => Effect.succeed("cleanup"),
            provisionFreshGroup: () => Effect.succeed({}),
            quarantine: () => Effect.void,
            blockOrdinaryReassignment: () => Effect.succeed(true),
          },
          stageComplete: () => Effect.sync(() => void events.push("stage")),
          activateComplete: () => Effect.sync(() => void events.push("activate")),
          verifyActualReadiness: () =>
            Effect.sync(() => {
              events.push("readiness");
              return true;
            }),
          resolveWorkflowArtifacts: () =>
            Effect.succeed({ ...artifacts, workflowVersion: "2.0.0" }),
        }),
      });
      expect(result.failure).toBe("incompatible-workflow-transition-requires-explicit-recreation");
      expect(events).toEqual(["proposal", "pause"]);
      expect(result.workflowTransitionPhases).toMatchObject({
        proposal: "presented",
        admission: "paused",
        producerFencing: "not-started",
      });
    }),
  );

  it.effect("rejects automatic required-group removal before staging or activation", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
      const next = snapshot("r2", [["src/workflow.ts", "new"]]);
      const oldGroup = workflowExecutionGroupIdentity({
        sessionId: "group-removal-session",
        ownerToken: "group-removal-owner",
        generation: 3,
        database: "group_removal_db",
        apiEndpoint: "https://group-removal.dev.test",
        observationEndpoint: "https://group-removal.dev.test/observe",
        artifacts: testWorkflowArtifacts,
        workloadOAuthClientIds: { ordinary_runner: "group-removal-runner" },
      });
      const previousDefinition = workflowDefinition(
        previous.revision,
        testWorkflowArtifacts,
        ["workflow-execution", "browser"],
        ["ordinary_runner"],
      );
      const proposedDefinition = workflowDefinition(
        next.revision,
        testWorkflowArtifacts,
        ["workflow-execution"],
        ["ordinary_runner"],
      );
      expect(
        classifyWorkflowPreviewTransition(previousDefinition, proposedDefinition),
      ).toMatchObject({
        classification: "incompatible",
        reasons: ["workflow-group-removed"],
      });
      const events: string[] = [];
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: oldGroup.ownerToken,
        nextOwner: "next-owner",
        workflowTransition: {
          oldGroup,
          previous: previousDefinition,
          proposed: proposedDefinition,
          explicitlyRequested: false,
        },
        runtime: runtimeLayer({
          workflowRecreation: {
            presentProposal: () => Effect.sync(() => void events.push("proposal")),
            pauseAdmission: () => Effect.sync(() => void events.push("pause")),
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.succeed(producerFenceEvidence(expectedBinding)),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Effect.succeed(drainedOldWork(expectedBinding)),
            settleWithOldCode: boundOldWork,
            proveOldCessation: boundOldCessation,
            endOldSessionAndCleanup: () => Effect.succeed("cleanup"),
            provisionFreshGroup: () => Effect.succeed({}),
            quarantine: () => Effect.void,
            blockOrdinaryReassignment: () => Effect.succeed(false),
          },
          stageComplete: () => Effect.sync(() => void events.push("stage")),
          activateComplete: () => Effect.sync(() => void events.push("activate")),
        }),
      });

      expect(result.failure).toBe("incompatible-workflow-transition-requires-explicit-recreation");
      expect(events).toEqual(["proposal", "pause"]);
    }),
  );

  it.effect("requires controlled recreation when an automatic edit removes a workflow role", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
      const next = snapshot("r2", [["src/workflow.ts", "new"]]);
      const artifacts: WorkflowExecutionArtifacts = { ...testWorkflowArtifacts };
      const previousArtifacts: WorkflowExecutionArtifacts = {
        ...artifacts,
        runner: "e".repeat(64),
        runnerArtifacts: {
          ordinary_runner: "e".repeat(64),
          browser_runner: "f".repeat(64),
        },
      };
      const proposedArtifacts: WorkflowExecutionArtifacts = {
        ...previousArtifacts,
        runnerArtifacts: { ordinary_runner: "e".repeat(64) },
      };
      const previousRoles = ["workflow_api", "ordinary_runner", "browser_runner"];
      const proposedRoles = ["workflow_api", "ordinary_runner"];
      const oldGroup = workflowExecutionGroupIdentity({
        sessionId: "role-removal-session",
        ownerToken: "role-removal-owner",
        generation: 1,
        database: "role_removal_db",
        apiEndpoint: "https://role-removal.dev.test",
        observationEndpoint: "https://role-removal.dev.test/observe",
        artifacts: previousArtifacts,
        workloadOAuthClientIds: {
          workflow_api: "old-api-client",
          ordinary_runner: "old-ordinary-client",
          browser_runner: "old-browser-client",
        },
      });
      const events: string[] = [];
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: oldGroup.ownerToken,
        nextOwner: "next-owner",
        workflowTransition: {
          oldGroup,
          previous: workflowDefinition(
            previous.revision,
            previousArtifacts,
            ["workflow-execution"],
            previousRoles,
          ),
          proposed: workflowDefinition(
            next.revision,
            proposedArtifacts,
            ["workflow-execution"],
            proposedRoles,
          ),
          explicitlyRequested: false,
        },
        runtime: runtimeLayer({
          workflowRecreation: {
            presentProposal: () => Effect.sync(() => void events.push("proposal")),
            pauseAdmission: () => Effect.sync(() => void events.push("pause")),
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.succeed(producerFenceEvidence(expectedBinding)),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Effect.succeed(drainedOldWork(expectedBinding)),
            settleWithOldCode: boundOldWork,
            proveOldCessation: boundOldCessation,
            endOldSessionAndCleanup: () => Effect.succeed("cleanup"),
            provisionFreshGroup: () => Effect.succeed({}),
            quarantine: () => Effect.void,
            blockOrdinaryReassignment: () => Effect.succeed(true),
          },
          resolveWorkflowArtifacts: () => Effect.succeed(proposedArtifacts),
          stageComplete: () => Effect.sync(() => void events.push("stage")),
          activateComplete: () => Effect.sync(() => void events.push("activate")),
        }),
      });

      expect(result.failure).toBe("incompatible-workflow-transition-requires-explicit-recreation");
      expect(events).toEqual(["proposal", "pause"]);
      expect(result.workflowTransitionPhases).toMatchObject({
        proposal: "presented",
        admission: "paused",
        producerFencing: "not-started",
      });
    }),
  );

  it.effect(
    "retains current proposal and admission phases when automatic watch callbacks fail",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
        const next = snapshot("r2", [["src/workflow.ts", "new"]]);
        const artifacts = { ...testWorkflowArtifacts };
        const oldGroup = workflowExecutionGroupIdentity({
          sessionId: "watch-failure-old",
          ownerToken: "watch-failure-owner",
          generation: 1,
          database: "watch_failure_db",
          apiEndpoint: "https://watch-failure.dev.test",
          observationEndpoint: "https://watch-failure.dev.test/observe",
          artifacts,
          workloadOAuthClientIds: { ordinary_runner: "watch-failure-client" },
        });
        const transition = {
          oldGroup,
          previous: workflowDefinition(
            previous.revision,
            artifacts,
            ["workflow-execution"],
            ["ordinary_runner"],
          ),
          proposed: workflowDefinition(
            next.revision,
            { ...artifacts, workflowVersion: "2.0.0" },
            ["workflow-execution"],
            ["ordinary_runner"],
          ),
          explicitlyRequested: false,
        };
        const run = (failedPhase: "proposal" | "admission") =>
          activateWithRuntime({
            snapshot: next,
            previous,
            owner: oldGroup.ownerToken,
            nextOwner: "next-owner",
            workflowTransition: transition,
            runtime: runtimeLayer({
              resolveWorkflowArtifacts: () => Effect.succeed(transition.proposed.artifacts),
              workflowRecreation: {
                presentProposal: () =>
                  failedPhase === "proposal"
                    ? Effect.fail(new WorkflowExecutionError({ reason: "proposal-failed" }))
                    : Effect.void,
                pauseAdmission: () =>
                  failedPhase === "admission"
                    ? Effect.fail(new WorkflowExecutionError({ reason: "pause-failed" }))
                    : Effect.void,
                fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
                  Effect.succeed(producerFenceEvidence(expectedBinding)),
                drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
                  Effect.succeed(drainedOldWork(expectedBinding)),
                settleWithOldCode: boundOldWork,
                proveOldCessation: boundOldCessation,
                endOldSessionAndCleanup: () => Effect.succeed("unused-cleanup"),
                provisionFreshGroup: () => Effect.succeed({}),
                quarantine: () => Effect.void,
                blockOrdinaryReassignment: () => Effect.succeed(true),
              },
            }),
          });

        const proposalFailure = yield* run("proposal");
        expect(proposalFailure.failure).toBe("workflow-proposal-unavailable");
        expect(proposalFailure.workflowTransitionPhases).toMatchObject({
          proposal: "unconfirmed",
          admission: "not-started",
        });
        const admissionFailure = yield* run("admission");
        expect(admissionFailure.failure).toBe("workflow-admission-pause-unconfirmed");
        expect(admissionFailure.workflowTransitionPhases).toMatchObject({
          proposal: "presented",
          admission: "unconfirmed",
          producerFencing: "not-started",
        });
      }),
  );

  it.effect("bounds automatic watch proposal and admission callbacks", () =>
    Effect.gen(function* () {
      const run = (timedOutPhase: "proposal" | "admission") =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const testClock = yield* TestClockService.testClockWith((clock) => Effect.succeed(clock));
          const providerTimeoutStarted = yield* Deferred.make<void>();
          const controlledClock: Clock.Clock = {
            ...testClock,
            sleep: (duration) =>
              Duration.toMillis(duration) === 60_000
                ? Deferred.succeed(providerTimeoutStarted, undefined).pipe(
                    Effect.andThen(testClock.sleep(duration)),
                  )
                : testClock.sleep(duration),
          };
          const events: string[] = [];
          const previous = snapshot(`${timedOutPhase}-r1`, [["src/workflow.ts", "old"]]);
          const next = snapshot(`${timedOutPhase}-r2`, [["src/workflow.ts", "new"]]);
          const explicitTransition = incompatibleWorkflowTransition(previous, next);
          const transition = { ...explicitTransition, explicitlyRequested: false };
          const waitForCallback = (phase: "proposal" | "admission") =>
            Effect.gen(function* () {
              events.push(phase);
              yield* Deferred.succeed(started, undefined);
              return yield* Effect.never;
            });
          const runtime = runtimeLayer({
            stageComplete: () => Effect.sync(() => void events.push("stage")),
            resolveWorkflowArtifacts: () => Effect.succeed(transition.proposed.artifacts),
            workflowRecreation: {
              presentProposal: () =>
                timedOutPhase === "proposal"
                  ? waitForCallback("proposal")
                  : Effect.sync(() => void events.push("proposal")),
              pauseAdmission: () =>
                timedOutPhase === "admission"
                  ? waitForCallback("admission")
                  : Effect.sync(() => void events.push("admission")),
              fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
                Effect.succeed(producerFenceEvidence(expectedBinding)),
              drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
                Effect.succeed(drainedOldWork(expectedBinding)),
              settleWithOldCode: boundOldWork,
              proveOldCessation: boundOldCessation,
              endOldSessionAndCleanup: () => Effect.succeed("unused-cleanup"),
              provisionFreshGroup: () => Effect.succeed({}),
              quarantine: () => Effect.void,
              blockOrdinaryReassignment: () => Effect.succeed(true),
            },
          }).pipe(Layer.provideMerge(Layer.succeed(Clock.Clock, controlledClock)));
          const activation = activateRunnerSnapshot({
            snapshot: next,
            previous,
            owner: transition.oldGroup.ownerToken,
            nextOwner: "next-owner",
            workflowTransition: transition,
          }).pipe(
            Effect.provide(runtime),
            Effect.map((status) => ({ _tag: "status" as const, status })),
          );
          const fiber = yield* activation.pipe(Effect.forkChild);
          const timeoutSignal = yield* Effect.race(
            Deferred.await(providerTimeoutStarted).pipe(Effect.as(true)),
            Effect.as(Effect.sleep(Duration.seconds(120)), false),
          ).pipe(Effect.forkChild);

          yield* Deferred.await(started);
          for (
            let attempt = 0;
            attempt < 10 && timeoutSignal.pollUnsafe() === undefined;
            attempt += 1
          )
            yield* Effect.yieldNow;
          if (timeoutSignal.pollUnsafe() === undefined)
            yield* TestClockService.adjust(Duration.seconds(120));
          const providerTimedOut = yield* Fiber.join(timeoutSignal);
          expect(providerTimedOut).toBe(true);
          if (!providerTimedOut) return;
          yield* Effect.yieldNow;
          yield* TestClockService.adjust(Duration.seconds(60));
          const outcome = yield* Fiber.join(fiber);

          expect(outcome._tag).toBe("status");
          if (outcome._tag !== "status") return;
          expect(outcome.status.failure).toBe(
            timedOutPhase === "proposal"
              ? "workflow-proposal-unavailable"
              : "workflow-admission-pause-unconfirmed",
          );
          expect(outcome.status.workflowTransitionPhases).toMatchObject(
            timedOutPhase === "proposal"
              ? { proposal: "unconfirmed", admission: "not-started" }
              : { proposal: "presented", admission: "unconfirmed" },
          );
          expect(events).toEqual(
            timedOutPhase === "proposal" ? ["proposal"] : ["proposal", "admission"],
          );
          expect(events).not.toContain("stage");
        });

      expect(workflowRecreationTimeouts.providerOperation).toBe("60 seconds");
      yield* run("proposal");
      yield* run("admission");
    }),
  );

  it.effect(
    "rejects stale previous workflow declarations before compatibility can bypass recreation",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
        const next = snapshot("r2", [["src/workflow.ts", "new"]]);
        const mismatchedArtifacts = { ...testWorkflowArtifacts, contracts: "e".repeat(64) };
        const oldGroup = workflowExecutionGroupIdentity({
          sessionId: "authoritative-old-session",
          ownerToken: "authoritative-old-owner",
          generation: 1,
          database: "authoritative_old_db",
          apiEndpoint: "https://authoritative-old.dev.test",
          observationEndpoint: "https://authoritative-old.dev.test/observe",
          artifacts: testWorkflowArtifacts,
          workloadOAuthClientIds: { ordinary_runner: "old-runner-client" },
        });
        const events: string[] = [];
        const result = yield* activateWithRuntime({
          snapshot: next,
          previous,
          owner: "old-owner",
          nextOwner: "new-owner",
          workflowTransition: {
            oldGroup,
            previous: workflowDefinition(
              previous.revision,
              mismatchedArtifacts,
              ["workflow-execution"],
              ["ordinary_runner"],
            ),
            proposed: workflowDefinition(
              next.revision,
              mismatchedArtifacts,
              ["workflow-execution"],
              ["ordinary_runner"],
            ),
            explicitlyRequested: false,
          },
          runtime: runtimeLayer({
            stageComplete: () => Effect.sync(() => void events.push("stage")),
            activateComplete: () => Effect.sync(() => void events.push("activate")),
            resolveWorkflowArtifacts: () => Effect.succeed(mismatchedArtifacts),
          }),
        });
        expect(result.failure).toBe("workflow-old-group-artifact-mismatch");
        expect(events).toEqual([]);
      }),
  );

  it.effect("rejects proposed artifacts that do not describe the complete staged snapshot", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
      const next = snapshot("r2", [["src/workflow.ts", "new"]]);
      const oldGroup = workflowExecutionGroupIdentity({
        sessionId: "artifact-old-session",
        ownerToken: "artifact-old-owner",
        generation: 1,
        database: "artifact_old_db",
        apiEndpoint: "https://artifact-old.dev.test",
        observationEndpoint: "https://artifact-old.dev.test/observe",
        artifacts: testWorkflowArtifacts,
        workloadOAuthClientIds: { ordinary_runner: "artifact-old-client" },
      });
      const proposedArtifacts = {
        ...testWorkflowArtifacts,
        actionVersions: { "main-action": "2" },
      };
      const events: string[] = [];
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "old-owner",
        nextOwner: "new-owner",
        workflowTransition: {
          oldGroup,
          previous: workflowDefinition(
            previous.revision,
            testWorkflowArtifacts,
            ["workflow-execution"],
            ["ordinary_runner"],
          ),
          proposed: workflowDefinition(
            next.revision,
            proposedArtifacts,
            ["workflow-execution"],
            ["ordinary_runner"],
          ),
          explicitlyRequested: true,
        },
        runtime: runtimeLayer({
          workflowRecreation: {
            presentProposal: () => Effect.sync(() => void events.push("proposal")),
            pauseAdmission: () => Effect.sync(() => void events.push("pause")),
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.succeed(producerFenceEvidence(expectedBinding)),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Effect.succeed(drainedOldWork(expectedBinding)),
            settleWithOldCode: boundOldWork,
            proveOldCessation: boundOldCessation,
            endOldSessionAndCleanup: () => Effect.succeed("unexpected-cleanup"),
            provisionFreshGroup: () => Effect.succeed({}),
            quarantine: () => Effect.void,
            blockOrdinaryReassignment: () => Effect.succeed(true),
          },
          resolveWorkflowArtifacts: () => Effect.succeed(testWorkflowArtifacts),
          stageComplete: () => Effect.sync(() => void events.push("stage")),
          activateComplete: () => Effect.sync(() => void events.push("activate")),
        }),
      });
      expect(result.failure).toBe("workflow-proposed-snapshot-artifact-mismatch");
      expect(events).toEqual([]);
    }),
  );

  it.effect(
    "settles with old code and provisions an empty fresh group before staged activation",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
        const next = snapshot("r2", [["src/workflow.ts", "new"]]);
        const artifacts = {
          api: "a".repeat(64),
          runner: "b".repeat(64),
          contracts: "c".repeat(64),
          deployment: "d".repeat(64),
          workflowVersion: "1.0.0",
          actionVersions: { "main-action": "1" },
        };
        const proposedArtifacts = {
          ...artifacts,
          api: "e".repeat(64),
          runner: "f".repeat(64),
          workflowVersion: "2.0.0",
          actionVersions: { "main-action": "2" },
        };
        const makeGroup = (
          sessionId: string,
          ownerToken: string,
          groupArtifacts: typeof artifacts,
        ) =>
          workflowExecutionGroupIdentity({
            sessionId,
            ownerToken,
            generation: 1,
            database: `${sessionId.replaceAll("-", "_")}_db`,
            apiEndpoint: `https://${sessionId}.dev.test`,
            observationEndpoint: `https://${sessionId}.dev.test/observe`,
            artifacts: groupArtifacts,
            workloadOAuthClientIds: { ordinary_runner: `client-${sessionId}` },
          });
        const oldGroup = makeGroup("old-session", "old-owner", artifacts);
        const freshGroup = makeGroup("fresh-session", "fresh-owner", proposedArtifacts);
        const events: string[] = [];
        const result = yield* activateWithRuntime({
          snapshot: next,
          previous,
          owner: "old-owner",
          nextOwner: "fresh-owner",
          workflowTransition: {
            oldGroup,
            previous: workflowDefinition(
              previous.revision,
              artifacts,
              ["workflow-execution"],
              ["ordinary_runner"],
            ),
            proposed: workflowDefinition(
              next.revision,
              proposedArtifacts,
              ["workflow-execution"],
              ["ordinary_runner"],
            ),
            explicitlyRequested: true,
          },
          runtime: runtimeLayer({
            workflowRecreation: {
              presentProposal: () => Effect.sync(() => void events.push("proposal")),
              pauseAdmission: () => Effect.sync(() => void events.push("pause")),
              fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
                Effect.succeed(producerFenceEvidence(expectedBinding)),
              drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
                Effect.succeed(drainedOldWork(expectedBinding)),
              settleWithOldCode: ({ oldArtifacts, expectedBinding }) =>
                Effect.sync(() => {
                  expect(oldArtifacts).toEqual(artifacts);
                  events.push("settle-old-code");
                  return settledOldWork(expectedBinding);
                }),
              proveOldCessation: ({ expectedBinding }) =>
                Effect.sync(() => {
                  events.push("prove-cessation");
                  return cessationEvidence(expectedBinding);
                }),
              endOldSessionAndCleanup: () =>
                Effect.sync(() => {
                  events.push("cleanup-old-session");
                  return "cleanup-old-42";
                }),
              provisionFreshGroup: (input) =>
                Effect.sync(() => {
                  expect(input.transferPendingWork).toBe(false);
                  events.push("provision-fresh-group");
                  return {
                    group: freshGroup,
                    requiredGroups: input.requiredGroups,
                    workloadOAuthClientIds: freshGroup.workloadOAuthClientIds,
                    priorCleanupRecordId: "cleanup-old-42",
                    pendingCommands: 0,
                    browserQueueEntries: 0,
                    responseReferences: 0,
                  };
                }),
              quarantine: () => Effect.void,
              blockOrdinaryReassignment: () => Effect.succeed(true),
            },
            stageComplete: () => Effect.sync(() => void events.push("stage")),
            activateComplete: () => Effect.sync(() => void events.push("activate")),
            restartRole: (role) => Effect.sync(() => void events.push(`restart:${role}`)),
            verifyActualReadiness: () =>
              Effect.sync(() => {
                events.push("readiness");
                return true;
              }),
            resolveWorkflowArtifacts: () => Effect.succeed(proposedArtifacts),
          }),
        });
        expect(result.failure).toBeNull();
        expect(events).toContain("restart:ordinary-runner");
        expect(events.indexOf("settle-old-code")).toBeLessThan(events.indexOf("stage"));
        expect(events.indexOf("prove-cessation")).toBeLessThan(
          events.indexOf("cleanup-old-session"),
        );
        expect(events.indexOf("provision-fresh-group")).toBeLessThan(events.indexOf("activate"));
        expect(events.at(-1)).toBe("readiness");
      }),
  );

  it.effect(
    "keeps staged activation unavailable when malformed fresh-group evidence cannot be quarantined",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/workflow.ts", "old"]]);
        const next = snapshot("r2", [["src/workflow.ts", "new"]]);
        const oldArtifacts: WorkflowExecutionArtifacts = {
          ...testWorkflowArtifacts,
          runner: "e".repeat(64),
          runnerArtifacts: { ordinary_runner: "e".repeat(64) },
        };
        const proposedArtifacts: WorkflowExecutionArtifacts = {
          ...oldArtifacts,
          workflowVersion: "2.0.0",
          actionVersions: { "main-action": "2" },
          runner: "f".repeat(64),
          runnerArtifacts: { ordinary_runner: "f".repeat(64) },
        };
        const oldGroup = workflowExecutionGroupIdentity({
          sessionId: "staged-old-session",
          ownerToken: "staged-old-owner",
          generation: 1,
          database: "staged_old_db",
          apiEndpoint: "https://staged-old.dev.test",
          observationEndpoint: "https://staged-old.dev.test/observe",
          artifacts: oldArtifacts,
          workloadOAuthClientIds: { ordinary_runner: "staged-old-client" },
        });
        const unverifiedFreshGroup = workflowExecutionGroupIdentity({
          sessionId: "staged-fresh-session",
          ownerToken: "staged-fresh-owner",
          generation: 2,
          database: "staged_fresh_db",
          apiEndpoint: "https://staged-fresh.dev.test",
          observationEndpoint: "https://staged-fresh.dev.test/observe",
          artifacts: { ...proposedArtifacts, runnerArtifacts: { ordinary_runner: "0".repeat(64) } },
          workloadOAuthClientIds: { ordinary_runner: "staged-fresh-client" },
        });
        const events: string[] = [];
        let freshGroupCandidateUnavailable = false;
        let freshGroupProvisionDefects = false;
        const activationInput = {
          snapshot: next,
          previous,
          owner: "staged-old-owner",
          nextOwner: "staged-fresh-owner",
          workflowTransition: {
            oldGroup,
            previous: workflowDefinition(
              previous.revision,
              oldArtifacts,
              ["workflow-execution"],
              ["ordinary_runner"],
            ),
            proposed: workflowDefinition(
              next.revision,
              proposedArtifacts,
              ["workflow-execution"],
              ["ordinary_runner"],
            ),
            explicitlyRequested: true,
          },
          runtime: runtimeLayer({
            workflowRecreation: {
              presentProposal: () => Effect.sync(() => void events.push("proposal")),
              pauseAdmission: () => Effect.sync(() => void events.push("pause")),
              fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
                Effect.succeed(producerFenceEvidence(expectedBinding)),
              drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
                Effect.succeed(drainedOldWork(expectedBinding)),
              settleWithOldCode: boundOldWork,
              proveOldCessation: boundOldCessation,
              endOldSessionAndCleanup: () =>
                Effect.sync(() => {
                  events.push("cleanup-old");
                  return "cleanup-staged-old";
                }),
              provisionFreshGroup: (input) =>
                Effect.sync(() => {
                  events.push("provision-fresh");
                  if (freshGroupProvisionDefects)
                    throw new Error("provider defect after fresh allocation");
                  if (freshGroupCandidateUnavailable)
                    return {
                      requiredGroups: input.requiredGroups,
                      workloadOAuthClientIds: unverifiedFreshGroup.workloadOAuthClientIds,
                      priorCleanupRecordId: "cleanup-staged-old",
                      pendingCommands: 0,
                      browserQueueEntries: 0,
                      responseReferences: 0,
                    };
                  return {
                    group: unverifiedFreshGroup,
                    requiredGroups: input.requiredGroups,
                    workloadOAuthClientIds: unverifiedFreshGroup.workloadOAuthClientIds,
                    priorCleanupRecordId: "cleanup-staged-old",
                    pendingCommands: 1,
                    browserQueueEntries: 0,
                    responseReferences: 0,
                  };
                }),
              quarantineFreshGroup: (target) =>
                Effect.sync(() => {
                  expect(target.freshOwnerToken).toBe(unverifiedFreshGroup.ownerToken);
                  events.push(
                    `quarantine-fresh:${target.freshSessionId}:${target.priorCleanupRecordId}`,
                  );
                  return Effect.fail(
                    new WorkflowExecutionError({ reason: "fresh-quarantine-unavailable" }),
                  );
                }).pipe(Effect.flatten),
              quarantine: () => Effect.sync(() => void events.push("quarantine-old")),
              blockOrdinaryReassignment: () => Effect.succeed(true),
            },
            stageComplete: () => Effect.sync(() => void events.push("stage")),
            activateComplete: () => Effect.sync(() => void events.push("activate")),
            resolveWorkflowArtifacts: () => Effect.succeed(proposedArtifacts),
          }),
        };
        const status = yield* activateWithRuntime(activationInput);

        expect(status.failure).toContain(
          "workflow-quarantineunconfirmed:fresh-group-evidence-invalid:fresh-group-quarantine-unconfirmed",
        );
        expect(status.oldCleanupRecordId).toBe("cleanup-staged-old");
        expect(status.workflowTransitionPhases).toMatchObject({
          freshGroup: "unconfirmed",
          quarantine: "unconfirmed",
          ordinaryReassignment: "not-started",
        });
        expect(events).toEqual([
          "proposal",
          "pause",
          "cleanup-old",
          "provision-fresh",
          "quarantine-fresh:staged-fresh-session:cleanup-staged-old",
          "quarantine-old",
        ]);

        events.length = 0;
        freshGroupCandidateUnavailable = true;
        const unavailableCandidateStatus = yield* activateWithRuntime(activationInput);
        expect(unavailableCandidateStatus.failure).toContain(
          "workflow-quarantineunconfirmed:fresh-group-evidence-invalid:fresh-group-quarantine-unconfirmed",
        );
        expect(unavailableCandidateStatus.oldCleanupRecordId).toBe("cleanup-staged-old");
        expect(unavailableCandidateStatus.workflowTransitionPhases).toMatchObject({
          freshGroup: "unconfirmed",
          quarantine: "unconfirmed",
          ordinaryReassignment: "not-started",
        });
        expect(events).toEqual([
          "proposal",
          "pause",
          "cleanup-old",
          "provision-fresh",
          "quarantine-old",
        ]);

        events.length = 0;
        freshGroupCandidateUnavailable = false;
        freshGroupProvisionDefects = true;
        const defectStatus = yield* activateWithRuntime(activationInput);
        expect(defectStatus.failure).toContain(
          "workflow-quarantineunconfirmed:recreation-failed:fresh-group-quarantine-unconfirmed",
        );
        expect(defectStatus.oldCleanupRecordId).toBe("cleanup-staged-old");
        expect(defectStatus.workflowTransitionPhases).toMatchObject({
          oldSessionEnd: "ended",
          cleanup: "completed",
          freshGroup: "unconfirmed",
          quarantine: "unconfirmed",
          ordinaryReassignment: "not-started",
        });
        expect(events).toEqual([
          "proposal",
          "pause",
          "cleanup-old",
          "provision-fresh",
          "quarantine-old",
        ]);
      }),
  );

  it.effect(
    "accepts complete snapshots and represents additions/deletions by full replacement",
    () =>
      Effect.gen(function* () {
        const first = snapshot("r1", [["src/old.ts", "old"]]);
        const next = snapshot("r2", [["src/new.ts", "new"]]);
        yield* validateStagedSnapshot(next);
        expect(classifySnapshotChange(first, next)).toBe("source");
        expect(next.files.some(({ path }) => path === "src/old.ts")).toBe(false);
        let stagedPaths: ReadonlyArray<string> = [];
        const result = yield* activateWithRuntime({
          snapshot: next,
          previous: first,
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: (staged) =>
              Effect.sync(() => {
                stagedPaths = staged.files.map(({ path }) => path);
              }),
          }),
        });
        expect(result.failure).toBeNull();
        expect(result.activeRevision).toBe("r2");
        expect(stagedPaths).not.toContain("src/old.ts");
      }),
  );

  it.effect("preserves base64 file bytes and includes encoding in the digest", () =>
    Effect.gen(function* () {
      const bytes = Uint8Array.from([0x00, 0x80, 0xff, 0x28, 0x00]);
      const binaryFile = {
        path: "assets/opaque.bin",
        contentEncoding: "base64" as const,
        content: Buffer.from(bytes).toString("base64"),
        mode: 0o644,
      };
      const base64Snapshot = sealStagedSourceSnapshot("r1", [...snapshot("r1").files, binaryFile]);
      const utf8Snapshot = sealStagedSourceSnapshot("r1", [
        ...snapshot("r1").files,
        { ...binaryFile, contentEncoding: "utf8" },
      ]);
      const storedFile = base64Snapshot.files.find(({ path }) => path === binaryFile.path);

      yield* validateStagedSnapshot(base64Snapshot);
      expect(storedFile?.contentEncoding).toBe("base64");
      expect([...Buffer.from(storedFile?.content ?? "", "base64")]).toEqual([...bytes]);
      expect(base64Snapshot.completion.filesDigest).not.toBe(utf8Snapshot.completion.filesDigest);
      expect(classifySnapshotChange(base64Snapshot, utf8Snapshot)).toBe("source");
    }),
  );

  it.effect("rejects a truncated snapshot before any runtime effects", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["src/retained.ts", "active"]]);
      const complete = snapshot("r2", [["src/retained.ts", "next"]]);
      const truncated: StagedSourceSnapshot = {
        ...complete,
        files: complete.files.filter(({ path }) => path !== "src/retained.ts"),
      };
      expect(truncated.files.some(({ path }) => path === "package.json")).toBe(true);
      expect(truncated.files.some(({ path }) => path === "pnpm-lock.yaml")).toBe(true);

      let runtimeCalls = 0;
      const sideEffect = () => Effect.sync(() => void (runtimeCalls += 1));
      const result = yield* activateWithRuntime({
        snapshot: truncated,
        previous,
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          stageComplete: sideEffect,
          fenceOldOwner: sideEffect,
          retainImmutableRevision: sideEffect,
          rebuildArtifacts: sideEffect,
          activateComplete: sideEffect,
          restartRole: sideEffect,
          verifyActualReadiness: () =>
            Effect.sync(() => {
              runtimeCalls += 1;
              return true;
            }),
        }),
      });
      expect(result).toEqual({
        requestedRevision: "r2",
        activeRevision: "r1",
        unavailableRoles: ["ordinary-runner"],
        failure: "snapshot-completion-mismatch",
      });
      expect(runtimeCalls).toBe(0);
    }),
  );

  it.effect("does not restart workflow roles for a mode-only unrelated source edit", () =>
    Effect.gen(function* () {
      const manifestsAndSources = [
        ["packages/sheet-workflows/package.json", '{"name":"sheet-workflows"}'],
        ["packages/sheet-workflows/src/index.ts", "export const workflow = true"],
        ["packages/unrelated/package.json", '{"name":"unrelated"}'],
        ["packages/unrelated/src/index.ts", "export const unrelated = true"],
      ] as const;
      const previous = snapshot("r1", manifestsAndSources);
      const next = withFileMode(
        snapshot("r2", manifestsAndSources),
        "packages/unrelated/src/index.ts",
        0o755,
      );
      expect(classifySnapshotChange(previous, next)).toBe("source");
      expect(affectedRunnerRoles(previous, next, ["workflow-api", "ordinary-runner"])).toEqual([]);

      let restartCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "owner",
        nextOwner: "next-owner",
        roles: ["workflow-api", "ordinary-runner"],
        runtime: runtimeLayer({
          restartRole: () => {
            restartCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result.failure).toBeNull();
      expect(restartCalls).toBe(0);
    }),
  );

  it.effect("does not select workflow roles for an unrelated package source edit", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [
        ["packages/sheet-workflows/package.json", '{"name":"sheet-workflows"}'],
        ["packages/unrelated/package.json", '{"name":"unrelated"}'],
        ["packages/unrelated/src/index.ts", "export const value = 1"],
      ]);
      const next = snapshot("r2", [
        ["packages/sheet-workflows/package.json", '{"name":"sheet-workflows"}'],
        ["packages/unrelated/package.json", '{"name":"unrelated"}'],
        ["packages/unrelated/src/index.ts", "export const value = 2"],
      ]);

      expect(affectedRunnerRoles(previous, next, ["workflow-api", "ordinary-runner"])).toEqual([]);
      let restartCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "old",
        nextOwner: "new",
        roles: ["workflow-api", "ordinary-runner"],
        runtime: runtimeLayer({
          restartRole: () => {
            restartCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result.failure).toBeNull();
      expect(restartCalls).toBe(0);
    }),
  );

  it("identifies workflow packages by manifest name rather than directory", () => {
    const previous = snapshot("r1", [
      ["packages/runner-app/package.json", '{"name":"sheet-workflows"}'],
      ["packages/unrelated/package.json", '{"name":"unrelated"}'],
      ["packages/unrelated/src/index.ts", "before"],
    ]);
    const next = snapshot("r2", [
      ["packages/runner-app/package.json", '{"name":"sheet-workflows"}'],
      ["packages/unrelated/package.json", '{"name":"unrelated"}'],
      ["packages/unrelated/src/index.ts", "after"],
    ]);

    expect(affectedRunnerRoles(previous, next, ["workflow-api", "ordinary-runner"])).toEqual([]);
  });

  it.effect("rebuilds artifacts for a mode-only lockfile change", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1");
      const next = withFileMode(snapshot("r2"), "pnpm-lock.yaml", 0o600);
      expect(classifySnapshotChange(previous, next)).toBe("artifact");

      let rebuildCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "owner",
        nextOwner: "next-owner",
        runtime: runtimeLayer({
          rebuildArtifacts: () => {
            rebuildCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result.failure).toBeNull();
      expect(rebuildCalls).toBe(1);
    }),
  );

  it.effect("rebuilds artifacts when pnpm workspace selection changes", () =>
    Effect.gen(function* () {
      const previous = snapshot("r1", [["pnpm-workspace.yaml", "packages:\n  - packages/*"]]);
      const next = snapshot("r2", [["pnpm-workspace.yaml", "packages:\n  - packages/app"]]);
      expect(classifySnapshotChange(previous, next)).toBe("artifact");

      let rebuildCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: next,
        previous,
        owner: "owner",
        nextOwner: "next-owner",
        runtime: runtimeLayer({
          rebuildArtifacts: () => {
            rebuildCalls += 1;
            return Effect.void;
          },
        }),
      });

      expect(result.failure).toBeNull();
      expect(rebuildCalls).toBe(1);
    }),
  );

  it.effect("rejects host dependencies, credentials, traversal, and incomplete manifests", () =>
    Effect.gen(function* () {
      const bad = [
        snapshot("r", [["node_modules/x/index.js", "x"]]),
        snapshot("r", [[".env", "secret"]]),
        snapshot("r", [[".env.local", "secret"]]),
        snapshot("r", [[".env.production", "secret"]]),
        snapshot("r", [["secrets/google-service-account.json", "secret"]]),
        snapshot("r", [["certs/client.pem", "secret"]]),
        snapshot("r", [[".cache/ms-playwright/chromium", "binary"]]),
        snapshot("r", [["../escape", "x"]]),
        snapshot("r", [
          ["src/duplicate.ts", "one"],
          ["src/duplicate.ts", "two"],
        ]),
        {
          ...sealStagedSourceSnapshot("r", [
            ...snapshot("r").files,
            utf8File("src/invalid.ts", "x", 0o1000),
          ]),
        },
        sealStagedSourceSnapshot("", snapshot("r").files),
        sealStagedSourceSnapshot("r", [utf8File("package.json", "{}")]),
      ];
      for (const candidate of bad) {
        const result = yield* Effect.exit(
          validateStagedSnapshot(candidate as StagedSourceSnapshot),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }
    }),
  );

  it.effect("rejects suffixed environment files before runtime effects", () =>
    Effect.gen(function* () {
      for (const path of [".env.local", ".env.production"]) {
        let runtimeCalls = 0;
        const result = yield* activateWithRuntime({
          snapshot: snapshot("r2", [[path, "credential"]]),
          previous: snapshot("r1"),
          owner: "owner",
          nextOwner: "next-owner",
          runtime: runtimeLayer({
            stageComplete: () => {
              runtimeCalls += 1;
              return Effect.void;
            },
            fenceOldOwner: () => {
              runtimeCalls += 1;
              return Effect.void;
            },
            activateComplete: () => {
              runtimeCalls += 1;
              return Effect.void;
            },
          }),
        });
        expect(result.failure).toBe("excluded-or-unsafe-path");
        expect(runtimeCalls).toBe(0);
      }
    }),
  );

  it.effect("rejects malformed root and workspace manifests before runtime effects", () =>
    Effect.gen(function* () {
      const valid = snapshot("r2");
      const invalidRoot = sealStagedSourceSnapshot(
        valid.revision,
        valid.files.map((file) =>
          file.path === "package.json" ? { ...file, content: "{" } : file,
        ),
      );
      const invalidPackage = snapshot("r2", [["packages/broken/package.json", "{"]]);
      for (const candidate of [invalidRoot, invalidPackage]) {
        let stageCalls = 0;
        let fenceCalls = 0;
        let activationCalls = 0;
        const result = yield* activateWithRuntime({
          snapshot: candidate,
          previous: snapshot("r1"),
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: () => {
              stageCalls += 1;
              return Effect.void;
            },
            fenceOldOwner: () => {
              fenceCalls += 1;
              return Effect.void;
            },
            activateComplete: () => {
              activationCalls += 1;
              return Effect.void;
            },
          }),
        });
        expect(result.failure).toBe("invalid-package-manifest");
        expect(stageCalls).toBe(0);
        expect(fenceCalls).toBe(0);
        expect(activationCalls).toBe(0);
      }
    }),
  );

  it.effect("rejects base64-encoded package manifests before runtime effects", () =>
    Effect.gen(function* () {
      const valid = snapshot("r2", [
        ["packages/sheet-workflows/package.json", '{"name":"sheet-workflows"}'],
      ]);
      for (const manifestPath of ["package.json", "packages/sheet-workflows/package.json"]) {
        const candidate = sealStagedSourceSnapshot(
          valid.revision,
          valid.files.map((file) =>
            file.path === manifestPath
              ? {
                  ...file,
                  contentEncoding: "base64" as const,
                  content: Buffer.from(file.content, "utf8").toString("base64"),
                }
              : file,
          ),
        );
        let stageCalls = 0;
        const result = yield* activateWithRuntime({
          snapshot: candidate,
          previous: snapshot("r1"),
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: () => {
              stageCalls += 1;
              return Effect.void;
            },
          }),
        });

        expect(result.failure).toBe("invalid-package-manifest-encoding");
        expect(stageCalls).toBe(0);
      }
    }),
  );

  it.effect("reports malformed prior manifests before any runtime effects", () =>
    Effect.gen(function* () {
      const prior = snapshot("r1");
      const invalidPrevious = sealStagedSourceSnapshot(
        prior.revision,
        prior.files.map((file) =>
          file.path === "package.json" ? { ...file, content: "{" } : file,
        ),
      );
      let runtimeCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: snapshot("r2"),
        previous: invalidPrevious,
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          stageComplete: () => {
            runtimeCalls += 1;
            return Effect.void;
          },
          fenceOldOwner: () => {
            runtimeCalls += 1;
            return Effect.void;
          },
          activateComplete: () => {
            runtimeCalls += 1;
            return Effect.void;
          },
          verifyActualReadiness: () => {
            runtimeCalls += 1;
            return Effect.succeed(true);
          },
        }),
      });
      expect(result).toEqual({
        requestedRevision: "r2",
        activeRevision: "r1",
        unavailableRoles: ["ordinary-runner"],
        failure: "invalid-package-manifest",
      });
      expect(runtimeCalls).toBe(0);
    }),
  );

  it.effect(
    "stages completely, fences the old owner, retains its revision and restarts only the ordinary runner",
    () =>
      Effect.gen(function* () {
        const operations: string[] = [];
        const result = yield* activateWithRuntime({
          snapshot: snapshot("r2", [["src/run.ts", "changed"]]),
          previous: snapshot("r1", [["src/run.ts", "before"]]),
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: (tree) =>
              Effect.sync(() => operations.push(`stage:${tree.revision}`)).pipe(Effect.asVoid),
            fenceOldOwner: (owner, nextOwner) =>
              Effect.sync(() => operations.push(`fence:${owner}:${nextOwner}`)).pipe(Effect.asVoid),
            retainImmutableRevision: (revision) =>
              Effect.sync(() => operations.push(`retain:${revision}`)).pipe(Effect.asVoid),
            activateComplete: (revision) =>
              Effect.sync(() => operations.push(`activate:${revision}`)).pipe(Effect.asVoid),
            restartRole: (role, revision, kind) =>
              Effect.sync(() => operations.push(`restart:${role}:${revision}:${kind}`)).pipe(
                Effect.asVoid,
              ),
            verifyActualReadiness: (revision, roles) =>
              Effect.sync(() => {
                operations.push(`ready:${revision}:${roles.join(",")}`);
                return true;
              }),
          }),
        });
        expect(result).toMatchObject({
          requestedRevision: "r2",
          activeRevision: "r2",
          failure: null,
        });
        expect(operations).toEqual([
          "stage:r2",
          "fence:old:new",
          "retain:r1",
          "activate:r2",
          "restart:ordinary-runner:r2:source",
          "ready:r2:ordinary-runner",
        ]);
      }),
  );

  it.effect("does not activate after interrupted transfer and reports both revisions", () =>
    Effect.gen(function* () {
      let activateCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: snapshot("r2"),
        previous: snapshot("r1"),
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          stageComplete: () =>
            Effect.fail(new SnapshotRuntimeError({ reason: "transfer-interrupted" })),
          activateComplete: () => {
            activateCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result).toMatchObject({
        requestedRevision: "r2",
        activeRevision: "r1",
        unavailableRoles: ["ordinary-runner"],
      });
      expect(activateCalls).toBe(0);
    }),
  );

  it.effect("rejects a stale owner before activation or restart", () =>
    Effect.gen(function* () {
      let activateCalls = 0;
      const result = yield* activateWithRuntime({
        snapshot: snapshot("r2"),
        previous: snapshot("r1"),
        owner: "stale-owner",
        nextOwner: "current-owner",
        runtime: runtimeLayer({
          fenceOldOwner: () => Effect.fail(new SnapshotRuntimeError({ reason: "stale-owner" })),
          activateComplete: () => {
            activateCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(result.failure).toBe("stale-owner");
      expect(result.activeRevision).toBe("r1");
      expect(activateCalls).toBe(0);
    }),
  );

  it.effect(
    "rebuilds package changes and leaves the requested revision unavailable when readiness fails",
    () =>
      Effect.gen(function* () {
        let rebuilt = false;
        const previous = snapshot("r1");
        const next = snapshot("r2", [["packages/lib/package.json", '{"name":"lib"}']]);
        expect(classifySnapshotChange(previous, next)).toBe("artifact");
        const result = yield* activateWithRuntime({
          snapshot: next,
          previous,
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            rebuildArtifacts: () => {
              rebuilt = true;
              return Effect.void;
            },
            verifyActualReadiness: () => Effect.succeed(false),
          }),
        });
        expect(result.failure).toBe("readiness-check-failed");
        expect(rebuilt).toBe(true);
        expect(result.unavailableRoles).toEqual(["ordinary-runner"]);
        expect(result.activeRevision).toBe("r2");
      }),
  );

  it.effect("starts affected dependencies before the ordinary runner", () =>
    Effect.gen(function* () {
      const restarted: string[] = [];
      const readinessRoles: ReadonlyArray<string>[] = [];
      const result = yield* activateWithRuntime({
        snapshot: snapshot("r2"),
        previous: snapshot("r1"),
        owner: "old",
        nextOwner: "new",
        roles: ["ordinary-runner", "workflow-api", "browser-runner"],
        runtime: runtimeLayer({
          restartRole: (role, revision, kind) =>
            Effect.sync(() => restarted.push(`${role}:${revision}:${kind}`)).pipe(Effect.asVoid),
          verifyActualReadiness: (_revision, roles) =>
            Effect.sync(() => {
              readinessRoles.push([...roles]);
              return true;
            }),
        }),
      });
      expect(result.failure).toBeNull();
      expect(restarted).toEqual([
        "workflow-api:r2:source",
        "ordinary-runner:r2:source",
        "browser-runner:r2:source",
      ]);
      expect(readinessRoles).toEqual([["workflow-api", "ordinary-runner", "browser-runner"]]);
    }),
  );

  it.effect("coalesces a rapid save burst to one activation of the newest complete revision", () =>
    Effect.gen(function* () {
      const activated: string[] = [];
      const restarted: string[] = [];
      const result = yield* activateCoalescedWithRuntime({
        snapshots: [
          snapshot("r2", [["src/run.ts", "two"]]),
          snapshot("r3", [["src/run.ts", "three"]]),
          snapshot("r4", [["src/run.ts", "four"]]),
        ],
        previous: snapshot("r1", [["src/run.ts", "one"]]),
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          activateComplete: (revision) =>
            Effect.sync(() => activated.push(revision)).pipe(Effect.asVoid),
          restartRole: (role, revision) =>
            Effect.sync(() => restarted.push(`${role}:${revision}`)).pipe(Effect.asVoid),
        }),
      });
      expect(result.activeRevision).toBe("r4");
      expect(activated).toEqual(["r4"]);
      expect(restarted).toEqual(["ordinary-runner:r4"]);
    }),
  );

  it.effect("activates the newest complete save when a later save is truncated", () =>
    Effect.gen(function* () {
      const activated: string[] = [];
      const restarted: string[] = [];
      const complete = snapshot("r3", [["src/run.ts", "complete"]]);
      const latest = snapshot("r4", [["src/run.ts", "truncated"]]);
      const truncated: StagedSourceSnapshot = {
        ...latest,
        files: latest.files.slice(0, -1),
      };
      const result = yield* activateCoalescedWithRuntime({
        snapshots: [complete, truncated],
        previous: snapshot("r2"),
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          activateComplete: (revision) =>
            Effect.sync(() => activated.push(revision)).pipe(Effect.asVoid),
          restartRole: (role, revision) =>
            Effect.sync(() => restarted.push(`${role}:${revision}`)).pipe(Effect.asVoid),
        }),
      });

      expect(result).toEqual({
        requestedRevision: "r3",
        activeRevision: "r3",
        unavailableRoles: [],
        failure: null,
      });
      expect(activated).toEqual(["r3"]);
      expect(restarted).toEqual(["ordinary-runner:r3"]);
    }),
  );

  it.effect("fails a malformed-only save burst before any runtime effects", () =>
    Effect.gen(function* () {
      const runtimeCalls: string[] = [];
      const latest = snapshot("r4", [["src/run.ts", "truncated"]]);
      const truncated: StagedSourceSnapshot = {
        ...latest,
        files: latest.files.slice(0, -1),
      };
      const record = (name: string) => Effect.sync(() => void runtimeCalls.push(name));
      const result = yield* activateCoalescedWithRuntime({
        snapshots: [truncated],
        previous: snapshot("r2"),
        owner: "old",
        nextOwner: "new",
        runtime: runtimeLayer({
          stageComplete: () => record("stage"),
          fenceOldOwner: () => record("fence"),
          retainImmutableRevision: () => record("retain"),
          rebuildArtifacts: () => record("rebuild"),
          activateComplete: () => record("activate"),
          restartRole: () => record("restart"),
          verifyActualReadiness: () => record("readiness").pipe(Effect.as(true)),
        }),
      });

      expect(result).toEqual({
        requestedRevision: "r4",
        activeRevision: "r2",
        unavailableRoles: ["ordinary-runner"],
        failure: "snapshot-completion-mismatch",
      });
      expect(runtimeCalls).toEqual([]);
    }),
  );

  it.effect("propagates a changed shared workspace library to selected workflow consumers", () =>
    Effect.gen(function* () {
      const before = snapshot("r1", [
        ["packages/sheet-domain/package.json", '{"name":"sheet-domain"}'],
        ["packages/sheet-domain/src/value.ts", "export const value = 1"],
        [
          "packages/sheet-workflows/package.json",
          '{"name":"sheet-workflows","dependencies":{"sheet-domain":"workspace:*"}}',
        ],
        ["packages/sheet-workflows/src/index.ts", "import { value } from 'sheet-domain'"],
      ]);
      const after = snapshot("r2", [
        ["packages/sheet-domain/package.json", '{"name":"sheet-domain"}'],
        ["packages/sheet-domain/src/value.ts", "export const value = 2"],
        [
          "packages/sheet-workflows/package.json",
          '{"name":"sheet-workflows","dependencies":{"sheet-domain":"workspace:*"}}',
        ],
        ["packages/sheet-workflows/src/index.ts", "import { value } from 'sheet-domain'"],
      ]);
      expect(affectedRunnerRoles(before, after, ["workflow-api", "ordinary-runner"])).toEqual([
        "workflow-api",
        "ordinary-runner",
      ]);
      let restartCalls = 0;
      yield* activateWithRuntime({
        snapshot: after,
        previous: before,
        owner: "old",
        nextOwner: "new",
        roles: ["workflow-api", "ordinary-runner"],
        runtime: runtimeLayer({
          restartRole: () => {
            restartCalls += 1;
            return Effect.void;
          },
        }),
      });
      expect(restartCalls).toBe(2);
    }),
  );

  it.effect(
    "does not repeat restart side effects when the requested revision is already active",
    () =>
      Effect.gen(function* () {
        let readinessCalls = 0;
        let restartCalls = 0;
        const active = snapshot("r2", [["src/run.ts", "current"]]);
        const result = yield* activateWithRuntime({
          snapshot: active,
          previous: active,
          owner: "owner",
          nextOwner: "owner",
          runtime: runtimeLayer({
            verifyActualReadiness: () => {
              readinessCalls += 1;
              return Effect.succeed(true);
            },
            restartRole: () => {
              restartCalls += 1;
              return Effect.void;
            },
          }),
        });
        expect(result.failure).toBeNull();
        expect(readinessCalls).toBe(1);
        expect(restartCalls).toBe(0);
      }),
  );

  it.effect(
    "rejects different snapshot content under an active revision before runtime effects",
    () =>
      Effect.gen(function* () {
        const active = snapshot("r2", [["src/run.ts", "current"]]);
        const conflicting = snapshot("r2", [["src/run.ts", "different"]]);
        expect(conflicting.completion.filesDigest).not.toBe(active.completion.filesDigest);

        let runtimeCalls = 0;
        const recordRuntimeCall = () =>
          Effect.sync(() => {
            runtimeCalls += 1;
          });
        const result = yield* activateWithRuntime({
          snapshot: conflicting,
          previous: active,
          owner: "owner",
          nextOwner: "next-owner",
          runtime: runtimeLayer({
            stageComplete: recordRuntimeCall,
            fenceOldOwner: recordRuntimeCall,
            retainImmutableRevision: recordRuntimeCall,
            rebuildArtifacts: recordRuntimeCall,
            activateComplete: recordRuntimeCall,
            restartRole: recordRuntimeCall,
            verifyActualReadiness: () =>
              Effect.sync(() => {
                runtimeCalls += 1;
                return true;
              }),
          }),
        });

        expect(result).toEqual({
          requestedRevision: "r2",
          activeRevision: "r2",
          unavailableRoles: ["ordinary-runner"],
          failure: "revision-content-conflict",
        });
        expect(runtimeCalls).toBe(0);
      }),
  );

  it.effect(
    "recovers after an interrupted transfer without activating the incomplete revision",
    () =>
      Effect.gen(function* () {
        const previous = snapshot("r1", [["src/run.ts", "one"]]);
        const requested = snapshot("r2", [["src/run.ts", "two"]]);
        const interrupted = yield* activateWithRuntime({
          snapshot: requested,
          previous,
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            stageComplete: () =>
              Effect.fail(new SnapshotRuntimeError({ reason: "interrupted-sync" })),
          }),
        });
        expect(interrupted.activeRevision).toBe("r1");

        let activateCalls = 0;
        const recovered = yield* activateWithRuntime({
          snapshot: requested,
          previous,
          owner: "old",
          nextOwner: "new",
          runtime: runtimeLayer({
            activateComplete: () => {
              activateCalls += 1;
              return Effect.void;
            },
          }),
        });
        expect(recovered.activeRevision).toBe("r2");
        expect(recovered.failure).toBeNull();
        expect(activateCalls).toBe(1);
      }),
  );
});
