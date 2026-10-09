import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  classifyWorkflowPreviewTransition,
  IncompatibleWorkflowRecreationRuntimeLayer,
  ownedWorkflowExecutionLiveProfileEnabled,
  recreateIncompatibleWorkflowPreview,
  requireAutomaticWorkflowCompatibility,
  verifyCompatibleWorkflowReplacement,
  verifyWorkflowEnqueue,
  verifyWorkflowRunnerEvidence,
  WorkflowExecutionError,
  workflowExecutionCleanupDisposition,
  workflowExecutionGroupIdentity,
  type WorkflowExecutionArtifacts,
  type WorkflowExecutionGroup,
} from "./owned-workflow-execution";

const artifacts: WorkflowExecutionArtifacts = {
  api: "a".repeat(64),
  runner: "b".repeat(64),
  contracts: "c".repeat(64),
  deployment: "d".repeat(64),
  workflowVersion: "1.0.0",
};
const group = (sessionId: string, ownerToken = `owner-${sessionId}`, groupArtifacts = artifacts) =>
  workflowExecutionGroupIdentity({
    sessionId,
    ownerToken,
    generation: 1,
    database: `db_${sessionId.replaceAll("-", "_")}`,
    apiEndpoint: `https://${sessionId}.api.dev.test`,
    observationEndpoint: `https://${sessionId}.api.dev.test/observe`,
    artifacts: groupArtifacts,
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
  Effect.match(effect, {
    onFailure: (error: WorkflowExecutionError) => error.reason,
    onSuccess: () => "accepted",
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
  expect(
    workflowExecutionCleanupDisposition({
      providerOperationsTerminal: true,
      apiFenced: true,
      runnerPodsTerminated: true,
      staleRunnersTerminated: true,
      reclaimedCommandLeasesReconciled: true,
      hostDependenciesAccountedFor: true,
      activeExternalCallsTerminated: true,
      acceptedWorkSettled: true,
      unknownOwnership: false,
    }),
  ).toBe("deletable");
  expect(
    workflowExecutionCleanupDisposition({
      providerOperationsTerminal: true,
      apiFenced: true,
      runnerPodsTerminated: true,
      staleRunnersTerminated: true,
      reclaimedCommandLeasesReconciled: true,
      hostDependenciesAccountedFor: true,
      activeExternalCallsTerminated: true,
      acceptedWorkSettled: false,
      unknownOwnership: false,
    }),
  ).toBe("quarantined");
  expect(
    workflowExecutionCleanupDisposition({
      providerOperationsTerminal: true,
      apiFenced: true,
      runnerPodsTerminated: true,
      staleRunnersTerminated: true,
      reclaimedCommandLeasesReconciled: true,
      hostDependenciesAccountedFor: true,
      activeExternalCallsTerminated: true,
      acceptedWorkSettled: true,
      unknownOwnership: true,
    }),
  ).toBe("quarantined");
  expect(
    workflowExecutionCleanupDisposition({
      providerOperationsTerminal: true,
      apiFenced: true,
      runnerPodsTerminated: true,
      staleRunnersTerminated: true,
      reclaimedCommandLeasesReconciled: false,
      hostDependenciesAccountedFor: true,
      activeExternalCallsTerminated: true,
      acceptedWorkSettled: true,
      unknownOwnership: false,
    }),
  ).toBe("quarantined");
  expect(
    workflowExecutionCleanupDisposition({
      providerOperationsTerminal: true,
      apiFenced: true,
      runnerPodsTerminated: true,
      acceptedWorkSettled: true,
    }),
  ).toBe("quarantined");
});

it("keeps the owned workflow execution live profile unavailable", () => {
  expect(ownedWorkflowExecutionLiveProfileEnabled).toBe(false);
});

it.effect(
  "requires an explicit proposal and settles incompatible work with immutable old artifacts before fresh identities",
  () =>
    Effect.gen(function* () {
      const old = group("preview-old");
      const proposedArtifacts = {
        ...artifacts,
        contracts: "e".repeat(64),
        workflowVersion: "2.0.0",
      };
      const previous = { artifacts, requiredGroups: ["workflow-execution"] };
      const proposed = {
        artifacts: proposedArtifacts,
        requiredGroups: ["workflow-execution", "browser"],
      };
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
        settleWithOldCode: ({ oldArtifacts }: { oldArtifacts: WorkflowExecutionArtifacts }) =>
          Effect.sync(() => {
            expect(oldArtifacts).toBe(old.artifacts);
            calls.push("settle-old-code");
            return "settled" as const;
          }),
        proveOldCessation: () =>
          Effect.sync(() => {
            calls.push("prove-cessation");
            return {
              providerOperationsTerminal: true,
              apiFenced: true,
              runnerPodsTerminated: true,
              staleRunnersTerminated: true,
              reclaimedCommandLeasesReconciled: true,
              hostDependenciesAccountedFor: true,
              activeExternalCallsTerminated: true,
              acceptedWorkSettled: true,
              unknownOwnership: false,
            };
          }),
        endOldSessionAndCleanup: () =>
          Effect.sync(() => {
            calls.push("end-and-cleanup");
            return cleanupRecordId;
          }),
        provisionFreshGroup: (input: {
          readonly priorCleanupRecordId: string;
          readonly transferPendingWork: false;
        }) =>
          Effect.sync(() => {
            expect(input.priorCleanupRecordId).toBe(cleanupRecordId);
            expect(input.transferPendingWork).toBe(false);
            calls.push("provision-fresh");
            return {
              group: freshGroup,
              priorCleanupRecordId: cleanupRecordId,
              pendingCommands: 0,
              browserQueueEntries: 0,
              responseReferences: 0,
            };
          }),
        quarantine: () => Effect.sync(() => void calls.push("quarantine")).pipe(Effect.asVoid),
      };
      const result = yield* recreateIncompatibleWorkflowPreview({
        oldGroup: old,
        previous,
        proposed,
        explicitlyRequested: true,
      }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(runtime)));
      expect(result._tag).toBe("Recreated");
      if (result._tag === "Recreated") expect(result.oldCleanupRecordId).toBe(cleanupRecordId);
      expect(calls).toEqual([
        "proposal",
        "pause",
        "settle-old-code",
        "prove-cessation",
        "end-and-cleanup",
        "provision-fresh",
      ]);
    }),
);

