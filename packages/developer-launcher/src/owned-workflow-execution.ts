import { createHash } from "node:crypto";
import { Context, Effect, Layer, Schema } from "effect";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Identifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/));

/** Immutable identities supplied by the controller and shared by the API and its runners. */
export const WorkflowExecutionArtifacts = Schema.Struct({
  api: Digest,
  runner: Digest,
  contracts: Digest,
  deployment: Digest,
  workflowVersion: Schema.NonEmptyString,
});
export type WorkflowExecutionArtifacts = typeof WorkflowExecutionArtifacts.Type;

export const WorkflowExecutionGroup = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  ownerToken: Schema.NonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  database: Identifier,
  applicationStore: Identifier,
  commandStore: Identifier,
  runStore: Identifier,
  clusterStore: Identifier,
  apiEndpoint: Schema.NonEmptyString,
  observationEndpoint: Schema.NonEmptyString,
  artifacts: WorkflowExecutionArtifacts,
});
export type WorkflowExecutionGroup = typeof WorkflowExecutionGroup.Type;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
};

export const workflowExecutionGroupDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

type WorkflowExecutionStoreIdentity = Pick<
  WorkflowExecutionGroup,
  "sessionId" | "ownerToken" | "generation" | "database"
>;
const workflowExecutionStoreIds = (identity: WorkflowExecutionStoreIdentity) => {
  const prefix = `w${workflowExecutionGroupDigest({
    sessionId: identity.sessionId,
    ownerToken: identity.ownerToken,
    generation: identity.generation,
    database: identity.database,
  }).slice(0, 24)}`;
  return {
    applicationStore: `${prefix}_application`,
    commandStore: `${prefix}_command`,
    runStore: `${prefix}_run`,
    clusterStore: `${prefix}_cluster`,
  };
};

export const workflowExecutionGroupIdentity = (input: {
  readonly sessionId: string;
  readonly ownerToken: string;
  readonly generation: number;
  readonly database: string;
  readonly apiEndpoint: string;
  readonly observationEndpoint: string;
  readonly artifacts: WorkflowExecutionArtifacts;
}): WorkflowExecutionGroup => {
  return Schema.decodeUnknownSync(WorkflowExecutionGroup)({
    ...input,
    ...workflowExecutionStoreIds(input),
  });
};

export const WorkflowRunnerEvidence = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  ownerToken: Schema.NonEmptyString,
  generation: Schema.Int,
  role: Schema.Literal("ordinary-runner"),
  podUid: Schema.NonEmptyString,
  address: Schema.NonEmptyString,
  healthy: Schema.Boolean,
  database: Identifier,
  applicationStore: Identifier,
  commandStore: Identifier,
  runStore: Identifier,
  clusterStore: Identifier,
  capabilities: Schema.Array(Schema.NonEmptyString),
  artifacts: WorkflowExecutionArtifacts,
  shardOwnership: Schema.Struct({ owned: Schema.Boolean, count: Schema.Int }),
});
export type WorkflowRunnerEvidence = typeof WorkflowRunnerEvidence.Type;

export class WorkflowExecutionError extends Schema.TaggedErrorClass<WorkflowExecutionError>()(
  "WorkflowExecutionError",
  { reason: Schema.String },
) {}

const reject = (reason: string) => Effect.fail(new WorkflowExecutionError({ reason }));
const decodeGroup = (input: unknown) =>
  Effect.gen(function* () {
    const group = yield* Schema.decodeUnknownEffect(WorkflowExecutionGroup)(input).pipe(
      Effect.mapError(() => new WorkflowExecutionError({ reason: "workflow-group-invalid" })),
    );
    const expected = workflowExecutionStoreIds(group);
    if (
      group.applicationStore !== expected.applicationStore ||
      group.commandStore !== expected.commandStore ||
      group.runStore !== expected.runStore ||
      group.clusterStore !== expected.clusterStore
    )
      return yield* reject("workflow-group-store-identity-mismatch");
    return group;
  });
