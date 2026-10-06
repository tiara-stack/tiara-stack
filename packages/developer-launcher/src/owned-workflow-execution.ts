import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";

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
  acceptedWorkSettled: Schema.Boolean,
  unknownOwnership: Schema.Boolean,
});
export type WorkflowExecutionCessationEvidence = typeof WorkflowExecutionCessationEvidence.Type;
export const workflowExecutionCleanupDisposition = (input: unknown) => {
  if (!Schema.is(WorkflowExecutionCessationEvidence)(input)) return "quarantined" as const;
  return input.providerOperationsTerminal &&
    input.apiFenced &&
    input.runnerPodsTerminated &&
    input.acceptedWorkSettled &&
    !input.unknownOwnership
    ? ("deletable" as const)
    : ("quarantined" as const);
};

/** Live profile activation is deliberately unavailable until a provider owns provisioning and proof. */
export const ownedWorkflowExecutionLiveProfileEnabled = false;
