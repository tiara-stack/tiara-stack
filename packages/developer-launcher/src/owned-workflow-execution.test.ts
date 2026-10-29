import { expect, it } from "@effect/vitest";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import type { WorkflowRecreationDiagnostic } from "sheet-workflow-contracts";
import {
  classifyWorkflowPreviewTransition,
  type IncompatibleWorkflowRecreationRuntimeApi,
  IncompatibleWorkflowRecreationRuntimeLayer,
  ownedWorkflowExecutionLiveProfileEnabled,
  recreateIncompatibleWorkflowPreview,
  requireAutomaticWorkflowCompatibility,
  verifyCompatibleWorkflowReplacement,
  verifyWorkflowEnqueue,
  verifyWorkflowRunnerEvidence,
  workflowRecreationTimeouts,
  workflowExecutionEvidenceBinding,
  WorkflowExecutionError,
  workflowExecutionCleanupDisposition,
  workflowExecutionGroupIdentity,
  type WorkflowExecutionArtifacts,
  type WorkflowExecutionEvidenceBinding,
  type WorkflowExecutionGroup,
  type WorkflowRecreationResult,
} from "./owned-workflow-execution";
import {
  ambiguousOldWork,
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

const artifacts: WorkflowExecutionArtifacts = {
  api: "a".repeat(64),
  runner: "b".repeat(64),
  contracts: "c".repeat(64),
  deployment: "d".repeat(64),
  workflowVersion: "1.0.0",
  actionVersions: { "main-action": "1" },
};
const settledOldWorkWithCancellation = (binding: WorkflowExecutionEvidenceBinding) => ({
  ...settledOldWork(binding),
  cancellation: "completed",
});
const group = (
  sessionId: string,
  ownerToken = `owner-${sessionId}`,
  groupArtifacts = artifacts,
  workloadOAuthClientIds: Readonly<Record<string, string>> = {
    workflow_api: `oauth-api-${sessionId}`,
    ordinary_runner: `oauth-runner-${sessionId}`,
  },
) =>
  workflowExecutionGroupIdentity({
    sessionId,
    ownerToken,
    generation: 1,
    database: `db_${sessionId.replaceAll("-", "_")}`,
    apiEndpoint: `https://${sessionId}.api.dev.test`,
    observationEndpoint: `https://${sessionId}.api.dev.test/observe`,
    artifacts: groupArtifacts,
    workloadOAuthClientIds,
  });
const runnerFor = (owned = group("preview-a")) => ({
  sessionId: owned.sessionId,
  ownerToken: owned.ownerToken,
  generation: owned.generation,
  role: "ordinary-runner" as const,
  podUid: `pod-${owned.sessionId}`,
  address: "10.0.0.18:34431",
  healthy: true,
  database: owned.database,
  applicationStore: owned.applicationStore,
  commandStore: owned.commandStore,
  runStore: owned.runStore,
  clusterStore: owned.clusterStore,
  capabilities: ["ordinary-workflow-execution"],
  artifacts: owned.artifacts,
  shardOwnership: { owned: true, count: 600 },
});
const workflowFailureReason = (effect: Effect.Effect<unknown, WorkflowExecutionError>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    if (Exit.isSuccess(exit)) return "accepted";
    return Option.match(Cause.findErrorOption(exit.cause), {
      onNone: () => "failed",
      onSome: (error) =>
        error instanceof WorkflowExecutionError ? error.reason : "unexpected-error",
    });
  });

const withAuthSessionOnly = (definition: ReturnType<typeof workflowDefinition>) => ({
  ...definition,
  compatibility: {
    ...definition.compatibility,
    declarations: definition.compatibility.declarations.map((declaration) => ({
      ...declaration,
      contract: "auth.session",
    })),
  },
});

const withAuthSessionContract = (definition: ReturnType<typeof workflowDefinition>) => ({
  ...definition,
  compatibility: {
    ...definition.compatibility,
    declarations: [
      ...definition.compatibility.declarations,
      ...definition.compatibility.declarations.map((declaration) => ({
        ...declaration,
        contract: "auth.session",
      })),
    ],
  },
});

const withoutWorkflowExecutionGroup = (definition: ReturnType<typeof workflowDefinition>) => ({
  ...definition,
  requiredGroups: definition.requiredGroups.filter((group) => group !== "workflow-execution"),
});

type FreshSessionRecoveryFixture = {
  readonly old: WorkflowExecutionGroup;
  readonly previous: ReturnType<typeof workflowDefinition>;
  readonly proposed: ReturnType<typeof workflowDefinition>;
  readonly recovery: WorkflowRecreationDiagnostic;
  readonly persisted: WorkflowRecreationDiagnostic[];
  readonly runtime: IncompatibleWorkflowRecreationRuntimeApi;
};

const makeFreshSessionRecoveryFixture = (): FreshSessionRecoveryFixture => {
  const old = group("preview-recovery-old");
  const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
  const proposed = workflowDefinition("revision-new", { ...artifacts, workflowVersion: "2.0.0" }, [
    "workflow-execution",
  ]);
  const recovery: WorkflowRecreationDiagnostic = {
    oldCleanupRecordId: "cleanup-preview-recovery-old",
    freshSessionId: "preview-recovery-fresh",
    freshGeneration: 2,
    priorRevision: "revision-old",
    requestedRevision: "revision-new",
    reasons: ["action-version-changed"],
    recovery: {
      failureReason: "provider-evidence-unconfirmed",
      freshSessionDisposition: "pending",
      freshGroupQuarantineDisposition: "unconfirmed",
      quarantineDisposition: "pending",
      ordinaryReassignmentBlocked: null,
      recoveryRecordId: "preview-recovery-fresh.workflow-recreation-recovery.json",
      recoveryRecordWritten: true,
      recoveryRecordUpdated: false,
    },
  };
  const persisted: WorkflowRecreationDiagnostic[] = [];
  const runtime: IncompatibleWorkflowRecreationRuntimeApi = {
    presentProposal: () => Effect.void,
    pauseAdmission: () => Effect.void,
    fenceProducers: ({ expectedBinding }) => Effect.succeed(producerFenceEvidence(expectedBinding)),
    drainOldWork: ({ expectedBinding }) => Effect.succeed(drainedOldWork(expectedBinding)),
    settleWithOldCode: boundOldWork,
    proveOldCessation: boundOldCessation,
    endOldSessionAndCleanup: () => Effect.succeed("cleanup-preview-recovery-old"),
    provisionFreshGroup: () =>
      Effect.fail(new WorkflowExecutionError({ reason: "fresh-group-evidence-invalid", recovery })),
    quarantine: () => Effect.void,
    blockOrdinaryReassignment: () => Effect.succeed(true),
    persistRecoveryDisposition: (diagnostic) =>
      Effect.sync(() => {
        persisted.push(diagnostic);
        return true;
      }),
  };
  return { old, previous, proposed, recovery, persisted, runtime };
};

const expectUnconfirmedFenceResult = (result: WorkflowRecreationResult) => {
  expect(result).toMatchObject({
    _tag: "QuarantineUnconfirmed",
    quarantineReason: "quarantine-and-reassignment-fence-unconfirmed",
    ordinaryReassignmentBlocked: null,
    phases: { quarantine: "unconfirmed", ordinaryReassignment: "unconfirmed" },
    recovery: {
      recovery: { quarantineDisposition: "unconfirmed", ordinaryReassignmentBlocked: null },
    },
  });
  if (result._tag === "QuarantineUnconfirmed")
    expect(JSON.stringify(result.recovery)).toContain('"ordinaryReassignmentBlocked":null');
};

const assertFailedReassignmentFenceIsUnknown = (fixture: FreshSessionRecoveryFixture) =>
  Effect.gen(function* () {
    fixture.persisted.length = 0;
    const runtime = {
      ...fixture.runtime,
      quarantine: () =>
        Effect.fail(new WorkflowExecutionError({ reason: "quarantine-write-failed" })),
      blockOrdinaryReassignment: () =>
        Effect.fail(new WorkflowExecutionError({ reason: "reassignment-fence-unavailable" })),
    };
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: fixture.old,
      previous: fixture.previous,
      proposed: fixture.proposed,
      explicitlyRequested: true,
    }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
    expectUnconfirmedFenceResult(result);
    expect(fixture.persisted.at(-1)?.phases).toMatchObject({
      quarantine: "unconfirmed",
      ordinaryReassignment: "unconfirmed",
    });
    expect(fixture.persisted.at(-1)?.recovery).toMatchObject({
      quarantineDisposition: "unconfirmed",
      ordinaryReassignmentBlocked: null,
    });
  });

const assertTimedOutReassignmentFenceIsUnknown = (fixture: FreshSessionRecoveryFixture) =>
  Effect.gen(function* () {
    const fenceStarted = yield* Deferred.make<void>();
    fixture.persisted.length = 0;
    const runtime = {
      ...fixture.runtime,
      quarantine: () =>
        Effect.fail(new WorkflowExecutionError({ reason: "quarantine-write-failed" })),
      blockOrdinaryReassignment: () =>
        Deferred.succeed(fenceStarted, undefined).pipe(Effect.andThen(Effect.never)),
    };
    const fiber = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: fixture.old,
      previous: fixture.previous,
      proposed: fixture.proposed,
      explicitlyRequested: true,
    })
      .pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)))
      .pipe(Effect.forkChild);
    yield* Deferred.await(fenceStarted);
    yield* TestClock.adjust(workflowRecreationTimeouts.providerOperation);
    yield* Effect.yieldNow;
    expectUnconfirmedFenceResult(yield* Fiber.join(fiber));
    expect(fixture.persisted.at(-1)?.recovery).toMatchObject({
      quarantineDisposition: "unconfirmed",
      ordinaryReassignmentBlocked: null,
    });
  });

it("allocates distinct workflow state identities for concurrent previews", () => {
  const first = group("preview-a");
  const second = group("preview-b");
  expect(first.database).not.toBe(second.database);
  expect(first.applicationStore).not.toBe(second.applicationStore);
  expect(first.commandStore).not.toBe(second.commandStore);
  expect(first.runStore).not.toBe(second.runStore);
  expect(first.clusterStore).not.toBe(second.clusterStore);
});

it("rejects an invalid owned database identifier", () => {
  expect(() =>
    workflowExecutionGroupIdentity({
      sessionId: "preview-a",
      ownerToken: "owner-preview-a",
      generation: 1,
      database: "db-preview-a",
      apiEndpoint: "https://preview-a.api.dev.test",
      observationEndpoint: "https://preview-a.api.dev.test/observe",
      artifacts,
      workloadOAuthClientIds: { ordinary_runner: "preview-a-runner" },
    }),
  ).toThrow();
});

it.effect("accepts matching group-scoped runner evidence independent of key order", () =>
  Effect.gen(function* () {
    const owned = group("preview-a");
    const runner = runnerFor(owned);
    yield* verifyWorkflowRunnerEvidence(owned, runner);
    yield* verifyWorkflowRunnerEvidence(owned, {
      ...runner,
      artifacts: {
        workflowVersion: owned.artifacts.workflowVersion,
        actionVersions: owned.artifacts.actionVersions,
        deployment: owned.artifacts.deployment,
        contracts: owned.artifacts.contracts,
        runner: owned.artifacts.runner,
        api: owned.artifacts.api,
      },
    });
  }),
);