const WorkflowEnqueueRequest = Schema.Struct({
  group: WorkflowExecutionGroup,
  observationGroup: WorkflowExecutionGroup,
  selectedControlledSmoke: Schema.Boolean,
  autonomousTriggersEnabled: Schema.Boolean,
  externalEffects: Schema.Boolean,
});
const sameArtifacts = (left: WorkflowExecutionArtifacts, right: WorkflowExecutionArtifacts) =>
  left.api === right.api &&
  left.runner === right.runner &&
  left.contracts === right.contracts &&
  left.deployment === right.deployment &&
  left.workflowVersion === right.workflowVersion;
const workflowExecutionDurableIdentity = (group: WorkflowExecutionGroup) => ({
  sessionId: group.sessionId,
  ownerToken: group.ownerToken,
  generation: group.generation,
  database: group.database,
  applicationStore: group.applicationStore,
  commandStore: group.commandStore,
  runStore: group.runStore,
  clusterStore: group.clusterStore,
  apiEndpoint: group.apiEndpoint,
  observationEndpoint: group.observationEndpoint,
});
const sameCompatibleWorkflowArtifacts = (
  left: WorkflowExecutionArtifacts,
  right: WorkflowExecutionArtifacts,
) =>
  left.contracts === right.contracts &&
  left.deployment === right.deployment &&
  left.workflowVersion === right.workflowVersion;
const sameWorkflowExecutionGroup = (left: WorkflowExecutionGroup, right: WorkflowExecutionGroup) =>
  workflowExecutionGroupDigest(workflowExecutionDurableIdentity(left)) ===
  workflowExecutionGroupDigest(workflowExecutionDurableIdentity(right));
const belongsToWorkflowGroup = (runner: WorkflowRunnerEvidence, group: WorkflowExecutionGroup) =>
  runner.sessionId === group.sessionId &&
  runner.ownerToken === group.ownerToken &&
  runner.generation === group.generation;
const usesWorkflowGroupStores = (runner: WorkflowRunnerEvidence, group: WorkflowExecutionGroup) =>
  runner.database === group.database &&
  runner.applicationStore === group.applicationStore &&
  runner.commandStore === group.commandStore &&
  runner.runStore === group.runStore &&
  runner.clusterStore === group.clusterStore;
const hasCompleteRunnerObservation = (runner: WorkflowRunnerEvidence) =>
  runner.healthy && runner.podUid.length > 0 && runner.address.length > 0;

/**
 * Validate provider-supplied API-to-runner evidence for this exact group. This checks
 * evidence consistency; it does not query Kubernetes, discovery, health endpoints, or
 * shard locks. A runtime adapter must obtain those facts from the actual providers.
 */
export const verifyWorkflowRunnerEvidence = (groupInput: unknown, input: unknown) =>
  Effect.gen(function* () {
    const ownedGroup = yield* decodeGroup(groupInput);
    const runner = yield* Schema.decodeUnknownEffect(WorkflowRunnerEvidence)(input).pipe(
      Effect.mapError(() => new WorkflowExecutionError({ reason: "runner-evidence-invalid" })),
    );
    if (!belongsToWorkflowGroup(runner, ownedGroup)) return yield* reject("runner-owner-mismatch");
    if (!usesWorkflowGroupStores(runner, ownedGroup))
      return yield* reject("runner-state-plane-mismatch");
    if (!hasCompleteRunnerObservation(runner))
      return yield* reject("runner-not-healthy-or-unregistered");
    if (!sameArtifacts(runner.artifacts, ownedGroup.artifacts))
      return yield* reject("runner-artifact-mismatch");
    if (!runner.capabilities.includes("ordinary-workflow-execution"))
      return yield* reject("runner-capability-missing");
    if (!runner.shardOwnership.owned || runner.shardOwnership.count !== 600)
      return yield* reject("runner-shard-ownership-mismatch");
  });