it.effect(
  "keeps an unresolved Ambiguous Outcome quarantined and never cleans up or allocates a replacement",
  () =>
    Effect.gen(function* () {
      const old = group("preview-ambiguous");
      const previous = { artifacts, requiredGroups: ["workflow-execution"] };
      const proposed = {
        artifacts: { ...artifacts, workflowVersion: "2.0.0" },
        requiredGroups: ["workflow-execution"],
      };
      const calls: string[] = [];
      const runtime = {
        presentProposal: () => Effect.sync(() => void calls.push("proposal")).pipe(Effect.asVoid),
        pauseAdmission: () => Effect.sync(() => void calls.push("pause")).pipe(Effect.asVoid),
        settleWithOldCode: () =>
          Effect.sync(() => {
            calls.push("settle-old-code");
            return "ambiguous" as const;
          }),
        proveOldCessation: () =>
          Effect.sync(() => void calls.push("unexpected-proof")).pipe(Effect.as({})),
        endOldSessionAndCleanup: () =>
          Effect.sync(() => void calls.push("unexpected-cleanup")).pipe(Effect.as("cleanup")),
        provisionFreshGroup: () => Effect.sync(() => void calls.push("unexpected-provision")),
        quarantine: (_old: WorkflowExecutionGroup, reason: string) =>
          Effect.sync(() => calls.push(`quarantine:${reason}`)),
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
      });
      expect(calls).toEqual([
        "proposal",
        "pause",
        "settle-old-code",
        "quarantine:old-work-settlement-ambiguous",
      ]);
    }),
);

it.effect("does not activate an incompatible transition without explicit developer intent", () =>
  Effect.gen(function* () {
    const old = group("preview-unrequested");
    const previous = { artifacts, requiredGroups: ["workflow-execution"] };
    const proposed = {
      artifacts: { ...artifacts, deployment: "f".repeat(64) },
      requiredGroups: ["workflow-execution"],
    };
    const calls: string[] = [];
    const runtime = {
      presentProposal: () => Effect.sync(() => void calls.push("proposal")).pipe(Effect.asVoid),
      pauseAdmission: () => Effect.sync(() => void calls.push("pause")).pipe(Effect.asVoid),
      settleWithOldCode: () =>
        Effect.sync(() => void calls.push("settle")).pipe(Effect.as("settled" as const)),
      proveOldCessation: () => Effect.sync(() => void calls.push("prove")).pipe(Effect.as({})),
      endOldSessionAndCleanup: () =>
        Effect.sync(() => void calls.push("cleanup")).pipe(Effect.as("cleanup")),
      provisionFreshGroup: () => Effect.sync(() => void calls.push("provision")),
      quarantine: () => Effect.sync(() => void calls.push("quarantine")).pipe(Effect.asVoid),
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

it.effect("quarantines when cessation proof is incomplete and never ends the old group", () =>
  Effect.gen(function* () {
    const old = group("preview-stale-runner");
    const previous = { artifacts, requiredGroups: ["workflow-execution"] };
    const proposed = {
      artifacts: { ...artifacts, workflowVersion: "2.0.0" },
      requiredGroups: ["workflow-execution"],
    };
    const calls: string[] = [];
    const runtime = {
      presentProposal: () => Effect.void,
      pauseAdmission: () => Effect.void,
      settleWithOldCode: () => Effect.succeed("settled" as const),
      proveOldCessation: () =>
        Effect.succeed({
          providerOperationsTerminal: true,
          apiFenced: true,
          runnerPodsTerminated: false,
          staleRunnersTerminated: true,
          reclaimedCommandLeasesReconciled: true,
          hostDependenciesAccountedFor: true,
          activeExternalCallsTerminated: true,
          acceptedWorkSettled: true,
          unknownOwnership: false,
        }),
      endOldSessionAndCleanup: () =>
        Effect.sync(() => void calls.push("unexpected-cleanup")).pipe(Effect.as("cleanup")),
      provisionFreshGroup: () => Effect.sync(() => void calls.push("unexpected-provision")),
      quarantine: (_group: WorkflowExecutionGroup, reason: string) =>
        Effect.sync(() => calls.push(reason)),
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