it.effect("rejects a healthy shared runner and another preview's membership", () =>
  Effect.gen(function* () {
    const first = group("preview-a");
    const shared = runnerFor(group("shared-control"));
    const other = runnerFor(group("preview-b"));
    expect(yield* workflowFailureReason(verifyWorkflowRunnerEvidence(first, shared))).toBe(
      "runner-owner-mismatch",
    );
    expect(yield* workflowFailureReason(verifyWorkflowRunnerEvidence(first, other))).toBe(
      "runner-owner-mismatch",
    );
    expect(
      yield* workflowFailureReason(
        verifyWorkflowRunnerEvidence({ ...first, database: "invalid-database" }, runnerFor(first)),
      ),
    ).toBe("workflow-group-invalid");
  }),
);

it.effect("rejects missing capabilities, artifact drift, unowned shards and wrong stores", () =>
  Effect.gen(function* () {
    const owned = group("preview-a");
    const base = runnerFor(owned);
    const invalid = [
      [{ ...base, capabilities: [] }, "runner-capability-missing"],
      [{ ...base, role: "api" }, "runner-evidence-invalid"],
      [
        { ...base, artifacts: { ...artifacts, runner: "e".repeat(64) } },
        "runner-artifact-mismatch",
      ],
      [
        { ...base, shardOwnership: { owned: false, count: 600 } },
        "runner-shard-ownership-mismatch",
      ],
      [{ ...base, shardOwnership: { owned: true, count: 599 } }, "runner-shard-ownership-mismatch"],
      [
        { ...base, commandStore: group("shared-control").commandStore },
        "runner-state-plane-mismatch",
      ],
    ] as const;
    for (const [evidence, reason] of invalid) {
      expect(yield* workflowFailureReason(verifyWorkflowRunnerEvidence(owned, evidence))).toBe(
        reason,
      );
    }
  }),
);

it.effect("keeps compatible process and pod replacement on the original durable group", () =>
  Effect.gen(function* () {
    const original = group("preview-a");
    const podReplacement = { ...runnerFor(original), podUid: "replacement-pod" };
    expect(
      yield* verifyWorkflowRunnerEvidence(original, podReplacement).pipe(Effect.as(true)),
    ).toBe(true);
    const changedArtifacts = { ...artifacts, api: "f".repeat(64), runner: "e".repeat(64) };
    const replacement = group("preview-a", original.ownerToken, changedArtifacts);
    expect(replacement.applicationStore).toBe(original.applicationStore);
    expect(replacement.commandStore).toBe(original.commandStore);
    expect(replacement.runStore).toBe(original.runStore);
    expect(replacement.clusterStore).toBe(original.clusterStore);
    expect(
      yield* verifyCompatibleWorkflowReplacement(original, replacement).pipe(Effect.as(true)),
    ).toBe(true);
    const newDatabase = group("preview-a", "new-owner");
    const databaseChange = workflowExecutionGroupIdentity({
      ...replacement,
      database: "another_database",
    });
    const contractsChange = {
      ...replacement,
      artifacts: { ...replacement.artifacts, contracts: "e".repeat(64) },
    };
    const deploymentChange = {
      ...replacement,
      artifacts: { ...replacement.artifacts, deployment: "e".repeat(64) },
    };
    const versionChange = {
      ...replacement,
      artifacts: { ...replacement.artifacts, workflowVersion: "2.0.0" },
    };
    const actionVersionChange = {
      ...replacement,
      artifacts: {
        ...replacement.artifacts,
        actionVersions: { "main-action": "2" },
      },
    };
    expect(
      yield* workflowFailureReason(verifyCompatibleWorkflowReplacement(original, newDatabase)),
    ).toBe("replacement-changes-durable-workflow-identity");
    expect(
      yield* workflowFailureReason(verifyCompatibleWorkflowReplacement(original, databaseChange)),
    ).toBe("replacement-changes-durable-workflow-identity");
    expect(
      yield* workflowFailureReason(verifyCompatibleWorkflowReplacement(original, contractsChange)),
    ).toBe("replacement-contracts-incompatible");
    expect(
      yield* workflowFailureReason(verifyCompatibleWorkflowReplacement(original, deploymentChange)),
    ).toBe("replacement-deployment-incompatible");
    expect(
      yield* workflowFailureReason(verifyCompatibleWorkflowReplacement(original, versionChange)),
    ).toBe("replacement-workflow-version-incompatible");
    expect(
      yield* workflowFailureReason(
        verifyCompatibleWorkflowReplacement(original, actionVersionChange),
      ),
    ).toBe("replacement-workflow-version-incompatible");
  }),
);

it.effect("admits only explicit controlled smoke without triggers or external effects", () =>
  Effect.gen(function* () {
    const owned = group("preview-a");
    const forgedGroup = {
      ...owned,
      applicationStore: "shared_application",
      commandStore: "shared_command",
      runStore: "shared_run",
      clusterStore: "shared_cluster",
    };
    expect(
      yield* workflowFailureReason(verifyCompatibleWorkflowReplacement(forgedGroup, forgedGroup)),
    ).toBe("workflow-group-store-identity-mismatch");
    expect(
      yield* workflowFailureReason(verifyCompatibleWorkflowReplacement(owned, forgedGroup)),
    ).toBe("workflow-group-store-identity-mismatch");
    expect(
      yield* workflowFailureReason(
        verifyWorkflowRunnerEvidence(forgedGroup, runnerFor(forgedGroup)),
      ),
    ).toBe("workflow-group-store-identity-mismatch");
    yield* verifyWorkflowEnqueue({
      group: owned,
      observationGroup: owned,
      selectedControlledSmoke: true,
      autonomousTriggersEnabled: false,
      externalEffects: false,
    });
    yield* verifyWorkflowEnqueue({
      group: owned,
      observationGroup: {
        ...owned,
        artifacts: { ...owned.artifacts, api: "f".repeat(64), runner: "e".repeat(64) },
      },
      selectedControlledSmoke: true,
      autonomousTriggersEnabled: false,
      externalEffects: false,
    });
    const incompatibleObservationArtifacts = [
      { ...owned.artifacts, contracts: "a".repeat(64) },
      { ...owned.artifacts, deployment: "b".repeat(64) },
      { ...owned.artifacts, workflowVersion: "2.0.0" },
    ];
    for (const artifacts of incompatibleObservationArtifacts) {
      expect(
        yield* workflowFailureReason(
          verifyWorkflowEnqueue({
            group: owned,
            observationGroup: { ...owned, artifacts },
            selectedControlledSmoke: true,
            autonomousTriggersEnabled: false,
            externalEffects: false,
          }),
        ),
      ).toBe("enqueue-observation-group-mismatch");
    }
    expect(
      yield* workflowFailureReason(
        verifyWorkflowEnqueue({
          group: forgedGroup,
          observationGroup: forgedGroup,
          selectedControlledSmoke: true,
          autonomousTriggersEnabled: false,
          externalEffects: false,
        }),
      ),
    ).toBe("workflow-group-store-identity-mismatch");
    expect(
      yield* workflowFailureReason(
        verifyWorkflowEnqueue({
          group: owned,
          observationGroup: owned,
          selectedControlledSmoke: false,
          autonomousTriggersEnabled: false,
          externalEffects: false,
        }),
      ),
    ).toBe("workflow-enqueue-not-an-isolated-controlled-smoke");
    expect(
      yield* workflowFailureReason(
        verifyWorkflowEnqueue({
          group: owned,
          observationGroup: {
            ...owned,
            observationEndpoint: "https://different.preview.dev.test/observe",
          },
          selectedControlledSmoke: true,
          autonomousTriggersEnabled: false,
          externalEffects: false,
        }),
      ),
    ).toBe("enqueue-observation-group-mismatch");
    expect(
      yield* workflowFailureReason(
        verifyWorkflowEnqueue({
          group: owned,
          observationGroup: {
            ...owned,
            clusterStore: "shared_cluster",
          },
          selectedControlledSmoke: true,
          autonomousTriggersEnabled: false,
          externalEffects: false,
        }),
      ),
    ).toBe("workflow-group-store-identity-mismatch");
    expect(
      yield* workflowFailureReason(
        verifyWorkflowEnqueue({
          group: owned,
          observationGroup: group("shared-control"),
          selectedControlledSmoke: true,
          autonomousTriggersEnabled: false,
          externalEffects: false,
        }),
      ),
    ).toBe("enqueue-observation-group-mismatch");
    expect(
      yield* workflowFailureReason(
        verifyWorkflowEnqueue({
          group: owned,
          observationGroup: owned,
          selectedControlledSmoke: true,
          autonomousTriggersEnabled: true,
          externalEffects: false,
        }),
      ),
    ).toBe("workflow-enqueue-not-an-isolated-controlled-smoke");
  }),
);

it("quarantines deletion without complete cessation and accepted-work proof", () => {
  const old = group("cleanup-disposition");
  const expectedBinding = workflowExecutionEvidenceBinding(old, "immutable-old-revision");
  const completeEvidence = cessationEvidence(expectedBinding);

  expect(workflowExecutionCleanupDisposition(completeEvidence, expectedBinding)).toBe("deletable");
  expect(
    workflowExecutionCleanupDisposition(
      cessationEvidence(expectedBinding, { acceptedWorkSettled: false }),
      expectedBinding,
    ),
  ).toBe("quarantined");
  expect(
    workflowExecutionCleanupDisposition(
      cessationEvidence(expectedBinding, { unknownOwnership: true }),
      expectedBinding,
    ),
  ).toBe("quarantined");
  expect(
    workflowExecutionCleanupDisposition(
      cessationEvidence(expectedBinding, { reclaimedCommandLeasesReconciled: false }),
      expectedBinding,
    ),
  ).toBe("quarantined");
  expect(
    workflowExecutionCleanupDisposition(
      { ...completeEvidence, binding: { ...expectedBinding, sourceRevision: "new-revision" } },
      expectedBinding,
    ),
  ).toBe("quarantined");
  expect(
    workflowExecutionCleanupDisposition(
      {
        providerOperationsTerminal: true,
        apiFenced: true,
        runnerPodsTerminated: true,
        acceptedWorkSettled: true,
      },
      expectedBinding,
    ),
  ).toBe("quarantined");
});

it("keeps the owned workflow execution live profile unavailable", () => {
  expect(ownedWorkflowExecutionLiveProfileEnabled).toBe(false);
});

it("classifies a per-action version change even when the summary workflow version is unchanged", () => {
  const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
  const proposed = workflowDefinition(
    "revision-new",
    { ...artifacts, actionVersions: { "main-action": "2" } },
    ["workflow-execution"],
  );

  expect(classifyWorkflowPreviewTransition(previous, proposed)).toMatchObject({
    classification: "incompatible",
    reasons: ["action-version-changed"],
  });
});