/** Preserve durable idempotency keys by requiring replacement to reuse the same group. */
export const verifyCompatibleWorkflowReplacement = (
  previousInput: unknown,
  replacementInput: unknown,
) =>
  Effect.gen(function* () {
    const previous = yield* decodeGroup(previousInput);
    const replacement = yield* decodeGroup(replacementInput);
    if (!sameWorkflowExecutionGroup(previous, replacement))
      return yield* reject("replacement-changes-durable-workflow-identity");
    if (previous.artifacts.contracts !== replacement.artifacts.contracts)
      return yield* reject("replacement-contracts-incompatible");
    if (previous.artifacts.deployment !== replacement.artifacts.deployment)
      return yield* reject("replacement-deployment-incompatible");
    if (previous.artifacts.workflowVersion !== replacement.artifacts.workflowVersion)
      return yield* reject("replacement-workflow-version-incompatible");
    return yield* Effect.void;
  });

/** Only an explicitly requested controlled smoke may enqueue work at this stage. */
export const verifyWorkflowEnqueue = (input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(WorkflowEnqueueRequest)(input).pipe(
      Effect.mapError(
        () => new WorkflowExecutionError({ reason: "workflow-enqueue-input-invalid" }),
      ),
    );
    const group = yield* decodeGroup(request.group);
    const observationGroup = yield* decodeGroup(request.observationGroup);
    if (
      !request.selectedControlledSmoke ||
      request.autonomousTriggersEnabled ||
      request.externalEffects
    )
      return yield* reject("workflow-enqueue-not-an-isolated-controlled-smoke");
    if (
      !sameWorkflowExecutionGroup(group, observationGroup) ||
      !sameCompatibleWorkflowArtifacts(group.artifacts, observationGroup.artifacts)
    )
      return yield* reject("enqueue-observation-group-mismatch");
  });

export const WorkflowExecutionCessationEvidence = Schema.Struct({
  providerOperationsTerminal: Schema.Boolean,
  apiFenced: Schema.Boolean,
  runnerPodsTerminated: Schema.Boolean,
  staleRunnersTerminated: Schema.Boolean,
  reclaimedCommandLeasesReconciled: Schema.Boolean,
  hostDependenciesAccountedFor: Schema.Boolean,
  activeExternalCallsTerminated: Schema.Boolean,
  acceptedWorkSettled: Schema.Boolean,
  unknownOwnership: Schema.Boolean,
});
export type WorkflowExecutionCessationEvidence = typeof WorkflowExecutionCessationEvidence.Type;
export const workflowExecutionCleanupDisposition = (input: unknown) => {
  if (!Schema.is(WorkflowExecutionCessationEvidence)(input)) return "quarantined" as const;
  return input.providerOperationsTerminal &&
    input.apiFenced &&
    input.runnerPodsTerminated &&
    input.staleRunnersTerminated &&
    input.reclaimedCommandLeasesReconciled &&
    input.hostDependenciesAccountedFor &&
    input.activeExternalCallsTerminated &&
    input.acceptedWorkSettled &&
    !input.unknownOwnership
    ? ("deletable" as const)
    : ("quarantined" as const);
};

export const WorkflowPreviewDefinition = Schema.Struct({
  artifacts: WorkflowExecutionArtifacts,
  requiredGroups: Schema.Array(Schema.NonEmptyString),
});
export type WorkflowPreviewDefinition = typeof WorkflowPreviewDefinition.Type;

export const WorkflowPreviewTransition = Schema.Struct({
  classification: Schema.Literals(["compatible", "incompatible"]),
  reasons: Schema.Array(
    Schema.Literals([
      "workflow-contracts-changed",
      "durable-deployment-changed",
      "action-version-changed",
      "workflow-group-added",
    ]),
  ),
  previousDefinition: WorkflowPreviewDefinition,
  proposedDefinition: WorkflowPreviewDefinition,
});
export type WorkflowPreviewTransition = typeof WorkflowPreviewTransition.Type;