it.effect(
  "requires canonical workflow role and group closure for compatible declarations on both transition sides",
  () =>
    Effect.gen(function* () {
      const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
      const changedArtifacts = { ...artifacts, actionVersions: { "main-action": "2" } };
      const proposed = workflowDefinition("revision-new", changedArtifacts, ["workflow-execution"]);
      expect(
        proposed.compatibility.declarations.every(
          ({ classification }) => classification === "compatible",
        ),
      ).toBe(true);
      expect(classifyWorkflowPreviewTransition(previous, proposed).classification).toBe(
        "incompatible",
      );

      const invalidDefinitions = [
        {
          previous: workflowDefinition("revision-old", artifacts, []),
          proposed,
        },
        {
          previous,
          proposed: workflowDefinition("revision-new", changedArtifacts, []),
        },
        {
          previous: workflowDefinition(
            "revision-old",
            artifacts,
            ["workflow-execution"],
            ["workflow_api", "browser_runner"],
          ),
          proposed,
        },
        {
          previous,
          proposed: workflowDefinition(
            "revision-new",
            changedArtifacts,
            ["workflow-execution"],
            ["workflow_api", "browser_runner"],
          ),
        },
      ] as const;
      const calls: string[] = [];
      const call = (name: string) => Effect.sync(() => void calls.push(name));
      const runtime: IncompatibleWorkflowRecreationRuntimeApi = {
        presentProposal: () => call("proposal"),
        pauseAdmission: () => call("pause"),
        fenceProducers: ({ expectedBinding }) =>
          call("fence").pipe(Effect.as(producerFenceEvidence(expectedBinding))),
        drainOldWork: ({ expectedBinding }) =>
          call("drain").pipe(Effect.as(drainedOldWork(expectedBinding))),
        settleWithOldCode: ({ expectedBinding }) =>
          call("settle").pipe(Effect.as(settledOldWork(expectedBinding))),
        proveOldCessation: ({ expectedBinding }) =>
          call("cessation").pipe(Effect.as(cessationEvidence(expectedBinding))),
        endOldSessionAndCleanup: () => call("cleanup").pipe(Effect.as("cleanup-record")),
        provisionFreshGroup: () =>
          call("provision").pipe(
            Effect.flatMap(() =>
              Effect.fail(new WorkflowExecutionError({ reason: "unexpected-provisioning" })),
            ),
          ),
        quarantine: () => call("quarantine"),
        blockOrdinaryReassignment: () => Effect.succeed(true),
      };

      for (const transition of invalidDefinitions) {
        expect(
          classifyWorkflowPreviewTransition(transition.previous, transition.proposed)
            .classification,
        ).toBe("unverified");
        const result = yield* recreateIncompatibleWorkflowPreview({
          oldGroup: group("preview-missing-required-group"),
          ...transition,
          explicitlyRequested: true,
        }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
        expect(result).toMatchObject({
          _tag: "Rejected",
          reason: "workflow-transition-compatibility-evidence-unverified",
        });
        expect(calls).toEqual([]);
      }
    }),
);

it.effect(
  "requires role-owned workflow execution for auth-only declarations before recreation",
  () =>
    Effect.gen(function* () {
      const browserArtifacts: WorkflowExecutionArtifacts = {
        ...artifacts,
        runnerArtifacts: {
          ordinary_runner: artifacts.runner,
          browser_runner: "f".repeat(64),
        },
      };
      const roleProfiles = [
        { name: "api-only", workloadRoles: ["workflow_api"], artifacts },
        {
          name: "ordinary-runner",
          workloadRoles: ["workflow_api", "ordinary_runner"],
          artifacts,
        },
        {
          name: "browser-runner",
          workloadRoles: ["workflow_api", "ordinary_runner", "browser_runner"],
          artifacts: browserArtifacts,
        },
      ] as const;
      const calls: string[] = [];
      const call = (name: string) => Effect.sync(() => void calls.push(name));
      const runtime: IncompatibleWorkflowRecreationRuntimeApi = {
        presentProposal: () => call("proposal"),
        pauseAdmission: () => call("pause"),
        fenceProducers: ({ expectedBinding }) =>
          call("fence").pipe(Effect.as(producerFenceEvidence(expectedBinding))),
        drainOldWork: ({ expectedBinding }) =>
          call("drain").pipe(Effect.as(drainedOldWork(expectedBinding))),
        settleWithOldCode: ({ expectedBinding }) =>
          call("settle").pipe(Effect.as(settledOldWork(expectedBinding))),
        proveOldCessation: ({ expectedBinding }) =>
          call("cessation").pipe(Effect.as(cessationEvidence(expectedBinding))),
        endOldSessionAndCleanup: () => call("cleanup").pipe(Effect.as("cleanup-record")),
        provisionFreshGroup: () =>
          call("provision").pipe(
            Effect.flatMap(() =>
              Effect.fail(new WorkflowExecutionError({ reason: "unexpected-provisioning" })),
            ),
          ),
        quarantine: () => call("quarantine"),
        blockOrdinaryReassignment: () => Effect.succeed(true),
      };

      for (const profile of roleProfiles) {
        const changedArtifacts = {
          ...profile.artifacts,
          actionVersions: { "main-action": "2" },
        };
        const previousWithCombinedContracts = withAuthSessionContract(
          workflowDefinition(
            "revision-old",
            profile.artifacts,
            ["workflow-execution"],
            profile.workloadRoles,
          ),
        );
        const proposedWithCombinedContracts = withAuthSessionContract(
          workflowDefinition(
            "revision-new",
            changedArtifacts,
            ["workflow-execution"],
            profile.workloadRoles,
          ),
        );
        expect(previousWithCombinedContracts.requiredGroups).toEqual(["workflow-execution"]);
        expect(proposedWithCombinedContracts.requiredGroups).toEqual(["workflow-execution"]);
        expect(
          classifyWorkflowPreviewTransition(
            previousWithCombinedContracts,
            proposedWithCombinedContracts,
          ),
        ).toMatchObject({
          classification: "incompatible",
          reasons: ["action-version-changed"],
        });

        const previousWithoutWorkflowExecution = withoutWorkflowExecutionGroup(
          withAuthSessionOnly(
            workflowDefinition(
              "revision-old",
              profile.artifacts,
              ["workflow-execution"],
              profile.workloadRoles,
            ),
          ),
        );
        const proposedWithoutWorkflowExecution = withoutWorkflowExecutionGroup(
          withAuthSessionOnly(
            workflowDefinition(
              "revision-new",
              changedArtifacts,
              ["workflow-execution"],
              profile.workloadRoles,
            ),
          ),
        );
        const invalidTransitions = [
          {
            previous: previousWithoutWorkflowExecution,
            proposed: proposedWithCombinedContracts,
          },
          {
            previous: previousWithCombinedContracts,
            proposed: proposedWithoutWorkflowExecution,
          },
        ] as const;
        const ownerToken = `owner-${profile.name}`;
        const oldGroup = group(
          `preview-${profile.name}`,
          ownerToken,
          profile.artifacts,
          Object.fromEntries(
            profile.workloadRoles.map((role) => [role, `client-${profile.name}-${role}`]),
          ),
        );

        for (const transition of invalidTransitions) {
          expect(
            classifyWorkflowPreviewTransition(transition.previous, transition.proposed)
              .classification,
          ).toBe("unverified");
          const result = yield* recreateIncompatibleWorkflowPreview({
            oldGroup,
            ...transition,
            explicitlyRequested: true,
          }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
          expect(result).toMatchObject({
            _tag: "Rejected",
            reason: "workflow-transition-compatibility-evidence-unverified",
          });
          expect(calls).toEqual([]);
        }
      }
    }),
);

it("checks role-derived execution groups before every incompatible transition dimension", () => {
  const browserArtifacts: WorkflowExecutionArtifacts = {
    ...artifacts,
    runnerArtifacts: {
      ordinary_runner: artifacts.runner,
      browser_runner: "f".repeat(64),
    },
  };
  const ordinaryRoles = ["workflow_api", "ordinary_runner"];
  const browserRoles = ["workflow_api", "ordinary_runner", "browser_runner"];
  const scenarios = [
    {
      previous: workflowDefinition(
        "revision-old",
        artifacts,
        ["workflow-execution"],
        ordinaryRoles,
      ),
      proposed: workflowDefinition(
        "revision-new",
        { ...artifacts, actionVersions: { "main-action": "2" } },
        ["workflow-execution"],
        ordinaryRoles,
      ),
    },
    {
      previous: workflowDefinition(
        "revision-old",
        artifacts,
        ["workflow-execution"],
        ordinaryRoles,
      ),
      proposed: workflowDefinition(
        "revision-new",
        { ...artifacts, workflowVersion: "2.0.0" },
        ["workflow-execution"],
        ordinaryRoles,
      ),
    },
    {
      previous: workflowDefinition(
        "revision-old",
        artifacts,
        ["workflow-execution"],
        ordinaryRoles,
      ),
      proposed: workflowDefinition(
        "revision-new",
        { ...artifacts, contracts: "e".repeat(64) },
        ["workflow-execution"],
        ordinaryRoles,
      ),
    },
    {
      previous: workflowDefinition(
        "revision-old",
        artifacts,
        ["workflow-execution"],
        ordinaryRoles,
      ),
      proposed: workflowDefinition(
        "revision-new",
        { ...artifacts, deployment: "e".repeat(64) },
        ["workflow-execution"],
        ordinaryRoles,
      ),
    },
    {
      previous: workflowDefinition(
        "revision-old",
        artifacts,
        ["workflow-execution"],
        ordinaryRoles,
      ),
      proposed: workflowDefinition(
        "revision-new",
        artifacts,
        ["workflow-execution", "browser"],
        ordinaryRoles,
      ),
    },
    {
      previous: workflowDefinition(
        "revision-old",
        artifacts,
        ["workflow-execution", "browser"],
        ordinaryRoles,
      ),
      proposed: workflowDefinition(
        "revision-new",
        artifacts,
        ["workflow-execution"],
        ordinaryRoles,
      ),
    },
    {
      previous: workflowDefinition(
        "revision-old",
        artifacts,
        ["workflow-execution"],
        ordinaryRoles,
      ),
      proposed: workflowDefinition(
        "revision-new",
        browserArtifacts,
        ["workflow-execution"],
        browserRoles,
      ),
    },
    {
      previous: workflowDefinition(
        "revision-old",
        browserArtifacts,
        ["workflow-execution"],
        browserRoles,
      ),
      proposed: workflowDefinition(
        "revision-new",
        artifacts,
        ["workflow-execution"],
        ordinaryRoles,
      ),
    },
  ] as const;

  for (const scenario of scenarios) {
    const previousWithContracts = withAuthSessionContract(scenario.previous);
    const proposedWithContracts = withAuthSessionContract(scenario.proposed);
    expect(
      classifyWorkflowPreviewTransition(previousWithContracts, proposedWithContracts)
        .classification,
    ).toBe("incompatible");

    expect(
      classifyWorkflowPreviewTransition(
        withoutWorkflowExecutionGroup(withAuthSessionOnly(scenario.previous)),
        proposedWithContracts,
      ).classification,
    ).toBe("unverified");
    expect(
      classifyWorkflowPreviewTransition(
        previousWithContracts,
        withoutWorkflowExecutionGroup(withAuthSessionOnly(scenario.proposed)),
      ).classification,
    ).toBe("unverified");
  }
});

it("conditions the incompatible execution-role closure on browser workflow participation", () => {
  const incompatibleDeclarations = (definition: ReturnType<typeof workflowDefinition>) => ({
    ...definition,
    compatibility: {
      ...definition.compatibility,
      declarations: definition.compatibility.declarations.map((declaration) => ({
        ...declaration,
        classification: "incompatible" as const,
      })),
    },
  });

  const ordinaryRoles = ["workflow_api", "ordinary_runner"];
  const ordinaryPrevious = workflowDefinition(
    "revision-old",
    artifacts,
    ["workflow-execution"],
    ordinaryRoles,
  );
  const ordinaryProposed = incompatibleDeclarations(
    workflowDefinition("revision-new", artifacts, ["workflow-execution"], ordinaryRoles),
  );
  expect(classifyWorkflowPreviewTransition(ordinaryPrevious, ordinaryProposed)).toMatchObject({
    classification: "incompatible",
    reasons: ["declared-contract-incompatible"],
  });

  const browserArtifacts: WorkflowExecutionArtifacts = {
    ...artifacts,
    runnerArtifacts: {
      ordinary_runner: artifacts.runner,
      browser_runner: "f".repeat(64),
    },
  };
  const browserRoles = ["workflow_api", "ordinary_runner", "browser_runner"];
  const browserPrevious = workflowDefinition(
    "revision-old",
    browserArtifacts,
    ["workflow-execution"],
    browserRoles,
  );
  const browserProposed = incompatibleDeclarations(
    workflowDefinition("revision-new", browserArtifacts, ["workflow-execution"], browserRoles),
  );
  expect(classifyWorkflowPreviewTransition(browserPrevious, browserProposed)).toMatchObject({
    classification: "incompatible",
    reasons: ["declared-contract-incompatible"],
  });
});

it("fails closed when transition catalog or declaration evidence is missing, stale, or unknown", () => {
  const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
  const proposed = workflowDefinition("revision-new", artifacts, ["workflow-execution"]);

  expect(
    classifyWorkflowPreviewTransition(previous, {
      ...proposed,
      compatibility: { ...proposed.compatibility, catalogDigest: `sha256:${"8".repeat(64)}` },
    }).classification,
  ).toBe("unverified");
  expect(
    classifyWorkflowPreviewTransition(previous, {
      ...proposed,
      compatibility: { ...proposed.compatibility, declarations: [] },
    }).classification,
  ).toBe("unverified");
  expect(
    classifyWorkflowPreviewTransition(previous, {
      ...proposed,
      compatibility: {
        ...proposed.compatibility,
        declarations: proposed.compatibility.declarations.map((declaration) => ({
          ...declaration,
          sourceRevision: "stale-revision",
        })),
      },
    }).classification,
  ).toBe("unverified");
  expect(
    classifyWorkflowPreviewTransition(previous, {
      ...proposed,
      compatibility: {
        ...proposed.compatibility,
        declarations: proposed.compatibility.declarations.map((declaration) => ({
          ...declaration,
          classification: "unknown" as const,
        })),
      },
    }).classification,
  ).toBe("unverified");
});

it("fails closed when a declared runner role has no role-specific runner digest", () => {
  const completeRunnerArtifacts: WorkflowExecutionArtifacts = {
    ...artifacts,
    runnerArtifacts: {
      ordinary_runner: "e".repeat(64),
      browser_runner: "f".repeat(64),
    },
  };
  const missingBrowserDigest: WorkflowExecutionArtifacts = {
    ...completeRunnerArtifacts,
    runnerArtifacts: { ordinary_runner: "e".repeat(64) },
  };
  const roles = ["workflow_api", "ordinary_runner", "browser_runner"];
  const previous = workflowDefinition(
    "revision-old",
    completeRunnerArtifacts,
    ["workflow-execution"],
    roles,
  );
  const proposed = workflowDefinition(
    "revision-new",
    missingBrowserDigest,
    ["workflow-execution"],
    roles,
  );

  expect(classifyWorkflowPreviewTransition(previous, proposed).classification).toBe("unverified");
});

it("keeps catalog declarations without workflow artifact resolvers valid", () => {
  const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
  const proposed = workflowDefinition("revision-new", artifacts, ["workflow-execution"]);
  const withCatalogOnlyDeclaration = (definition: typeof previous) => ({
    ...definition,
    compatibility: {
      ...definition.compatibility,
      declarations: [
        ...definition.compatibility.declarations,
        {
          role: "sheet-web",
          contract: "search.query",
          classification: "compatible" as const,
          sourceRevision: definition.sourceRevision,
          artifactDigest: "9".repeat(64),
          deployedManifestDigest: definition.artifacts.deployment,
          catalogVersion: definition.compatibility.catalogVersion,
        },
      ],
    },
  });

  expect(
    classifyWorkflowPreviewTransition(
      withCatalogOnlyDeclaration(previous),
      withCatalogOnlyDeclaration(proposed),
    ).classification,
  ).toBe("compatible");
});

it("classifies a removed workload role as an incompatible transition", () => {
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
  const previous = workflowDefinition(
    "revision-old",
    previousArtifacts,
    ["workflow-execution"],
    ["workflow_api", "ordinary_runner", "browser_runner"],
  );
  const proposed = workflowDefinition(
    "revision-new",
    proposedArtifacts,
    ["workflow-execution"],
    ["workflow_api", "ordinary_runner"],
  );

  expect(classifyWorkflowPreviewTransition(previous, proposed)).toMatchObject({
    classification: "incompatible",
    reasons: ["workflow-role-removed"],
  });
});

it("classifies removal of a required workflow group as an incompatible transition", () => {
  const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution", "browser"]);
  const proposed = workflowDefinition("revision-new", artifacts, ["workflow-execution"]);

  expect(classifyWorkflowPreviewTransition(previous, proposed)).toMatchObject({
    classification: "incompatible",
    reasons: ["workflow-group-removed"],
  });
});

it.effect(
  "requires an explicit proposal and settles incompatible work with immutable old artifacts before fresh identities",
  () =>
    Effect.gen(function* () {
      const old = group("preview-old");
      const proposedArtifacts = {
        ...artifacts,
        api: "f".repeat(64),
        runner: "e".repeat(64),
        contracts: "e".repeat(64),
        workflowVersion: "2.0.0",
        actionVersions: { "main-action": "2" },
      };
      const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
      const proposed = workflowDefinition("revision-new", proposedArtifacts, [
        "workflow-execution",
        "browser",
      ]);
      const transition = classifyWorkflowPreviewTransition(previous, proposed);
      expect(transition.classification).toBe("incompatible");
      expect(transition.reasons).toEqual([
        "workflow-contracts-changed",
        "action-version-changed",
        "workflow-group-added",
      ]);
      expect(yield* Effect.exit(requireAutomaticWorkflowCompatibility(transition))).toMatchObject({
        _tag: "Failure",
      });

      const calls: string[] = [];
      const cleanupRecordId = "cleanup-record-42";
      const freshGroup = group("preview-fresh", "fresh-owner", proposedArtifacts);
      const runtime = {
        presentProposal: () => Effect.sync(() => void calls.push("proposal")).pipe(Effect.asVoid),
        pauseAdmission: () => Effect.sync(() => void calls.push("pause")).pipe(Effect.asVoid),
        fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
          Effect.sync(() => void calls.push("fence-producers")).pipe(
            Effect.as(producerFenceEvidence(expectedBinding)),
          ),
        drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
          Effect.succeed(drainedOldWork(expectedBinding)),
        settleWithOldCode: ({ oldArtifacts, expectedBinding }: OldWorkSettlementInput) =>
          Effect.sync(() => {
            expect(oldArtifacts).toBe(old.artifacts);
            calls.push("settle-old-code");
            return settledOldWorkWithCancellation(expectedBinding);
          }),
        proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
          Effect.sync(() => {
            calls.push("prove-cessation");
            return cessationEvidence(expectedBinding);
          }),
        endOldSessionAndCleanup: () =>
          Effect.sync(() => {
            calls.push("end-and-cleanup");
            return cleanupRecordId;
          }),
        provisionFreshGroup: (input: {
          readonly requiredGroups: ReadonlyArray<string>;
          readonly priorCleanupRecordId: string;
          readonly transferPendingWork: false;
        }) =>
          Effect.sync(() => {
            expect(input.priorCleanupRecordId).toBe(cleanupRecordId);
            expect(input.requiredGroups).toEqual(["workflow-execution", "browser"]);
            expect(input.transferPendingWork).toBe(false);
            calls.push("provision-fresh");
            return {
              group: freshGroup,
              requiredGroups: input.requiredGroups,
              workloadOAuthClientIds: freshGroup.workloadOAuthClientIds,
              priorCleanupRecordId: cleanupRecordId,
              pendingCommands: 0,
              browserQueueEntries: 0,
              responseReferences: 0,
            };
          }),
        quarantine: () => Effect.sync(() => void calls.push("quarantine")).pipe(Effect.asVoid),
        blockOrdinaryReassignment: () => Effect.succeed(true),
      };
      const unverifiedProposal = {
        ...proposed,
        compatibility: {
          ...proposed.compatibility,
          declarations: proposed.compatibility.declarations.map((declaration) => ({
            ...declaration,
            classification: "unknown" as const,
          })),
        },
      };
      const rejected = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed: unverifiedProposal,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(rejected).toMatchObject({
        _tag: "Rejected",
        reason: "workflow-transition-compatibility-evidence-unverified",
      });
      expect(calls).toEqual([]);
      const missingClosureProposal = {
        ...proposed,
        requiredGroups: [],
        compatibility: {
          ...proposed.compatibility,
          declarations: proposed.compatibility.declarations.map((declaration) => ({
            ...declaration,
            classification: "incompatible" as const,
          })),
        },
      };
      const closureRejected = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed: missingClosureProposal,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(closureRejected).toMatchObject({
        _tag: "Rejected",
        reason: "workflow-transition-compatibility-evidence-unverified",
      });
      expect(calls).toEqual([]);

      const result = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(result._tag).toBe("Recreated");
      if (result._tag === "Recreated") {
        expect(result.oldCleanupRecordId).toBe(cleanupRecordId);
        expect(result.phases).toMatchObject({
          proposal: "presented",
          admission: "paused",
          producerFencing: "fenced",
          drain: "completed",
          cancellation: "completed",
          reconciliation: "not-required",
          settlement: "settled",
          cessation: "proven",
          oldSessionEnd: "ended",
          cleanup: "completed",
          freshGroup: "provisioned",
          activation: "not-started",
          quarantine: "not-started",
          ordinaryReassignment: "not-started",
        });
      }
      expect(calls).toEqual([
        "proposal",
        "pause",
        "fence-producers",
        "settle-old-code",
        "prove-cessation",
        "end-and-cleanup",
        "provision-fresh",
      ]);
    }),
);

it.effect("keeps a declared settlement quarantined when cancellation evidence is ambiguous", () =>
  Effect.gen(function* () {
    const old = group("preview-partial-settlement");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, actionVersions: { "main-action": "2" } },
      ["workflow-execution"],
    );
    const events: string[] = [];
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: old,
      previous,
      proposed,
      explicitlyRequested: true,
    }).pipe(
      Effect.provide(
        IncompatibleWorkflowRecreationRuntimeLayer({
          presentProposal: () => Effect.void,
          pauseAdmission: () => Effect.void,
          fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
            Effect.succeed(producerFenceEvidence(expectedBinding)),
          drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
            Effect.succeed(drainedOldWork(expectedBinding)),
          settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
            Effect.succeed(
              settledOldWork(expectedBinding, {
                disposition: "settled",
                drain: "completed",
                cancellation: "ambiguous",
                reconciliation: "not-required",
              }),
            ),
          proveOldCessation: () => Effect.sync(() => void events.push("unexpected-cessation")),
          endOldSessionAndCleanup: () =>
            Effect.sync(() => void events.push("unexpected-cleanup")).pipe(Effect.as("cleanup")),
          provisionFreshGroup: () => Effect.sync(() => void events.push("unexpected-provision")),
          quarantine: () => Effect.void,
          blockOrdinaryReassignment: () => Effect.succeed(true),
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Quarantined",
      reason: "old-work-settlement-ambiguous",
      phases: {
        drain: "completed",
        cancellation: "ambiguous",
        reconciliation: "not-required",
        settlement: "unconfirmed",
        quarantine: "confirmed",
      },
    });
    expect(events).toEqual([]);
  }),
);

it.effect("rejects missing or mismatched old-work identity before cleanup and reprovisioning", () =>
  Effect.gen(function* () {
    const old = group("preview-unbound-settlement");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, workflowVersion: "2.0.0" },
      ["workflow-execution"],
    );

    for (const bindingMode of ["missing", "mismatched"] as const) {
      const events: Array<string> = [];
      const result = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(
        Effect.provide(
          IncompatibleWorkflowRecreationRuntimeLayer({
            presentProposal: () => Effect.sync(() => void events.push("proposal")),
            pauseAdmission: () => Effect.sync(() => void events.push("pause")),
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.sync(() => void events.push("fence")).pipe(
                Effect.as(producerFenceEvidence(expectedBinding)),
              ),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Effect.succeed(drainedOldWork(expectedBinding)),
            settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
              Effect.sync(() => {
                events.push("settle");
                const evidence = settledOldWork(expectedBinding);
                if (bindingMode === "mismatched")
                  return {
                    ...evidence,
                    binding: { ...expectedBinding, sourceRevision: "stale-old-revision" },
                  };
                const { binding: _binding, ...unbound } = evidence;
                return unbound;
              }),
            proveOldCessation: () => Effect.sync(() => void events.push("unexpected-cessation")),
            endOldSessionAndCleanup: () =>
              Effect.sync(() => void events.push("unexpected-cleanup")).pipe(
                Effect.as("unexpected-cleanup-record"),
              ),
            provisionFreshGroup: () => Effect.sync(() => void events.push("unexpected-provision")),
            quarantine: () => Effect.sync(() => void events.push("quarantine")),
            blockOrdinaryReassignment: () => Effect.succeed(true),
          }),
        ),
      );

      expect(result).toMatchObject({
        _tag: "Quarantined",
        reason: "old-work-settlement-evidence-invalid",
        phases: {
          settlement: "unconfirmed",
          cessation: "not-started",
          oldSessionEnd: "not-started",
          cleanup: "not-started",
          freshGroup: "not-started",
          quarantine: "confirmed",
        },
      });
      expect(events).toEqual(["proposal", "pause", "fence", "settle", "quarantine"]);
    }
  }),
);