/** Only contract, durable-format, action-version and group changes require recreation. */
export const classifyWorkflowPreviewTransition = (
  previous: WorkflowPreviewDefinition,
  proposed: WorkflowPreviewDefinition,
): WorkflowPreviewTransition => {
  const reasons: Array<WorkflowPreviewTransition["reasons"][number]> = [];
  if (previous.artifacts.contracts !== proposed.artifacts.contracts)
    reasons.push("workflow-contracts-changed");
  if (previous.artifacts.deployment !== proposed.artifacts.deployment)
    reasons.push("durable-deployment-changed");
  if (previous.artifacts.workflowVersion !== proposed.artifacts.workflowVersion)
    reasons.push("action-version-changed");
  if (proposed.requiredGroups.some((group) => !previous.requiredGroups.includes(group)))
    reasons.push("workflow-group-added");
  return {
    classification: reasons.length === 0 ? "compatible" : "incompatible",
    reasons,
    previousDefinition: previous,
    proposedDefinition: proposed,
  };
};

export const WorkflowFreshGroupEvidence = Schema.Struct({
  group: WorkflowExecutionGroup,
  priorCleanupRecordId: Schema.NonEmptyString,
  pendingCommands: Schema.Literal(0),
  browserQueueEntries: Schema.Literal(0),
  responseReferences: Schema.Literal(0),
});
export type WorkflowFreshGroupEvidence = typeof WorkflowFreshGroupEvidence.Type;

export type WorkflowRecreationResult =
  | {
      readonly _tag: "Recreated";
      readonly transition: WorkflowPreviewTransition;
      readonly oldCleanupRecordId: string;
      readonly fresh: WorkflowFreshGroupEvidence;
    }
  | {
      readonly _tag: "Rejected";
      readonly transition: WorkflowPreviewTransition;
      readonly reason: string;
    }
  | {
      readonly _tag: "Quarantined";
      readonly transition: WorkflowPreviewTransition;
      readonly reason: string;
    };

export interface IncompatibleWorkflowRecreationRuntimeApi {
  readonly presentProposal: (
    transition: WorkflowPreviewTransition,
  ) => Effect.Effect<void, WorkflowExecutionError>;
  readonly pauseAdmission: (
    oldGroup: WorkflowExecutionGroup,
  ) => Effect.Effect<void, WorkflowExecutionError>;
  /** The executor and dependency identities come from the immutable old group. */
  readonly settleWithOldCode: (input: {
    readonly oldGroup: WorkflowExecutionGroup;
    readonly oldArtifacts: WorkflowExecutionArtifacts;
    readonly strategy: "drain-cancel-reconcile";
  }) => Effect.Effect<"settled" | "ambiguous", WorkflowExecutionError>;
  readonly proveOldCessation: (
    oldGroup: WorkflowExecutionGroup,
  ) => Effect.Effect<unknown, WorkflowExecutionError>;
  /** This ends the old session and returns its exact durable cleanup record. */
  readonly endOldSessionAndCleanup: (
    oldGroup: WorkflowExecutionGroup,
  ) => Effect.Effect<string, WorkflowExecutionError>;
  /** Provider must provision an empty group and retain the cleanup record link. */
  readonly provisionFreshGroup: (input: {
    readonly oldGroup: WorkflowExecutionGroup;
    readonly artifacts: WorkflowExecutionArtifacts;
    readonly requiredGroups: ReadonlyArray<string>;
    readonly priorCleanupRecordId: string;
    readonly transferPendingWork: false;
  }) => Effect.Effect<unknown, WorkflowExecutionError>;
  readonly quarantine: (
    oldGroup: WorkflowExecutionGroup,
    reason: string,
  ) => Effect.Effect<void, WorkflowExecutionError>;
}

export class IncompatibleWorkflowRecreationRuntime extends Context.Service<
  IncompatibleWorkflowRecreationRuntime,
  IncompatibleWorkflowRecreationRuntimeApi