it.effect("rejects mismatched cessation identity before old cleanup and fresh provisioning", () =>
  Effect.gen(function* () {
    const old = group("preview-unbound-cessation");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, workflowVersion: "2.0.0" },
      ["workflow-execution"],
    );
    const events: Array<string> = [];
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: old,
      previous,
      proposed,
      explicitlyRequested: true,
    }).pipe(
      Effect.provide(
        IncompatibleWorkflowRecreationRuntimeLayer({
          presentProposal: () => Effect.sync(() => void events.push("proposal")),
          pauseAdmission: () => Effect.sync(() => void events.push("pause")),
          fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
            Effect.sync(() => void events.push("fence")).pipe(
              Effect.as(producerFenceEvidence(expectedBinding)),
            ),
          drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
            Effect.succeed(drainedOldWork(expectedBinding)),
          settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
            Effect.sync(() => void events.push("settle")).pipe(
              Effect.as(settledOldWork(expectedBinding)),
            ),
          proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
            Effect.sync(() => {
              events.push("prove-cessation");
              return {
                ...cessationEvidence(expectedBinding),
                binding: { ...expectedBinding, generation: expectedBinding.generation + 1 },
              };
            }),
          endOldSessionAndCleanup: () =>
            Effect.sync(() => void events.push("unexpected-cleanup")).pipe(
              Effect.as("unexpected-cleanup-record"),
            ),
          provisionFreshGroup: () => Effect.sync(() => void events.push("unexpected-provision")),
          quarantine: () => Effect.sync(() => void events.push("quarantine")),
          blockOrdinaryReassignment: () => Effect.succeed(true),
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Quarantined",
      reason: "old-execution-cessation-unproven",
      phases: {
        settlement: "settled",
        cessation: "unproven",
        oldSessionEnd: "not-started",
        cleanup: "not-started",
        freshGroup: "not-started",
        quarantine: "confirmed",
      },
    });
    expect(events).toEqual([
      "proposal",
      "pause",
      "fence",
      "settle",
      "prove-cessation",
      "quarantine",
    ]);
  }),
);

it.effect(
  "rejects incomplete proposed runner evidence before settlement and quarantines mismatched fresh evidence",
  () =>
    Effect.gen(function* () {
      const old = group("preview-runner-artifacts-old");
      const ordinaryRunnerDigest = "e".repeat(64);
      const proposedArtifacts: WorkflowExecutionArtifacts = {
        ...artifacts,
        runner: ordinaryRunnerDigest,
        runnerArtifacts: {
          ordinary_runner: ordinaryRunnerDigest,
          browser_runner: "f".repeat(64),
        },
        workflowVersion: "2.0.0",
        actionVersions: { "main-action": "2" },
      };
      const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
      const proposed = workflowDefinition(
        "revision-new",
        proposedArtifacts,
        ["workflow-execution"],
        ["workflow_api", "ordinary_runner", "browser_runner"],
      );
      const wrongFreshArtifacts = {
        ...proposedArtifacts,
        runnerArtifacts: {
          ordinary_runner: ordinaryRunnerDigest,
          browser_runner: "0".repeat(64),
        },
      };
      const wrongDigestFresh = group(
        "preview-runner-artifacts-wrong-fresh",
        "fresh-owner-wrong",
        wrongFreshArtifacts,
        {
          workflow_api: "fresh-api-client-wrong",
          ordinary_runner: "fresh-runner-client-wrong",
          browser_runner: "fresh-browser-client-wrong",
        },
      );
      const missingMapArtifacts: WorkflowExecutionArtifacts = {
        ...artifacts,
        workflowVersion: "2.0.0",
        actionVersions: { "main-action": "2" },
      };
      const missingMapProposed = workflowDefinition(
        "revision-new",
        missingMapArtifacts,
        ["workflow-execution"],
        ["workflow_api", "ordinary_runner", "browser_runner"],
      );
      let activeFresh = wrongDigestFresh;
      let malformedFreshEvidence = false;
      let freshQuarantineFails = false;
      let freshGroupCandidateUnavailable = false;
      const calls: string[] = [];
      const runtime = {
        presentProposal: () => Effect.sync(() => void calls.push("proposal")),
        pauseAdmission: () => Effect.sync(() => void calls.push("pause")),
        fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
          Effect.sync(() => void calls.push("fence-producers")).pipe(
            Effect.as(producerFenceEvidence(expectedBinding)),
          ),
        drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
          Effect.succeed(drainedOldWork(expectedBinding)),
        settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
          Effect.sync(() => void calls.push("settle-old-code")).pipe(
            Effect.as(settledOldWork(expectedBinding)),
          ),
        proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
          Effect.sync(() => {
            calls.push("prove-cessation");
            return cessationEvidence(expectedBinding);
          }),
        endOldSessionAndCleanup: () =>
          Effect.sync(() => {
            calls.push("cleanup");
            return "cleanup-runner-artifacts-old";
          }),
        provisionFreshGroup: (input: { readonly requiredGroups: ReadonlyArray<string> }) =>
          Effect.sync(() => {
            calls.push("provision");
            if (freshGroupCandidateUnavailable)
              return {
                requiredGroups: input.requiredGroups,
                workloadOAuthClientIds: activeFresh.workloadOAuthClientIds,
                priorCleanupRecordId: "cleanup-runner-artifacts-old",
                pendingCommands: 0 as const,
                browserQueueEntries: 0 as const,
                responseReferences: 0 as const,
              };
            return {
              group: activeFresh,
              requiredGroups: input.requiredGroups,
              workloadOAuthClientIds: activeFresh.workloadOAuthClientIds,
              priorCleanupRecordId: "cleanup-runner-artifacts-old",
              pendingCommands: malformedFreshEvidence ? 1 : (0 as const),
              browserQueueEntries: 0 as const,
              responseReferences: 0 as const,
            };
          }),
        quarantineFreshGroup: (target: {
          readonly freshSessionId: string;
          readonly freshOwnerToken?: string;
          readonly freshGeneration: number;
          readonly priorCleanupRecordId: string;
        }) => {
          expect(target.freshOwnerToken).toBe(activeFresh.ownerToken);
          calls.push(
            `quarantine-fresh:${target.freshSessionId}:${target.freshGeneration}:${target.priorCleanupRecordId}`,
          );
          return freshQuarantineFails
            ? Effect.fail(new WorkflowExecutionError({ reason: "fresh-quarantine-unavailable" }))
            : Effect.void;
        },
        quarantine: (_group: WorkflowExecutionGroup, reason: string) =>
          Effect.sync(() => void calls.push(`quarantine:${reason}`)),
        blockOrdinaryReassignment: () => Effect.succeed(true),
      };
      const wrongFreshResult = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(wrongFreshResult).toMatchObject({
        _tag: "Quarantined",
        reason: "fresh-group-evidence-invalid",
        oldCleanupRecordId: "cleanup-runner-artifacts-old",
        phases: { freshGroup: "unconfirmed", quarantine: "confirmed" },
      });
      expect(calls).toEqual([
        "proposal",
        "pause",
        "fence-producers",
        "settle-old-code",
        "prove-cessation",
        "cleanup",
        "provision",
        "quarantine-fresh:preview-runner-artifacts-wrong-fresh:1:cleanup-runner-artifacts-old",
        "quarantine:fresh-group-evidence-invalid",
      ]);

      calls.length = 0;
      malformedFreshEvidence = true;
      freshQuarantineFails = true;
      const failedFreshQuarantine = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(failedFreshQuarantine).toMatchObject({
        _tag: "QuarantineUnconfirmed",
        reason: "fresh-group-evidence-invalid",
        quarantineReason: "fresh-group-quarantine-unconfirmed",
        oldCleanupRecordId: "cleanup-runner-artifacts-old",
        phases: { freshGroup: "unconfirmed", quarantine: "unconfirmed" },
      });
      expect(calls).toEqual([
        "proposal",
        "pause",
        "fence-producers",
        "settle-old-code",
        "prove-cessation",
        "cleanup",
        "provision",
        "quarantine-fresh:preview-runner-artifacts-wrong-fresh:1:cleanup-runner-artifacts-old",
        "quarantine:fresh-group-evidence-invalid",
      ]);

      calls.length = 0;
      malformedFreshEvidence = false;
      freshQuarantineFails = false;
      freshGroupCandidateUnavailable = true;
      const unavailableFreshCandidate = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(unavailableFreshCandidate).toMatchObject({
        _tag: "QuarantineUnconfirmed",
        reason: "fresh-group-evidence-invalid",
        quarantineReason: "fresh-group-quarantine-unconfirmed",
        oldCleanupRecordId: "cleanup-runner-artifacts-old",
        ordinaryReassignmentBlocked: null,
        phases: { freshGroup: "unconfirmed", quarantine: "unconfirmed" },
      });
      expect(calls).toEqual([
        "proposal",
        "pause",
        "fence-producers",
        "settle-old-code",
        "prove-cessation",
        "cleanup",
        "provision",
        "quarantine:fresh-group-evidence-invalid",
      ]);

      calls.length = 0;
      const unconfirmedProvisioningRuntime = {
        ...runtime,
        provisionFreshGroup: () =>
          Effect.sync(() => void calls.push("provision")).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new WorkflowExecutionError({ reason: "fresh-group-provisioning-unconfirmed" }),
              ),
            ),
          ),
      };
      const unconfirmedProvisioning = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(
        Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(unconfirmedProvisioningRuntime)),
      );
      expect(unconfirmedProvisioning).toMatchObject({
        _tag: "QuarantineUnconfirmed",
        reason: "fresh-group-provisioning-unconfirmed",
        quarantineReason: "fresh-group-quarantine-unconfirmed",
        oldCleanupRecordId: "cleanup-runner-artifacts-old",
        phases: { freshGroup: "unconfirmed", quarantine: "unconfirmed" },
      });
      expect(calls).toEqual([
        "proposal",
        "pause",
        "fence-producers",
        "settle-old-code",
        "prove-cessation",
        "cleanup",
        "provision",
        "quarantine:fresh-group-provisioning-unconfirmed",
      ]);

      calls.length = 0;
      freshGroupCandidateUnavailable = false;
      malformedFreshEvidence = false;
      freshQuarantineFails = false;
      expect(classifyWorkflowPreviewTransition(previous, missingMapProposed).classification).toBe(
        "unverified",
      );
      const missingProposalEvidenceResult = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed: missingMapProposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(missingProposalEvidenceResult).toMatchObject({
        _tag: "Rejected",
        reason: "workflow-transition-compatibility-evidence-unverified",
        phases: {
          proposal: "not-started",
          admission: "not-started",
          settlement: "not-started",
          cleanup: "not-started",
          freshGroup: "not-started",
        },
      });
      expect(calls).toEqual([]);
    }),
);

it.effect("rejects empty, duplicate, and unsupported proposed roles before lifecycle effects", () =>
  Effect.gen(function* () {
    const old = group("preview-invalid-proposed-roles-old");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const actionVersionChange = {
      ...artifacts,
      actionVersions: { "main-action": "2" },
    };
    const duplicateRolesWithUniqueDeclarations = workflowDefinition(
      "revision-new",
      actionVersionChange,
      ["workflow-execution"],
      ["workflow_api", "workflow_api", "ordinary_runner"],
    );
    const duplicateRolesProposed = {
      ...duplicateRolesWithUniqueDeclarations,
      compatibility: {
        ...duplicateRolesWithUniqueDeclarations.compatibility,
        declarations: duplicateRolesWithUniqueDeclarations.compatibility.declarations.filter(
          (declaration, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.role === declaration.role && candidate.contract === declaration.contract,
            ) === index,
        ),
      },
    };
    const emptyRolesProposed = {
      ...workflowDefinition(
        "revision-new",
        actionVersionChange,
        ["workflow-execution"],
        ["workflow_api"],
      ),
      workloadRoles: [] as ReadonlyArray<string>,
    };
    const unsupportedRoleProposed = {
      ...workflowDefinition(
        "revision-new",
        actionVersionChange,
        ["workflow-execution"],
        ["workflow_api"],
      ),
      workloadRoles: ["workflow_admin"],
    };
    const cases = [duplicateRolesProposed, emptyRolesProposed, unsupportedRoleProposed] as const;
    const calls: string[] = [];
    const call = (name: string) => Effect.sync(() => void calls.push(name));
    const runtime = {
      presentProposal: () => call("proposal"),
      pauseAdmission: () => call("pause"),
      fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
        call("fence-producers").pipe(Effect.as(producerFenceEvidence(expectedBinding))),
      drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
        Effect.succeed(drainedOldWork(expectedBinding)),
      settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
        call("settle-old-code").pipe(Effect.as(settledOldWork(expectedBinding))),
      proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
        call("prove-cessation").pipe(Effect.as(cessationEvidence(expectedBinding))),
      endOldSessionAndCleanup: () => call("cleanup").pipe(Effect.as("cleanup-invalid-roles-old")),
      provisionFreshGroup: () => call("provision"),
      quarantine: () => call("quarantine"),
      blockOrdinaryReassignment: () => Effect.succeed(true),
    };

    for (const proposed of cases) {
      expect(classifyWorkflowPreviewTransition(previous, proposed).classification).toBe(
        "unverified",
      );
      const result = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(result).toMatchObject({
        _tag: "Rejected",
        reason: "workflow-transition-compatibility-evidence-unverified",
        phases: {
          proposal: "not-started",
          admission: "not-started",
          producerFencing: "not-started",
          settlement: "not-started",
          cleanup: "not-started",
          freshGroup: "not-started",
        },
      });
      expect(calls).toEqual([]);
    }
  }),
);

it.effect("rejects reused session endpoints during controlled workflow recreation", () =>
  Effect.gen(function* () {
    const old = group("preview-endpoint-old");
    const proposedArtifacts = { ...artifacts, workflowVersion: "2.0.0" };
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition("revision-new", proposedArtifacts, ["workflow-execution"]);
    const freshBase = group("preview-endpoint-fresh", "fresh-owner", proposedArtifacts);
    const oldServiceHost = new URL(old.apiEndpoint).hostname;
    const cleanupRecordId = "cleanup-endpoint-old";
    const lifecycleEvents = (freshGroup: WorkflowExecutionGroup) => {
      const events: string[] = [];
      const runtime: IncompatibleWorkflowRecreationRuntimeApi = {
        presentProposal: () => Effect.sync(() => void events.push("proposal")),
        pauseAdmission: () => Effect.sync(() => void events.push("pause")),
        fenceProducers: ({ expectedBinding }) =>
          Effect.sync(() => void events.push("fence")).pipe(
            Effect.as(producerFenceEvidence(expectedBinding)),
          ),
        drainOldWork: ({ expectedBinding }) => Effect.succeed(drainedOldWork(expectedBinding)),
        settleWithOldCode: ({ expectedBinding }) => Effect.succeed(settledOldWork(expectedBinding)),
        proveOldCessation: ({ expectedBinding }) =>
          Effect.succeed(cessationEvidence(expectedBinding)),
        endOldSessionAndCleanup: () =>
          Effect.sync(() => void events.push("cleanup")).pipe(Effect.as(cleanupRecordId)),
        provisionFreshGroup: ({ requiredGroups, priorCleanupRecordId }) =>
          Effect.sync(() => {
            events.push("provision");
            return {
              group: freshGroup,
              requiredGroups,
              workloadOAuthClientIds: freshGroup.workloadOAuthClientIds,
              priorCleanupRecordId,
              pendingCommands: 0 as const,
              browserQueueEntries: 0 as const,
              responseReferences: 0 as const,
            };
          }),
        quarantineFreshGroup: (candidate) =>
          Effect.sync(
            () =>
              void events.push(
                `quarantine-fresh:${candidate.freshSessionId}:${candidate.freshGeneration}:${candidate.priorCleanupRecordId}`,
              ),
          ),
        quarantine: (_oldGroup, reason) =>
          Effect.sync(() => void events.push(`quarantine:${reason}`)),
        blockOrdinaryReassignment: () => Effect.succeed(true),
      };
      return { events, runtime };
    };
    const settleAndRecreate = (freshGroup: WorkflowExecutionGroup) => {
      const lifecycle = lifecycleEvents(freshGroup);
      return recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      })
        .pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(lifecycle.runtime)))
        .pipe(Effect.map((result) => ({ result, events: lifecycle.events })));
    };

    const reusedEndpoints = [
      {
        name: "API service",
        endpoints: { apiEndpoint: old.apiEndpoint },
      },
      {
        name: "observation service",
        endpoints: { observationEndpoint: old.observationEndpoint },
      },
      {
        name: "API service with changed URL spelling",
        endpoints: {
          apiEndpoint: `https://${oldServiceHost.toUpperCase()}.:9443/new-path`,
        },
      },
      {
        name: "observation service with changed URL spelling",
        endpoints: {
          observationEndpoint: `https://${oldServiceHost.toUpperCase()}.:9443/observe/v2`,
        },
      },
    ] as const;

    for (const reuse of reusedEndpoints) {
      const freshGroup = { ...freshBase, ...reuse.endpoints };
      const { result, events } = yield* settleAndRecreate(freshGroup);
      expect(result, reuse.name).toMatchObject({
        _tag: "Quarantined",
        reason: "fresh-group-evidence-invalid",
        oldCleanupRecordId: cleanupRecordId,
        phases: { freshGroup: "unconfirmed", quarantine: "confirmed" },
      });
      expect(events, reuse.name).toEqual([
        "proposal",
        "pause",
        "fence",
        "cleanup",
        "provision",
        `quarantine-fresh:${freshGroup.sessionId}:${freshGroup.generation}:${cleanupRecordId}`,
        "quarantine:fresh-group-evidence-invalid",
      ]);
    }

    const fresh = yield* settleAndRecreate(freshBase);
    expect(fresh.result).toMatchObject({
      _tag: "Recreated",
      oldCleanupRecordId: cleanupRecordId,
      fresh: { group: freshBase },
    });
    expect(fresh.events).toEqual(["proposal", "pause", "fence", "cleanup", "provision"]);
  }),
);

it.effect("rejects fresh evidence that omits a required workload OAuth role identity", () =>
  Effect.gen(function* () {
    const old = group("preview-oauth-old");
    const proposedArtifacts = { ...artifacts, workflowVersion: "2.0.0" };
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition("revision-new", proposedArtifacts, ["workflow-execution"]);
    const freshGroup = group("preview-oauth-fresh", "fresh-owner", proposedArtifacts, {
      ordinary_runner: "fresh-runner-client",
    });
    const runtime = {
      presentProposal: () => Effect.void,
      pauseAdmission: () => Effect.void,
      fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
        Effect.succeed(producerFenceEvidence(expectedBinding)),
      drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
        Effect.succeed(drainedOldWork(expectedBinding)),
      settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
        Effect.succeed(settledOldWork(expectedBinding)),
      proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
        Effect.succeed(cessationEvidence(expectedBinding)),
      endOldSessionAndCleanup: () => Effect.succeed("cleanup-oauth-old"),
      provisionFreshGroup: () =>
        Effect.succeed({
          group: freshGroup,
          requiredGroups: ["workflow-execution"],
          workloadOAuthClientIds: freshGroup.workloadOAuthClientIds,
          priorCleanupRecordId: "cleanup-oauth-old",
          pendingCommands: 0,
          browserQueueEntries: 0,
          responseReferences: 0,
        }),
      quarantineFreshGroup: () => Effect.void,
      quarantine: () => Effect.void,
      blockOrdinaryReassignment: () => Effect.succeed(true),
    };
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: old,
      previous,
      proposed,
      explicitlyRequested: true,
    }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
    expect(result).toMatchObject({
      _tag: "Quarantined",
      reason: "fresh-group-evidence-invalid",
    });
  }),
);

it.effect("rejects a fresh group that omits a proposed required workflow group", () =>
  Effect.gen(function* () {
    const old = group("preview-required-groups-old");
    const proposedArtifacts = { ...artifacts, workflowVersion: "2.0.0" };
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition("revision-new", proposedArtifacts, [
      "workflow-execution",
      "workflow-browser",
    ]);
    const freshGroup = group("preview-required-groups-fresh", "fresh-owner", proposedArtifacts);
    const runtime = {
      presentProposal: () => Effect.void,
      pauseAdmission: () => Effect.void,
      fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
        Effect.succeed(producerFenceEvidence(expectedBinding)),
      drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
        Effect.succeed(drainedOldWork(expectedBinding)),
      settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
        Effect.succeed(settledOldWork(expectedBinding)),
      proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
        Effect.succeed(cessationEvidence(expectedBinding)),
      endOldSessionAndCleanup: () => Effect.succeed("cleanup-required-groups-old"),
      provisionFreshGroup: (input: { readonly requiredGroups: ReadonlyArray<string> }) =>
        Effect.succeed({
          group: freshGroup,
          requiredGroups: input.requiredGroups
            .filter((requiredGroup) => proposed.requiredGroups.includes(requiredGroup))
            .slice(0, 1),
          workloadOAuthClientIds: freshGroup.workloadOAuthClientIds,
          priorCleanupRecordId: "cleanup-required-groups-old",
          pendingCommands: 0,
          browserQueueEntries: 0,
          responseReferences: 0,
        }),
      quarantineFreshGroup: () => Effect.void,
      quarantine: () => Effect.void,
      blockOrdinaryReassignment: () => Effect.succeed(true),
    };
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: old,
      previous,
      proposed,
      explicitlyRequested: true,
    }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
    expect(result).toMatchObject({
      _tag: "Quarantined",
      reason: "fresh-group-evidence-invalid",
    });
  }),
);