>()("developer-launcher/IncompatibleWorkflowRecreationRuntime") {}

export const IncompatibleWorkflowRecreationRuntimeLayer = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
) => Layer.succeed(IncompatibleWorkflowRecreationRuntime, runtime);

const quarantineWorkflowRecreation = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  transition: WorkflowPreviewTransition,
  reason: string,
): Effect.Effect<WorkflowRecreationResult> =>
  runtime
    .quarantine(oldGroup, reason)
    .pipe(Effect.ignore, Effect.as({ _tag: "Quarantined" as const, transition, reason }));

/** Automatic watch may report a proposal but cannot activate an incompatible definition. */
export const requireAutomaticWorkflowCompatibility = (transition: WorkflowPreviewTransition) =>
  transition.classification === "compatible"
    ? Effect.void
    : reject("incompatible-workflow-transition-requires-explicit-recreation");

const recreationFailure = (reason: string) => new WorkflowExecutionError({ reason });
const recreationStep = <A>(
  step: Effect.Effect<A, WorkflowExecutionError>,
  reason: string,
): Effect.Effect<A, WorkflowExecutionError> =>
  step.pipe(Effect.mapError(() => recreationFailure(reason)));

const settleAndEndOldWorkflowGroup = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  transition: WorkflowPreviewTransition,
): Effect.Effect<string, WorkflowExecutionError> =>
  Effect.gen(function* () {
    yield* recreationStep(runtime.presentProposal(transition), "proposal-not-presented");
    yield* recreationStep(runtime.pauseAdmission(oldGroup), "admission-pause-unconfirmed");
    const settled = yield* recreationStep(
      runtime.settleWithOldCode({
        oldGroup,
        oldArtifacts: oldGroup.artifacts,
        strategy: "drain-cancel-reconcile",
      }),
      "old-work-settlement-ambiguous",
    );
    if (settled !== "settled") return yield* reject("old-work-settlement-ambiguous");

    const cessation = yield* recreationStep(
      runtime.proveOldCessation(oldGroup),
      "old-execution-cessation-unproven",
    );
    if (workflowExecutionCleanupDisposition(cessation) !== "deletable")
      return yield* reject("old-execution-cessation-unproven");

    const cleanupRecordId = yield* recreationStep(
      runtime.endOldSessionAndCleanup(oldGroup),
      "old-cleanup-record-unavailable",
    );
    if (cleanupRecordId.trim().length === 0) return yield* reject("old-cleanup-record-unavailable");
    return cleanupRecordId;
  });

const freshWorkflowGroupHasNewIdentities = (
  oldGroup: WorkflowExecutionGroup,
  freshGroup: WorkflowExecutionGroup,
) =>
  freshGroup.sessionId !== oldGroup.sessionId &&
  freshGroup.ownerToken !== oldGroup.ownerToken &&
  freshGroup.database !== oldGroup.database &&
  freshGroup.applicationStore !== oldGroup.applicationStore &&
  freshGroup.commandStore !== oldGroup.commandStore &&
  freshGroup.runStore !== oldGroup.runStore &&
  freshGroup.clusterStore !== oldGroup.clusterStore;

const isExpectedFreshWorkflowGroup = (
  oldGroup: WorkflowExecutionGroup,
  proposed: WorkflowPreviewDefinition,
  cleanupRecordId: string,
  evidence: WorkflowFreshGroupEvidence,
) =>
  evidence.priorCleanupRecordId === cleanupRecordId &&
  freshWorkflowGroupHasNewIdentities(oldGroup, evidence.group) &&
  evidence.group.artifacts.contracts === proposed.artifacts.contracts &&
  evidence.group.artifacts.deployment === proposed.artifacts.deployment &&
  evidence.group.artifacts.workflowVersion === proposed.artifacts.workflowVersion;