it.effect("rejects missing or mismatched producer-fence identity before draining old work", () =>
  Effect.gen(function* () {
    const old = group("preview-unbound-producer-fence");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, workflowVersion: "2.0.0" },
      ["workflow-execution"],
    );

    for (const mode of ["missing", "mismatched"] as const) {
      const calls: string[] = [];
      const runtime = {
        presentProposal: () => Effect.sync(() => void calls.push("proposal")),
        pauseAdmission: () => Effect.sync(() => void calls.push("pause")),
        fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
          Effect.sync(() => {
            calls.push("producer-fence");
            const evidence = producerFenceEvidence(expectedBinding);
            if (mode === "mismatched")
              return {
                ...evidence,
                binding: { ...expectedBinding, generation: expectedBinding.generation + 1 },
              };
            const { binding: _binding, ...unbound } = evidence;
            return unbound;
          }),
        drainOldWork: () =>
          Effect.sync(() => void calls.push("unexpected-drain")).pipe(
            Effect.as(
              drainedOldWork(workflowExecutionEvidenceBinding(old, previous.sourceRevision)),
            ),
          ),
        settleWithOldCode: boundOldWork,
        proveOldCessation: boundOldCessation,
        endOldSessionAndCleanup: () => Effect.succeed("cleanup"),
        provisionFreshGroup: () => Effect.succeed({}),
        quarantine: () => Effect.sync(() => void calls.push("quarantine")),
        blockOrdinaryReassignment: () => Effect.succeed(true),
      };
      const result = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));

      expect(result).toMatchObject({
        _tag: "Quarantined",
        reason: "producer-fence-evidence-invalid",
        phases: { producerFencing: "unconfirmed", drain: "not-started" },
      });
      expect(calls).toEqual(["proposal", "pause", "producer-fence", "quarantine"]);
    }
  }),
);

it.effect(
  "keeps an unresolved Ambiguous Outcome quarantined and never cleans up or allocates a replacement",
  () =>
    Effect.gen(function* () {
      const old = group("preview-ambiguous");
      const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
      const proposed = workflowDefinition(
        "revision-new",
        { ...artifacts, workflowVersion: "2.0.0" },
        ["workflow-execution"],
      );
      const calls: string[] = [];
      const runtime = {
        presentProposal: () => Effect.sync(() => void calls.push("proposal")).pipe(Effect.asVoid),
        pauseAdmission: () => Effect.sync(() => void calls.push("pause")).pipe(Effect.asVoid),
        fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
          Effect.sync(() => void calls.push("fence-producers")).pipe(
            Effect.as(producerFenceEvidence(expectedBinding)),
          ),
        drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
          Effect.succeed(drainedOldWork(expectedBinding)),
        settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
          Effect.sync(() => {
            calls.push("settle-old-code");
            return ambiguousOldWork(expectedBinding);
          }),
        proveOldCessation: () =>
          Effect.sync(() => void calls.push("unexpected-proof")).pipe(Effect.as({})),
        endOldSessionAndCleanup: () =>
          Effect.sync(() => void calls.push("unexpected-cleanup")).pipe(Effect.as("cleanup")),
        provisionFreshGroup: () => Effect.sync(() => void calls.push("unexpected-provision")),
        quarantine: (_old: WorkflowExecutionGroup, reason: string) =>
          Effect.sync(() => calls.push(`quarantine:${reason}`)),
        blockOrdinaryReassignment: () => Effect.succeed(true),
      };
      const result = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(result).toMatchObject({
        _tag: "Quarantined",
        reason: "old-work-settlement-ambiguous",
        phases: {
          proposal: "presented",
          admission: "paused",
          producerFencing: "fenced",
          drain: "completed",
          cancellation: "ambiguous",
          reconciliation: "not-required",
          settlement: "ambiguous",
          cessation: "not-started",
          oldSessionEnd: "not-started",
          cleanup: "not-started",
          freshGroup: "not-started",
          activation: "not-started",
          quarantine: "confirmed",
          ordinaryReassignment: "not-started",
        },
      });
      expect(calls).toEqual([
        "proposal",
        "pause",
        "fence-producers",
        "settle-old-code",
        "quarantine:old-work-settlement-ambiguous",
      ]);
    }),
);

it.effect("does not settle old work until producer-fence evidence is complete", () =>
  Effect.gen(function* () {
    const old = group("preview-producer-fence");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, workflowVersion: "2.0.0" },
      ["workflow-execution"],
    );
    const calls: string[] = [];
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: old,
      previous,
      proposed,
      explicitlyRequested: true,
    }).pipe(
      Effect.provide(
        IncompatibleWorkflowRecreationRuntimeLayer({
          presentProposal: () => Effect.void,
          pauseAdmission: () => Effect.void,
          fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
            Effect.succeed({
              ...producerFenceEvidence(expectedBinding),
              autonomousTriggersFenced: false,
            }),
          drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
            Effect.sync(() => {
              calls.push("drain-old-work");
              return drainedOldWork(expectedBinding);
            }),
          settleWithOldCode: (input: OldWorkSettlementInput) =>
            Effect.gen(function* () {
              calls.push("settle-old-code");
              return yield* boundOldWork(input);
            }),
          proveOldCessation: (input: OldWorkCessationInput) =>
            Effect.gen(function* () {
              calls.push("prove-old-cessation");
              return yield* boundOldCessation(input);
            }),
          endOldSessionAndCleanup: () =>
            Effect.sync(() => {
              calls.push("end-old-session-and-cleanup");
              return "unexpected-cleanup";
            }),
          provisionFreshGroup: () =>
            Effect.sync(() => {
              calls.push("provision-fresh-group");
              return {};
            }),
          quarantine: () => Effect.void,
          blockOrdinaryReassignment: () => Effect.succeed(true),
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Quarantined",
      reason: "producer-fencing-unconfirmed",
      phases: {
        admission: "paused",
        producerFencing: "unconfirmed",
        settlement: "not-started",
      },
    });
    expect(calls).toEqual([]);
  }),
);

it.effect("quarantines a drain that remains unresolved after five minutes", () =>
  Effect.gen(function* () {
    const old = group("preview-drain-timeout");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, workflowVersion: "2.0.0" },
      ["workflow-execution"],
    );
    const calls: string[] = [];
    const drainStarted = yield* Deferred.make<void>();
    const releaseDrain = yield* Deferred.make<void>();
    const recreation = Effect.uninterruptible(
      recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(
        Effect.provide(
          IncompatibleWorkflowRecreationRuntimeLayer({
            presentProposal: () => Effect.void,
            pauseAdmission: () => Effect.void,
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.succeed(producerFenceEvidence(expectedBinding)),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Deferred.succeed(drainStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseDrain)),
                Effect.as(drainedOldWork(expectedBinding)),
              ),
            settleWithOldCode: () =>
              Effect.sync(() => void calls.push("unexpected-cancellation-reconciliation")),
            proveOldCessation: () => Effect.sync(() => void calls.push("unexpected-proof")),
            endOldSessionAndCleanup: () =>
              Effect.sync(() => void calls.push("unexpected-cleanup")).pipe(
                Effect.as("cleanup-record"),
              ),
            provisionFreshGroup: () =>
              Effect.sync(() => void calls.push("unexpected-provision")).pipe(Effect.as({})),
            quarantine: () => Effect.sync(() => void calls.push("quarantine")),
            blockOrdinaryReassignment: () => Effect.succeed(false),
          }),
        ),
      ),
    ).pipe(Effect.forkChild);
    const fiber = yield* recreation;
    yield* Effect.gen(function* () {
      yield* Deferred.await(drainStarted);
      yield* TestClock.adjust(Duration.minutes(5));
      yield* Effect.yieldNow;
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({
        _tag: "Quarantined",
        reason: "old-work-drain-unconfirmed",
        phases: {
          drain: "unconfirmed",
          cancellation: "not-started",
          reconciliation: "not-started",
          settlement: "not-started",
          cessation: "not-started",
          drainElapsedMs: 300_000,
          acceptedWorkElapsedMs: 300_000,
          oldSessionEnd: "not-started",
          cleanup: "not-started",
        },
      });
      expect(calls).toEqual(["quarantine"]);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.minutes(5));
          yield* Deferred.succeed(releaseDrain, undefined);
          yield* Fiber.await(fiber);
        }),
      ),
    );
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps cessation unconfirmed when proof consumes the second five-minute window", () =>
  Effect.gen(function* () {
    const old = group("preview-cessation-budget-timeout");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, workflowVersion: "2.0.0" },
      ["workflow-execution"],
    );
    const calls: string[] = [];
    const proofStarted = yield* Deferred.make<void>();
    const releaseProof = yield* Deferred.make<void>();
    const recreation = Effect.uninterruptible(
      recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(
        Effect.provide(
          IncompatibleWorkflowRecreationRuntimeLayer({
            presentProposal: () => Effect.void,
            pauseAdmission: () => Effect.void,
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.succeed(producerFenceEvidence(expectedBinding)),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Effect.succeed(drainedOldWork(expectedBinding)),
            settleWithOldCode: ({ expectedBinding }) =>
              Effect.succeed(
                settledOldWork(expectedBinding, {
                  disposition: "settled",
                  drain: "completed",
                  cancellation: "completed",
                  reconciliation: "completed",
                }),
              ),
            proveOldCessation: ({ expectedBinding }) =>
              Deferred.succeed(proofStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseProof)),
                Effect.as(cessationEvidence(expectedBinding)),
              ),
            endOldSessionAndCleanup: () =>
              Effect.sync(() => void calls.push("unexpected-cleanup")).pipe(
                Effect.as("cleanup-record"),
              ),
            provisionFreshGroup: () =>
              Effect.sync(() => void calls.push("unexpected-provision")).pipe(Effect.as({})),
            quarantine: () => Effect.sync(() => void calls.push("quarantine")),
            blockOrdinaryReassignment: () => Effect.succeed(false),
          }),
        ),
      ),
    ).pipe(Effect.forkChild);
    const fiber = yield* recreation;
    yield* Effect.gen(function* () {
      yield* Deferred.await(proofStarted);
      yield* TestClock.adjust(Duration.minutes(5));
      yield* Effect.yieldNow;
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({
        _tag: "Quarantined",
        phases: {
          drain: "completed",
          cancellation: "completed",
          reconciliation: "completed",
          settlement: "settled",
          cessation: "unconfirmed",
          drainElapsedMs: 0,
          cancellationReconciliationElapsedMs: 0,
          cessationProofElapsedMs: 300_000,
          settlementElapsedMs: 300_000,
          acceptedWorkElapsedMs: 300_000,
          oldSessionEnd: "not-started",
          cleanup: "not-started",
        },
      });
      expect(calls).toEqual(["quarantine"]);
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.minutes(5));
          yield* Deferred.succeed(releaseProof, undefined);
          yield* Fiber.await(fiber);
        }),
      ),
    );
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "quarantines old work when cancel and reconciliation exceed five additional minutes",
  () =>
    Effect.gen(function* () {
      const old = group("preview-settlement-timeout");
      const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
      const proposed = workflowDefinition(
        "revision-new",
        { ...artifacts, workflowVersion: "2.0.0" },
        ["workflow-execution"],
      );
      const calls: string[] = [];
      const settlementStarted = yield* Deferred.make<void>();
      const releaseSettlement = yield* Deferred.make<void>();
      const recreation = Effect.uninterruptible(
        recreateIncompatibleWorkflowPreview({
          oldGroup: old,
          previous,
          proposed,
          explicitlyRequested: true,
        }).pipe(
          Effect.provide(
            IncompatibleWorkflowRecreationRuntimeLayer({
              presentProposal: () => Effect.void,
              pauseAdmission: () => Effect.void,
              fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
                Effect.succeed(producerFenceEvidence(expectedBinding)),
              drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
                Effect.succeed(drainedOldWork(expectedBinding)),
              settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) => {
                calls.push("settlement-started");
                return Deferred.succeed(settlementStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSettlement)),
                  Effect.as(settledOldWork(expectedBinding)),
                );
              },
              proveOldCessation: () => Effect.sync(() => void calls.push("unexpected-cessation")),
              endOldSessionAndCleanup: () =>
                Effect.sync(() => void calls.push("unexpected-cleanup")).pipe(
                  Effect.as("cleanup-record"),
                ),
              provisionFreshGroup: () =>
                Effect.sync(() => void calls.push("unexpected-provision")).pipe(Effect.as({})),
              quarantine: () => Effect.sync(() => void calls.push("quarantine-old")),
              blockOrdinaryReassignment: () => Effect.succeed(false),
            }),
          ),
        ),
      ).pipe(Effect.forkChild);
      const fiber = yield* recreation;
      yield* Effect.gen(function* () {
        yield* Deferred.await(settlementStarted);
        yield* TestClock.adjust(Duration.minutes(5));
        yield* Effect.yieldNow;

        expect(calls).toContain("quarantine-old");
        if (!calls.includes("quarantine-old")) return;
        const result = yield* Fiber.join(fiber);
        expect(result).toMatchObject({
          _tag: "Quarantined",
          reason: "old-work-settlement-ambiguous",
          phases: {
            settlement: "unconfirmed",
            cancellationReconciliationElapsedMs: 300_000,
            settlementElapsedMs: 300_000,
            cessation: "not-started",
            cleanup: "not-started",
            freshGroup: "not-started",
            quarantine: "confirmed",
          },
        });
        expect(calls).toEqual(["settlement-started", "quarantine-old"]);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.minutes(5));
            yield* Deferred.succeed(releaseSettlement, undefined);
            yield* Fiber.await(fiber);
          }),
        ),
      );
    }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps provisioning defects after provider side effects unconfirmed", () =>
  Effect.gen(function* () {
    const old = group("preview-provision-defect-old");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, workflowVersion: "2.0.0" },
      ["workflow-execution"],
    );
    const calls: string[] = [];
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: old,
      previous,
      proposed,
      explicitlyRequested: true,
    }).pipe(
      Effect.provide(
        IncompatibleWorkflowRecreationRuntimeLayer({
          presentProposal: () => Effect.void,
          pauseAdmission: () => Effect.void,
          fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
            Effect.succeed(producerFenceEvidence(expectedBinding)),
          drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
            Effect.succeed(drainedOldWork(expectedBinding)),
          settleWithOldCode: boundOldWork,
          proveOldCessation: boundOldCessation,
          endOldSessionAndCleanup: () => Effect.succeed("cleanup-provision-defect-old"),
          provisionFreshGroup: () =>
            Effect.sync(() => {
              calls.push("provision-side-effect");
              throw new Error("provider defect after fresh allocation");
            }),
          quarantine: (_group, reason) =>
            Effect.sync(() => void calls.push(`quarantine-old:${reason}`)),
          blockOrdinaryReassignment: () => Effect.succeed(true),
        }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "QuarantineUnconfirmed",
      reason: "recreation-failed",
      quarantineReason: "fresh-group-quarantine-unconfirmed",
      oldCleanupRecordId: "cleanup-provision-defect-old",
      phases: {
        oldSessionEnd: "ended",
        cleanup: "completed",
        freshGroup: "unconfirmed",
        quarantine: "unconfirmed",
      },
    });
    expect(calls).toEqual(["provision-side-effect", "quarantine-old:recreation-failed"]);
  }),
);

it.effect("does not activate an incompatible transition without explicit developer intent", () =>
  Effect.gen(function* () {
    const old = group("preview-unrequested");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, deployment: "f".repeat(64) },
      ["workflow-execution"],
    );
    const calls: string[] = [];
    const runtime = {
      presentProposal: () => Effect.sync(() => void calls.push("proposal")).pipe(Effect.asVoid),
      pauseAdmission: () => Effect.sync(() => void calls.push("pause")).pipe(Effect.asVoid),
      fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
        Effect.succeed(producerFenceEvidence(expectedBinding)),
      drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
        Effect.succeed(drainedOldWork(expectedBinding)),
      settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
        Effect.sync(() => void calls.push("settle")).pipe(
          Effect.as(settledOldWork(expectedBinding)),
        ),
      proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
        Effect.sync(() => void calls.push("prove")).pipe(
          Effect.as(cessationEvidence(expectedBinding)),
        ),
      endOldSessionAndCleanup: () =>
        Effect.sync(() => void calls.push("cleanup")).pipe(Effect.as("cleanup")),
      provisionFreshGroup: () => Effect.sync(() => void calls.push("provision")),
      quarantine: () => Effect.sync(() => void calls.push("quarantine")).pipe(Effect.asVoid),
      blockOrdinaryReassignment: () => Effect.succeed(true),
    };
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: old,
      previous,
      proposed,
      explicitlyRequested: false,
    }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
    expect(result).toMatchObject({ _tag: "Rejected", reason: "explicit-recreation-required" });
    expect(calls).toEqual([]);
  }),
);

it.effect("retains fresh-session recovery evidence through old-group quarantine", () => {
  const fixture = makeFreshSessionRecoveryFixture();
  return Effect.gen(function* () {
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: fixture.old,
      previous: fixture.previous,
      proposed: fixture.proposed,
      explicitlyRequested: true,
    }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(fixture.runtime)));

    expect(result._tag).toBe("QuarantineUnconfirmed");
    if (result._tag !== "QuarantineUnconfirmed") return;
    expect(result.recovery?.oldCleanupRecordId).toBe("cleanup-preview-recovery-old");
    expect(result.recovery?.freshSessionId).toBe("preview-recovery-fresh");
    expect(result.recovery?.recovery).toMatchObject({
      freshSessionDisposition: "pending",
      freshGroupQuarantineDisposition: "unconfirmed",
      recoveryRecordWritten: true,
      quarantineDisposition: "unconfirmed",
      recoveryRecordUpdated: true,
    });
    expect(fixture.persisted.at(-1)?.phases).toMatchObject({ quarantine: "unconfirmed" });
    expect(fixture.persisted.at(-1)?.recovery).toMatchObject({
      quarantineDisposition: "unconfirmed",
      ordinaryReassignmentBlocked: null,
    });

    fixture.persisted.length = 0;
    const confirmedFenceRuntime = {
      ...fixture.runtime,
      quarantine: () =>
        Effect.fail(new WorkflowExecutionError({ reason: "quarantine-write-failed" })),
      blockOrdinaryReassignment: () => Effect.succeed(true),
    };
    const confirmedFence = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: fixture.old,
      previous: fixture.previous,
      proposed: fixture.proposed,
      explicitlyRequested: true,
    }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(confirmedFenceRuntime)));
    expect(confirmedFence._tag).toBe("QuarantineUnconfirmed");
    expect(fixture.persisted.at(-1)?.phases).toMatchObject({
      quarantine: "unconfirmed",
      ordinaryReassignment: "blocked",
    });
    expect(fixture.persisted.at(-1)?.recovery).toMatchObject({
      quarantineDisposition: "ordinary-reassignment-blocked",
      ordinaryReassignmentBlocked: true,
    });

    yield* assertFailedReassignmentFenceIsUnknown(fixture);
    yield* assertTimedOutReassignmentFenceIsUnknown(fixture);
  }).pipe(Effect.provide(TestClock.layer()));
});

it.effect("quarantines when cessation proof is incomplete and never ends the old group", () =>
  Effect.gen(function* () {
    const old = group("preview-stale-runner");
    const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
    const proposed = workflowDefinition(
      "revision-new",
      { ...artifacts, workflowVersion: "2.0.0" },
      ["workflow-execution"],
    );
    const calls: string[] = [];
    const runtime = {
      presentProposal: () => Effect.void,
      pauseAdmission: () => Effect.void,
      fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
        Effect.succeed(producerFenceEvidence(expectedBinding)),
      drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
        Effect.succeed(drainedOldWork(expectedBinding)),
      settleWithOldCode: boundOldWork,
      proveOldCessation: ({ expectedBinding }: OldWorkCessationInput) =>
        Effect.succeed(cessationEvidence(expectedBinding, { runnerPodsTerminated: false })),
      endOldSessionAndCleanup: () =>
        Effect.sync(() => void calls.push("unexpected-cleanup")).pipe(Effect.as("cleanup")),
      provisionFreshGroup: () => Effect.sync(() => void calls.push("unexpected-provision")),
      quarantine: (_group: WorkflowExecutionGroup, reason: string) =>
        Effect.sync(() => calls.push(reason)),
      blockOrdinaryReassignment: () => Effect.succeed(true),
    };
    const result = yield* recreateIncompatibleWorkflowPreview({
      oldGroup: old,
      previous,
      proposed,
      explicitlyRequested: true,
    }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
    expect(result).toMatchObject({
      _tag: "Quarantined",
      reason: "old-execution-cessation-unproven",
    });
    expect(calls).toEqual(["old-execution-cessation-unproven"]);
  }),
);

it.effect(
  "reports unconfirmed quarantine and never claims a failed quarantine write succeeded",
  () =>
    Effect.gen(function* () {
      const old = group("preview-quarantine-write-fails");
      const previous = workflowDefinition("revision-old", artifacts, ["workflow-execution"]);
      const proposed = workflowDefinition(
        "revision-new",
        { ...artifacts, workflowVersion: "2.0.0" },
        ["workflow-execution"],
      );
      const result = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(
        Effect.provide(
          IncompatibleWorkflowRecreationRuntimeLayer({
            presentProposal: () => Effect.void,
            pauseAdmission: () => Effect.void,
            fenceProducers: ({ expectedBinding }: OldProducerFenceInput) =>
              Effect.succeed(producerFenceEvidence(expectedBinding)),
            drainOldWork: ({ expectedBinding }: OldWorkDrainInput) =>
              Effect.succeed(drainedOldWork(expectedBinding)),
            settleWithOldCode: ({ expectedBinding }: OldWorkSettlementInput) =>
              Effect.succeed(ambiguousOldWork(expectedBinding)),
            proveOldCessation: () => Effect.succeed({}),
            endOldSessionAndCleanup: () => Effect.succeed("unexpected"),
            provisionFreshGroup: () => Effect.succeed({}),
            quarantine: () =>
              Effect.fail(new WorkflowExecutionError({ reason: "storage-offline" })),
            blockOrdinaryReassignment: () => Effect.succeed(true),
          }),
        ),
      );
      expect(result).toMatchObject({
        _tag: "QuarantineUnconfirmed",
        reason: "old-work-settlement-ambiguous",
        quarantineReason: "quarantine-write-unconfirmed",
        ordinaryReassignmentBlocked: true,
        phases: {
          quarantine: "unconfirmed",
          ordinaryReassignment: "blocked",
        },
      });
    }),
);