const provisionFreshWorkflowGroup = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  proposed: WorkflowPreviewDefinition,
  cleanupRecordId: string,
): Effect.Effect<WorkflowFreshGroupEvidence, WorkflowExecutionError> =>
  runtime
    .provisionFreshGroup({
      oldGroup,
      artifacts: proposed.artifacts,
      requiredGroups: proposed.requiredGroups,
      priorCleanupRecordId: cleanupRecordId,
      transferPendingWork: false,
    })
    .pipe(
      Effect.mapError(() => recreationFailure("fresh-group-provisioning-unverified")),
      Effect.flatMap((input) =>
        Schema.decodeUnknownEffect(WorkflowFreshGroupEvidence)(input).pipe(
          Effect.mapError(() => recreationFailure("fresh-group-evidence-invalid")),
        ),
      ),
      Effect.flatMap((evidence) =>
        isExpectedFreshWorkflowGroup(oldGroup, proposed, cleanupRecordId, evidence)
          ? Effect.succeed(evidence)
          : Effect.fail(recreationFailure("fresh-group-evidence-invalid")),
      ),
    );

/**
 * Recreate only after old-code settlement and provider cessation proof. Every uncertain
 * result retains quarantine and prevents cleanup or allocation of a replacement group.
 */
export const recreateIncompatibleWorkflowPreview = (input: {
  readonly oldGroup: WorkflowExecutionGroup;
  readonly previous: WorkflowPreviewDefinition;
  readonly proposed: WorkflowPreviewDefinition;
  readonly explicitlyRequested: boolean;
}): Effect.Effect<WorkflowRecreationResult, never, IncompatibleWorkflowRecreationRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* IncompatibleWorkflowRecreationRuntime;
    const transition = classifyWorkflowPreviewTransition(input.previous, input.proposed);
    if (transition.classification === "compatible")
      return { _tag: "Rejected" as const, transition, reason: "transition-is-compatible" };
    if (!input.explicitlyRequested)
      return { _tag: "Rejected" as const, transition, reason: "explicit-recreation-required" };

    const priorGroup = yield* Effect.match(
      settleAndEndOldWorkflowGroup(runtime, input.oldGroup, transition),
      {
        onFailure: (error) => ({ _tag: "Failed" as const, reason: error.reason }),
        onSuccess: (cleanupRecordId) => ({ _tag: "Settled" as const, cleanupRecordId }),
      },
    );
    if (priorGroup._tag === "Failed")
      return yield* quarantineWorkflowRecreation(
        runtime,
        input.oldGroup,
        transition,
        priorGroup.reason,
      );

    const freshGroup = yield* Effect.match(
      provisionFreshWorkflowGroup(
        runtime,
        input.oldGroup,
        input.proposed,
        priorGroup.cleanupRecordId,
      ),
      {
        onFailure: (error) => ({ _tag: "Failed" as const, reason: error.reason }),
        onSuccess: (evidence) => ({ _tag: "Provisioned" as const, evidence }),
      },
    );
    if (freshGroup._tag === "Failed")
      return yield* quarantineWorkflowRecreation(
        runtime,
        input.oldGroup,
        transition,
        freshGroup.reason,
      );
    return {
      _tag: "Recreated" as const,
      transition,
      oldCleanupRecordId: priorGroup.cleanupRecordId,
      fresh: freshGroup.evidence,
    };
  }).pipe(
    Effect.catchCause(() =>
      Effect.gen(function* () {
        const runtime = yield* IncompatibleWorkflowRecreationRuntime;
        const reason = "recreation-failed";
        yield* runtime.quarantine(input.oldGroup, reason).pipe(Effect.ignore);
        return {
          _tag: "Quarantined" as const,
          transition: classifyWorkflowPreviewTransition(input.previous, input.proposed),
          reason,
        };
      }),
    ),
  );

/** Live profile activation is deliberately unavailable until a provider owns provisioning and proof. */
export const ownedWorkflowExecutionLiveProfileEnabled = false;
