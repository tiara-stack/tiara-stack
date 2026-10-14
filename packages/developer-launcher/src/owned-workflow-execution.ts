import { createHash } from "node:crypto";
import { Context, Effect, Exit, Layer, Match, Schema } from "effect";
import {
  WorkflowRecreationDiagnosticSchema,
  WorkflowTransitionPhaseFactsSchema,
  WorkflowTransitionReasonSchema,
  type WorkflowTransitionPhaseFacts,
} from "sheet-workflow-contracts";
import {
  runtimeContractCatalog,
  runtimeContractRolesForSelection,
  workflowPreviewRuntimeContractCatalogIdentity,
} from "./workflow-runtime-contract-catalog";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Identifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/));

/** Immutable identities supplied by the controller and shared by the API and its runners. */
export const WorkflowExecutionArtifacts = Schema.Struct({
  api: Digest,
  runner: Digest,
  /** Role-specific runner digests are required when an execution group contains both runners. */
  runnerArtifacts: Schema.optionalKey(Schema.Record(Schema.String, Digest)),
  contracts: Digest,
  deployment: Digest,
  workflowVersion: Schema.NonEmptyString,
  /** Complete action-name to immutable Action Version mapping for this sealed workflow. */
  actionVersions: Schema.Record(Schema.NonEmptyString, Schema.NonEmptyString),
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
  workloadOAuthClientIds: Schema.Record(Schema.String, Schema.NonEmptyString),
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

/** Non-secret identity that binds provider evidence to one immutable old execution group. */
export const WorkflowExecutionEvidenceBindingSchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sourceRevision: Schema.NonEmptyString,
  artifactsDigest: Digest,
  groupDigest: Digest,
  ownershipRecordIds: Schema.Struct({
    database: Identifier,
    applicationStore: Identifier,
    commandStore: Identifier,
    runStore: Identifier,
    clusterStore: Identifier,
  }),
});
export type WorkflowExecutionEvidenceBinding = typeof WorkflowExecutionEvidenceBindingSchema.Type;

export const workflowExecutionEvidenceBinding = (
  group: WorkflowExecutionGroup,
  sourceRevision: string,
): WorkflowExecutionEvidenceBinding =>
  Schema.decodeUnknownSync(WorkflowExecutionEvidenceBindingSchema)({
    sessionId: group.sessionId,
    generation: group.generation,
    sourceRevision,
    artifactsDigest: workflowExecutionGroupDigest(group.artifacts),
    // Hash only non-secret group identity. Ownership is bound through the durable record IDs and
    // generation; the owner token itself must never enter provider evidence, even as a digest.
    groupDigest: workflowExecutionGroupDigest({
      sessionId: group.sessionId,
      generation: group.generation,
      database: group.database,
      applicationStore: group.applicationStore,
      commandStore: group.commandStore,
      runStore: group.runStore,
      clusterStore: group.clusterStore,
      workloadOAuthClientIds: group.workloadOAuthClientIds,
      apiEndpoint: group.apiEndpoint,
      observationEndpoint: group.observationEndpoint,
      artifacts: group.artifacts,
    }),
    ownershipRecordIds: {
      database: group.database,
      applicationStore: group.applicationStore,
      commandStore: group.commandStore,
      runStore: group.runStore,
      clusterStore: group.clusterStore,
    },
  });

export const workflowExecutionEvidenceBindingMatches = (
  actual: unknown,
  expected: WorkflowExecutionEvidenceBinding,
): boolean =>
  Schema.is(WorkflowExecutionEvidenceBindingSchema)(actual) &&
  workflowExecutionGroupDigest(actual) === workflowExecutionGroupDigest(expected);

/** Compare exact role/group sets while rejecting duplicate declarations on either boundary. */
export const workflowStringSetsMatch = (
  expected: ReadonlyArray<string>,
  actual: ReadonlyArray<string>,
) => {
  if (
    expected.length !== actual.length ||
    new Set(expected).size !== expected.length ||
    new Set(actual).size !== actual.length
  )
    return false;
  const sortedExpected = [...expected].sort();
  const sortedActual = [...actual].sort();
  return sortedExpected.every((entry, index) => entry === sortedActual[index]);
};

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
  readonly workloadOAuthClientIds: Readonly<Record<string, string>>;
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
  {
    reason: Schema.String,
    oldCleanupRecordId: Schema.optionalKey(Schema.NonEmptyString),
    recovery: Schema.optionalKey(WorkflowRecreationDiagnosticSchema),
  },
) {}

/** Routine bounds from the preview contracts: provider calls, settlement, and group startup. */
export const workflowRecreationTimeouts = {
  providerOperation: "60 seconds",
  acceptedWorkDrain: "5 minutes",
  acceptedWorkFinalization: "5 minutes",
  freshGroupStartup: "120 seconds",
} as const;

export const withWorkflowRecreationTimeout = <A, E, E2, R>(
  effect: Effect.Effect<A, E, R>,
  duration: (typeof workflowRecreationTimeouts)[keyof typeof workflowRecreationTimeouts],
  onTimeout: () => E2,
): Effect.Effect<A, E | E2, R> =>
  Effect.timeoutOrElse(effect, {
    duration,
    orElse: () => Effect.fail(onTimeout()),
  });

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
export const workflowExecutionArtifactsEqual = (
  left: WorkflowExecutionArtifacts,
  right: WorkflowExecutionArtifacts,
) =>
  left.api === right.api &&
  left.runner === right.runner &&
  (left.runnerArtifacts === undefined
    ? right.runnerArtifacts === undefined
    : right.runnerArtifacts !== undefined &&
      workflowExecutionGroupDigest(left.runnerArtifacts) ===
        workflowExecutionGroupDigest(right.runnerArtifacts)) &&
  left.contracts === right.contracts &&
  left.deployment === right.deployment &&
  left.workflowVersion === right.workflowVersion &&
  workflowExecutionGroupDigest(left.actionVersions) ===
    workflowExecutionGroupDigest(right.actionVersions);
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
  left.workflowVersion === right.workflowVersion &&
  workflowExecutionGroupDigest(left.actionVersions) ===
    workflowExecutionGroupDigest(right.actionVersions);
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
    if (!workflowExecutionArtifactsEqual(runner.artifacts, ownedGroup.artifacts))
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
    if (
      workflowExecutionGroupDigest(previous.artifacts.actionVersions) !==
      workflowExecutionGroupDigest(replacement.artifacts.actionVersions)
    )
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

/** Cessation facts must name the exact old session, source and ownership records they prove. */
export const WorkflowExecutionCessationEvidence = Schema.Struct({
  binding: WorkflowExecutionEvidenceBindingSchema,
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

/** Old-code provider facts bind to the exact immutable group and source revision. */
export const WorkflowOldWorkSettlementEvidenceSchema = Schema.Struct({
  binding: WorkflowExecutionEvidenceBindingSchema,
  disposition: Schema.Literals(["settled", "ambiguous"]),
  drain: Schema.Literals(["completed", "not-required", "ambiguous", "unconfirmed"]),
  cancellation: Schema.Literals(["completed", "not-required", "ambiguous", "unconfirmed"]),
  reconciliation: Schema.Literals(["completed", "not-required", "ambiguous", "unconfirmed"]),
});
export type WorkflowOldWorkSettlementEvidence = typeof WorkflowOldWorkSettlementEvidenceSchema.Type;

/** The first settlement window only drains accepted work with its immutable old executor. */
export const WorkflowOldWorkDrainEvidenceSchema = Schema.Struct({
  binding: WorkflowExecutionEvidenceBindingSchema,
  drain: Schema.Literals(["completed", "not-required", "ambiguous", "unconfirmed"]),
});
export type WorkflowOldWorkDrainEvidence = typeof WorkflowOldWorkDrainEvidenceSchema.Type;

/** Confirmed producer ownership fences, distinct from pausing new admission. */
export const WorkflowProducerFenceEvidenceSchema = Schema.Struct({
  binding: WorkflowExecutionEvidenceBindingSchema,
  submissionConnectionsFenced: Schema.Boolean,
  autonomousTriggersFenced: Schema.Boolean,
  unknownProducerOwnership: Schema.Boolean,
});
export type WorkflowProducerFenceEvidence = typeof WorkflowProducerFenceEvidenceSchema.Type;
export const workflowExecutionCleanupDisposition = (
  input: unknown,
  expectedBinding: WorkflowExecutionEvidenceBinding,
) => {
  if (
    !Schema.is(WorkflowExecutionCessationEvidence)(input) ||
    !workflowExecutionEvidenceBindingMatches(input.binding, expectedBinding)
  )
    return "quarantined" as const;
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
  sourceRevision: Schema.NonEmptyString,
  artifacts: WorkflowExecutionArtifacts,
  requiredGroups: Schema.Array(Schema.NonEmptyString),
  workloadRoles: Schema.Array(Schema.NonEmptyString),
  compatibility: Schema.Struct({
    catalogVersion: Schema.Int.check(Schema.isGreaterThan(0)),
    catalogDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
    declarations: Schema.Array(
      Schema.Struct({
        role: Schema.NonEmptyString,
        contract: Schema.NullOr(Schema.NonEmptyString),
        classification: Schema.Literals([
          "implementation-only",
          "compatible",
          "incompatible",
          "unknown",
        ]),
        sourceRevision: Schema.NonEmptyString,
        artifactDigest: Schema.String.check(Schema.isPattern(/^(?:sha256:)?[a-f0-9]{64}$/)),
        deployedManifestDigest: Schema.String.check(Schema.isPattern(/^(?:sha256:)?[a-f0-9]{64}$/)),
        catalogVersion: Schema.Int.check(Schema.isGreaterThan(0)),
      }),
    ),
  }),
});
export type WorkflowPreviewDefinition = typeof WorkflowPreviewDefinition.Type;

export const WorkflowPreviewTransition = Schema.Struct({
  classification: Schema.Literals(["compatible", "incompatible", "unverified"]),
  reasons: Schema.Array(WorkflowTransitionReasonSchema),
  previousDefinition: WorkflowPreviewDefinition,
  proposedDefinition: WorkflowPreviewDefinition,
});
export type WorkflowPreviewTransition = typeof WorkflowPreviewTransition.Type;

type WorkflowPreviewDefinitionType = typeof WorkflowPreviewDefinition.Type;
type WorkflowCompatibilityDeclaration =
  WorkflowPreviewDefinitionType["compatibility"]["declarations"][number];

export const workflowRoleBindings = {
  workflow_api: {
    connectedRole: "sheet-workflows-api",
    runnerRole: "workflow-api",
  },
  ordinary_runner: {
    connectedRole: "sheet-workflows-runner",
    runnerRole: "ordinary-runner",
  },
  browser_runner: {
    connectedRole: "sheet-workflows-browser-runner",
    runnerRole: "browser-runner",
  },
} as const;

export const workflowRoleBinding = (role: string) =>
  Object.hasOwn(workflowRoleBindings, role)
    ? workflowRoleBindings[role as keyof typeof workflowRoleBindings]
    : undefined;

export const workflowRoleForConnectedRole = (connectedRole: string) =>
  Object.entries(workflowRoleBindings).find(
    ([, binding]) => binding.connectedRole === connectedRole,
  )?.[0];

export const primaryWorkflowRunnerRole = (
  roles: ReadonlyArray<"ordinary_runner" | "browser_runner">,
) => (roles.includes("ordinary_runner") ? "ordinary_runner" : "browser_runner");

const runnerArtifactDigestForRole = (
  role: "ordinary_runner" | "browser_runner",
  artifacts: WorkflowExecutionArtifacts,
) =>
  artifacts.runnerArtifacts?.[role] ??
  (artifacts.runnerArtifacts === undefined ? artifacts.runner : undefined);

const artifactDigestForRole = (role: string, artifacts: WorkflowExecutionArtifacts) => {
  const workflowRole = workflowRoleBinding(role) ? role : workflowRoleForConnectedRole(role);
  if (workflowRole === "workflow_api") return artifacts.api;
  if (workflowRole === "ordinary_runner" || workflowRole === "browser_runner")
    return runnerArtifactDigestForRole(workflowRole, artifacts);
  return undefined;
};

const workflowDeclarationHasBoundIdentity = (
  definition: WorkflowPreviewDefinition,
  declaration: WorkflowCompatibilityDeclaration,
) =>
  Object.hasOwn(runtimeContractCatalog.roles, declaration.role) &&
  declaration.sourceRevision === definition.sourceRevision &&
  declaration.deployedManifestDigest.replace(/^sha256:/, "") === definition.artifacts.deployment &&
  declaration.catalogVersion === definition.compatibility.catalogVersion;

const workflowDeclarationHasKnownClassification = (
  declaration: WorkflowCompatibilityDeclaration,
) => {
  if (declaration.classification === "unknown") return false;
  if (declaration.contract === null) return declaration.classification === "implementation-only";
  return (
    declaration.classification !== "implementation-only" &&
    Object.hasOwn(runtimeContractCatalog.contracts, declaration.contract)
  );
};

const workflowDeclarationArtifactIsBound = (
  definition: WorkflowPreviewDefinition,
  declaration: WorkflowCompatibilityDeclaration,
) => {
  const workflowRole = workflowRoleBinding(declaration.role)
    ? declaration.role
    : workflowRoleForConnectedRole(declaration.role);
  if (workflowRole === undefined) return true;
  const expectedArtifactDigest = artifactDigestForRole(workflowRole, definition.artifacts);
  return (
    expectedArtifactDigest !== undefined &&
    declaration.artifactDigest.replace(/^sha256:/, "") === expectedArtifactDigest
  );
};

const workflowCompatibilityDeclarationIsBound = (
  definition: WorkflowPreviewDefinition,
  declaration: WorkflowCompatibilityDeclaration,
) =>
  workflowDeclarationHasBoundIdentity(definition, declaration) &&
  workflowDeclarationHasKnownClassification(declaration) &&
  workflowDeclarationArtifactIsBound(definition, declaration);

const workflowCompatibilityDeclarationsAreUnique = (
  declarations: ReadonlyArray<WorkflowCompatibilityDeclaration>,
) => {
  const keys = declarations.map(({ role, contract }) => JSON.stringify([role, contract]));
  return new Set(keys).size === keys.length;
};

const workflowRolesAreSupportedAndUnique = (definition: WorkflowPreviewDefinition) => {
  return (
    definition.workloadRoles.length > 0 &&
    new Set(definition.workloadRoles).size === definition.workloadRoles.length &&
    definition.workloadRoles.every((role) => workflowRoleBinding(role) !== undefined)
  );
};

export const workflowRunnerArtifactRolesMatch = (
  selectedRunnerRoles: ReadonlyArray<"ordinary_runner" | "browser_runner">,
  runnerArtifacts: Readonly<Record<string, string>> | undefined,
) => {
  const expectedRunnerRoles = [...selectedRunnerRoles].sort();
  const proposedRunnerRoles = Object.keys(runnerArtifacts ?? {}).sort();
  return runnerArtifacts === undefined
    ? expectedRunnerRoles.length <= 1
    : proposedRunnerRoles.length === expectedRunnerRoles.length &&
        expectedRunnerRoles.every((role, index) => role === proposedRunnerRoles[index]);
};

const proposedRunnerArtifactsCoverRoles = (definition: WorkflowPreviewDefinition) => {
  const selectedRunnerRoles = definition.workloadRoles.filter(
    (role): role is "ordinary_runner" | "browser_runner" =>
      role === "ordinary_runner" || role === "browser_runner",
  );
  const runnerArtifacts = definition.artifacts.runnerArtifacts;
  const primaryRunnerRole = primaryWorkflowRunnerRole(selectedRunnerRoles);
  const primaryRunnerDigestMatches =
    runnerArtifacts === undefined ||
    selectedRunnerRoles.length === 0 ||
    definition.artifacts.runner === runnerArtifacts[primaryRunnerRole];

  return (
    workflowRunnerArtifactRolesMatch(selectedRunnerRoles, runnerArtifacts) &&
    primaryRunnerDigestMatches
  );
};

const workflowRolesHaveCompatibilityDeclarations = (definition: WorkflowPreviewDefinition) =>
  definition.workloadRoles.every((role) => {
    const connectedRole = workflowRoleBinding(role)?.connectedRole;
    return (
      connectedRole !== undefined &&
      definition.compatibility.declarations.some(
        (declaration) => declaration.role === connectedRole,
      )
    );
  });

const incompatibleDeclarationClosureIsIncluded = (definition: WorkflowPreviewDefinition) => {
  const requiredGroups = new Set<string>();
  const requiredWorkflowRoles = new Set<string>();
  const selectedConnectedRoles = definition.workloadRoles.flatMap((role) => {
    const binding = workflowRoleBinding(role);
    return binding === undefined ? [] : [binding.connectedRole];
  });
  for (const declaration of definition.compatibility.declarations) {
    if (declaration.classification !== "incompatible" || declaration.contract === null) continue;
    const contract =
      runtimeContractCatalog.contracts[
        declaration.contract as keyof typeof runtimeContractCatalog.contracts
      ];
    for (const group of contract.requiredOwnedGroups) requiredGroups.add(group);
    for (const role of runtimeContractRolesForSelection(contract, selectedConnectedRoles)) {
      const workflowRole = workflowRoleForConnectedRole(role);
      if (workflowRole !== undefined) requiredWorkflowRoles.add(workflowRole);
    }
  }
  return (
    [...requiredGroups].every((group) => definition.requiredGroups.includes(group)) &&
    [...requiredWorkflowRoles].every((role) => definition.workloadRoles.includes(role))
  );
};

const workflowCompatibilityEvidenceIsBound = (definition: WorkflowPreviewDefinition) =>
  definition.compatibility.catalogVersion ===
    workflowPreviewRuntimeContractCatalogIdentity.version &&
  definition.compatibility.catalogDigest === workflowPreviewRuntimeContractCatalogIdentity.digest &&
  definition.compatibility.declarations.length > 0 &&
  workflowRolesAreSupportedAndUnique(definition) &&
  proposedRunnerArtifactsCoverRoles(definition) &&
  workflowCompatibilityDeclarationsAreUnique(definition.compatibility.declarations) &&
  workflowRolesHaveCompatibilityDeclarations(definition) &&
  definition.compatibility.declarations.every((declaration) =>
    workflowCompatibilityDeclarationIsBound(definition, declaration),
  ) &&
  incompatibleDeclarationClosureIsIncluded(definition);

/** Only contract, durable-format, action-version and group changes require recreation. */
export const classifyWorkflowPreviewTransition = (
  previous: WorkflowPreviewDefinition,
  proposed: WorkflowPreviewDefinition,
): WorkflowPreviewTransition => {
  const reasons: Array<WorkflowPreviewTransition["reasons"][number]> = [];
  if (
    !workflowCompatibilityEvidenceIsBound(previous) ||
    !workflowCompatibilityEvidenceIsBound(proposed) ||
    previous.compatibility.catalogVersion !== proposed.compatibility.catalogVersion ||
    previous.compatibility.catalogDigest !== proposed.compatibility.catalogDigest
  )
    reasons.push("compatibility-evidence-unverified");
  else if (
    proposed.compatibility.declarations.some(
      ({ classification }) => classification === "incompatible",
    )
  )
    reasons.push("declared-contract-incompatible");
  if (previous.artifacts.contracts !== proposed.artifacts.contracts)
    reasons.push("workflow-contracts-changed");
  if (previous.artifacts.deployment !== proposed.artifacts.deployment)
    reasons.push("durable-deployment-changed");
  if (previous.artifacts.workflowVersion !== proposed.artifacts.workflowVersion)
    reasons.push("action-version-changed");
  if (
    workflowExecutionGroupDigest(previous.artifacts.actionVersions) !==
      workflowExecutionGroupDigest(proposed.artifacts.actionVersions) &&
    !reasons.includes("action-version-changed")
  )
    reasons.push("action-version-changed");
  if (proposed.requiredGroups.some((group) => !previous.requiredGroups.includes(group)))
    reasons.push("workflow-group-added");
  if (previous.requiredGroups.some((group) => !proposed.requiredGroups.includes(group)))
    reasons.push("workflow-group-removed");
  if (proposed.workloadRoles.some((role) => !previous.workloadRoles.includes(role)))
    reasons.push("workflow-role-added");
  if (previous.workloadRoles.some((role) => !proposed.workloadRoles.includes(role)))
    reasons.push("workflow-role-removed");
  let classification: WorkflowPreviewTransition["classification"];
  if (reasons.includes("compatibility-evidence-unverified")) classification = "unverified";
  else if (reasons.length === 0) classification = "compatible";
  else classification = "incompatible";

  return {
    classification,
    reasons,
    previousDefinition: previous,
    proposedDefinition: proposed,
  };
};

export const WorkflowFreshGroupEvidence = Schema.Struct({
  group: WorkflowExecutionGroup,
  requiredGroups: Schema.Array(Schema.NonEmptyString),
  workloadOAuthClientIds: Schema.Record(Schema.String, Schema.NonEmptyString),
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
      readonly phases: WorkflowTransitionPhaseFacts;
      readonly oldCleanupRecordId: string;
      readonly fresh: WorkflowFreshGroupEvidence;
    }
  | {
      readonly _tag: "Rejected";
      readonly transition: WorkflowPreviewTransition;
      readonly phases: WorkflowTransitionPhaseFacts;
      readonly reason: string;
    }
  | {
      readonly _tag: "Quarantined";
      readonly transition: WorkflowPreviewTransition;
      readonly phases: WorkflowTransitionPhaseFacts;
      readonly reason: string;
      readonly oldCleanupRecordId?: string;
      readonly recovery?: typeof WorkflowRecreationDiagnosticSchema.Type;
    }
  | {
      readonly _tag: "QuarantineUnconfirmed";
      readonly transition: WorkflowPreviewTransition;
      readonly phases: WorkflowTransitionPhaseFacts;
      readonly reason: string;
      readonly quarantineReason: string;
      readonly ordinaryReassignmentBlocked: boolean | null;
      readonly oldCleanupRecordId?: string;
      readonly recovery?: typeof WorkflowRecreationDiagnosticSchema.Type;
    };

type WorkflowQuarantineResult = Extract<
  WorkflowRecreationResult,
  { readonly _tag: "Quarantined" | "QuarantineUnconfirmed" }
>;

type FreshGroupQuarantineCandidate = {
  readonly freshSessionId: string;
  readonly freshOwnerToken: string;
  readonly freshGeneration: number;
  readonly priorCleanupRecordId: string;
};

const freshGroupQuarantineCandidates = new WeakMap<
  WorkflowExecutionError,
  FreshGroupQuarantineCandidate
>();

const invalidFreshGroupEvidence = (candidate?: FreshGroupQuarantineCandidate) => {
  const error = recreationFailure("fresh-group-evidence-invalid");
  if (candidate !== undefined) freshGroupQuarantineCandidates.set(error, candidate);
  return error;
};

export interface IncompatibleWorkflowRecreationRuntimeApi {
  readonly presentProposal: (
    transition: WorkflowPreviewTransition,
  ) => Effect.Effect<void, WorkflowExecutionError>;
  readonly pauseAdmission: (
    oldGroup: WorkflowExecutionGroup,
  ) => Effect.Effect<void, WorkflowExecutionError>;
  /** Fence existing producer channels and triggers before old-code settlement. */
  readonly fenceProducers: (input: {
    readonly oldGroup: WorkflowExecutionGroup;
    readonly sourceRevision: string;
    readonly expectedBinding: WorkflowExecutionEvidenceBinding;
  }) => Effect.Effect<unknown, WorkflowExecutionError>;
  /** Drain accepted work only within the first settlement window. */
  readonly drainOldWork: (input: {
    readonly oldGroup: WorkflowExecutionGroup;
    readonly oldArtifacts: WorkflowExecutionArtifacts;
    readonly sourceRevision: string;
    readonly expectedBinding: WorkflowExecutionEvidenceBinding;
  }) => Effect.Effect<unknown, WorkflowExecutionError>;
  /** The executor and dependency identities come from the immutable old group. */
  readonly settleWithOldCode: (input: {
    readonly oldGroup: WorkflowExecutionGroup;
    readonly oldArtifacts: WorkflowExecutionArtifacts;
    readonly sourceRevision: string;
    readonly expectedBinding: WorkflowExecutionEvidenceBinding;
    readonly drain: WorkflowOldWorkDrainEvidence;
    readonly strategy: "cancel-reconcile";
  }) => Effect.Effect<unknown, WorkflowExecutionError>;
  readonly proveOldCessation: (input: {
    readonly oldGroup: WorkflowExecutionGroup;
    readonly sourceRevision: string;
    readonly expectedBinding: WorkflowExecutionEvidenceBinding;
  }) => Effect.Effect<unknown, WorkflowExecutionError>;
  /** This ends the old session and returns its exact durable cleanup record. */
  readonly endOldSessionAndCleanup: (
    oldGroup: WorkflowExecutionGroup,
    onCleanupRecordConfirmed?: (cleanupRecordId: string) => void,
  ) => Effect.Effect<string, WorkflowExecutionError>;
  /** Provider must provision an empty group and retain the cleanup record link. */
  readonly provisionFreshGroup: (input: {
    readonly oldGroup: WorkflowExecutionGroup;
    readonly artifacts: WorkflowExecutionArtifacts;
    readonly requiredGroups: ReadonlyArray<string>;
    readonly priorCleanupRecordId: string;
    readonly transferPendingWork: false;
    readonly freshSession?: {
      readonly sessionId: string;
      readonly ownerToken: string;
      readonly generation: number;
    };
  }) => Effect.Effect<unknown, WorkflowExecutionError>;
  readonly quarantine: (
    oldGroup: WorkflowExecutionGroup,
    reason: string,
  ) => Effect.Effect<void, WorkflowExecutionError>;
  /** Independent fail-closed fence used if durable quarantine recording fails. */
  readonly blockOrdinaryReassignment: (
    oldGroup: WorkflowExecutionGroup,
    reason: string,
  ) => Effect.Effect<boolean, WorkflowExecutionError>;
  readonly quarantineFreshGroup?: (input: {
    readonly freshSessionId: string;
    readonly freshOwnerToken?: string;
    readonly freshGeneration: number;
    readonly priorCleanupRecordId: string;
    readonly reason: string;
  }) => Effect.Effect<void, WorkflowExecutionError>;
  readonly persistRecoveryDisposition?: (
    diagnostic: typeof WorkflowRecreationDiagnosticSchema.Type,
  ) => Effect.Effect<boolean, WorkflowExecutionError>;
}

export class IncompatibleWorkflowRecreationRuntime extends Context.Service<
  IncompatibleWorkflowRecreationRuntime,
  IncompatibleWorkflowRecreationRuntimeApi
>()("developer-launcher/IncompatibleWorkflowRecreationRuntime") {}

export const IncompatibleWorkflowRecreationRuntimeLayer = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
) => Layer.succeed(IncompatibleWorkflowRecreationRuntime, runtime);

const withRecoveryDisposition = (
  recovery: typeof WorkflowRecreationDiagnosticSchema.Type | undefined,
  quarantineDisposition: "quarantined" | "ordinary-reassignment-blocked" | "unconfirmed",
  ordinaryReassignmentBlocked: boolean | null,
) => {
  if (recovery === undefined) return {};
  if (recovery.recovery === undefined) return { recovery };
  return {
    recovery: {
      ...recovery,
      recovery: { ...recovery.recovery, quarantineDisposition, ordinaryReassignmentBlocked },
    },
  };
};

export const emptyWorkflowTransitionPhases = (): WorkflowTransitionPhaseFacts =>
  Schema.decodeUnknownSync(WorkflowTransitionPhaseFactsSchema)({
    proposal: "not-started",
    admission: "not-started",
    producerFencing: "not-started",
    drain: "not-started",
    cancellation: "not-started",
    reconciliation: "not-started",
    settlement: "not-started",
    cessation: "not-started",
    oldSessionEnd: "not-started",
    cleanup: "not-started",
    freshGroup: "not-started",
    activation: "not-started",
    quarantine: "not-started",
    ordinaryReassignment: "not-started",
  });

type WorkflowTransitionPhaseState = {
  current: WorkflowTransitionPhaseFacts;
  oldCleanupRecordId?: string;
};
const setWorkflowTransitionPhase = <K extends keyof WorkflowTransitionPhaseFacts>(
  state: WorkflowTransitionPhaseState,
  key: K,
  value: WorkflowTransitionPhaseFacts[K],
) => {
  state.current = { ...state.current, [key]: value };
};

type WorkflowTransitionElapsedPhase =
  | "drainElapsedMs"
  | "cancellationReconciliationElapsedMs"
  | "cessationProofElapsedMs"
  | "settlementElapsedMs"
  | "acceptedWorkElapsedMs";

const elapsedMilliseconds = (start: bigint, end: bigint) =>
  Math.max(0, Number((end - start) / 1_000_000n));

const recordWorkflowTransitionElapsed = (
  phases: WorkflowTransitionPhaseState,
  key: WorkflowTransitionElapsedPhase,
  start: bigint,
) =>
  Effect.clockWith((clock) => clock.currentTimeNanos).pipe(
    Effect.flatMap((end) =>
      Effect.sync(() => setWorkflowTransitionPhase(phases, key, elapsedMilliseconds(start, end))),
    ),
  );

type FreshGroupQuarantineDisposition = "not-applicable" | "quarantined" | "unconfirmed";

const quarantineFreshGroupCandidate = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  recovery: typeof WorkflowRecreationDiagnosticSchema.Type | undefined,
  candidate: FreshGroupQuarantineCandidate | undefined,
  freshGroupAttempted: boolean,
): Effect.Effect<FreshGroupQuarantineDisposition> => {
  const recordedDisposition = recovery?.recovery?.freshGroupQuarantineDisposition;
  if (recordedDisposition !== undefined) return Effect.succeed(recordedDisposition);
  if (candidate === undefined)
    return Effect.succeed(freshGroupAttempted ? "unconfirmed" : "not-applicable");
  if (runtime.quarantineFreshGroup === undefined) return Effect.succeed("unconfirmed");
  return Effect.exit(
    withWorkflowRecreationTimeout(
      runtime.quarantineFreshGroup({ ...candidate, reason: "fresh-group-evidence-invalid" }),
      workflowRecreationTimeouts.providerOperation,
      () => recreationFailure("fresh-group-quarantine-unconfirmed"),
    ),
  ).pipe(Effect.map((exit) => (Exit.isSuccess(exit) ? "quarantined" : "unconfirmed")));
};

const quarantineOldWorkflowGroup = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  transition: WorkflowPreviewTransition,
  phases: WorkflowTransitionPhaseFacts,
  reason: string,
  recovery: typeof WorkflowRecreationDiagnosticSchema.Type | undefined,
  oldCleanupRecordId: string | undefined,
  freshDisposition: FreshGroupQuarantineDisposition,
): Effect.Effect<WorkflowQuarantineResult> => {
  const updatedRecovery = (updatedPhases: WorkflowTransitionPhaseFacts) =>
    recovery === undefined ? undefined : { ...recovery, phases: updatedPhases };
  const freshQuarantineUnconfirmed = freshDisposition === "unconfirmed";
  return Effect.matchEffect(
    withWorkflowRecreationTimeout(
      runtime.quarantine(oldGroup, reason),
      workflowRecreationTimeouts.providerOperation,
      () => recreationFailure("old-quarantine-unconfirmed"),
    ),
    {
      onSuccess: (): Effect.Effect<WorkflowQuarantineResult> => {
        const updatedPhases: WorkflowTransitionPhaseFacts = {
          ...phases,
          quarantine: freshQuarantineUnconfirmed ? "unconfirmed" : "confirmed",
        };
        if (freshQuarantineUnconfirmed)
          return Effect.succeed({
            _tag: "QuarantineUnconfirmed" as const,
            transition,
            phases: updatedPhases,
            reason,
            quarantineReason: "fresh-group-quarantine-unconfirmed",
            ordinaryReassignmentBlocked: null,
            ...(oldCleanupRecordId === undefined ? {} : { oldCleanupRecordId }),
            ...withRecoveryDisposition(updatedRecovery(updatedPhases), "unconfirmed", null),
          });
        return Effect.succeed({
          _tag: "Quarantined" as const,
          transition,
          phases: updatedPhases,
          reason,
          ...(oldCleanupRecordId === undefined ? {} : { oldCleanupRecordId }),
          ...withRecoveryDisposition(updatedRecovery(updatedPhases), "quarantined", null),
        });
      },
      onFailure: (): Effect.Effect<WorkflowQuarantineResult> =>
        Effect.matchEffect(
          withWorkflowRecreationTimeout(
            runtime.blockOrdinaryReassignment(oldGroup, reason),
            workflowRecreationTimeouts.providerOperation,
            () => recreationFailure("ordinary-reassignment-fence-unconfirmed"),
          ),
          {
            onSuccess: (ordinaryReassignmentBlocked) => {
              const updatedPhases: WorkflowTransitionPhaseFacts = {
                ...phases,
                quarantine: "unconfirmed",
                ordinaryReassignment: ordinaryReassignmentBlocked ? "blocked" : "not-blocked",
              };
              return Effect.succeed({
                _tag: "QuarantineUnconfirmed" as const,
                transition,
                phases: updatedPhases,
                reason,
                quarantineReason: "quarantine-write-unconfirmed",
                ordinaryReassignmentBlocked,
                ...(oldCleanupRecordId === undefined ? {} : { oldCleanupRecordId }),
                ...withRecoveryDisposition(
                  updatedRecovery(updatedPhases),
                  ordinaryReassignmentBlocked ? "ordinary-reassignment-blocked" : "unconfirmed",
                  ordinaryReassignmentBlocked,
                ),
              });
            },
            onFailure: () => {
              const updatedPhases: WorkflowTransitionPhaseFacts = {
                ...phases,
                quarantine: "unconfirmed",
                ordinaryReassignment: "unconfirmed",
              };
              return Effect.succeed({
                _tag: "QuarantineUnconfirmed" as const,
                transition,
                phases: updatedPhases,
                reason,
                quarantineReason: "quarantine-and-reassignment-fence-unconfirmed",
                ordinaryReassignmentBlocked: null,
                ...(oldCleanupRecordId === undefined ? {} : { oldCleanupRecordId }),
                ...withRecoveryDisposition(updatedRecovery(updatedPhases), "unconfirmed", null),
              });
            },
          },
        ),
    },
  );
};

const persistWorkflowRecreationDisposition = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  result: WorkflowQuarantineResult,
): Effect.Effect<WorkflowQuarantineResult> => {
  const recovery = result.recovery;
  if (recovery?.recovery === undefined || runtime.persistRecoveryDisposition === undefined)
    return Effect.succeed(result);
  return Effect.exit(
    withWorkflowRecreationTimeout(
      runtime.persistRecoveryDisposition(recovery),
      workflowRecreationTimeouts.providerOperation,
      () => recreationFailure("recovery-disposition-persistence-unconfirmed"),
    ),
  ).pipe(
    Effect.map((persisted): WorkflowQuarantineResult => {
      const updatedRecovery = Schema.decodeUnknownSync(WorkflowRecreationDiagnosticSchema)({
        ...recovery,
        recovery: {
          ...recovery.recovery,
          recoveryRecordUpdated: Exit.isSuccess(persisted) && persisted.value,
        },
      });
      return { ...result, recovery: updatedRecovery };
    }),
  );
};

const quarantineWorkflowRecreation = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  transition: WorkflowPreviewTransition,
  phases: WorkflowTransitionPhaseFacts,
  reason: string,
  recovery?: typeof WorkflowRecreationDiagnosticSchema.Type,
  oldCleanupRecordId?: string,
  freshGroupCandidate?: FreshGroupQuarantineCandidate,
): Effect.Effect<WorkflowQuarantineResult> =>
  quarantineFreshGroupCandidate(
    runtime,
    recovery,
    freshGroupCandidate,
    phases.freshGroup !== "not-started",
  ).pipe(
    Effect.flatMap((freshDisposition) =>
      quarantineOldWorkflowGroup(
        runtime,
        oldGroup,
        transition,
        phases,
        reason,
        recovery,
        oldCleanupRecordId,
        freshDisposition,
      ),
    ),
    Effect.flatMap((result) => persistWorkflowRecreationDisposition(runtime, result)),
  );

/** Automatic watch may report a proposal but cannot activate an incompatible definition. */
export const requireAutomaticWorkflowCompatibility = (transition: WorkflowPreviewTransition) =>
  transition.classification === "compatible"
    ? Effect.void
    : reject("incompatible-workflow-transition-requires-explicit-recreation");

const recreationFailure = (reason: string, oldCleanupRecordId?: string) =>
  new WorkflowExecutionError({
    reason,
    ...(oldCleanupRecordId === undefined ? {} : { oldCleanupRecordId }),
  });

type WorkflowRecreationInput = {
  readonly oldGroup: WorkflowExecutionGroup;
  readonly previous: WorkflowPreviewDefinition;
  readonly proposed: WorkflowPreviewDefinition;
  readonly explicitlyRequested: boolean;
};

type WorkflowRecreationPreflight = {
  readonly transition: WorkflowPreviewTransition;
  readonly rejectedReason: string | undefined;
};

const workflowRecreationPreflight = (
  input: WorkflowRecreationInput,
): WorkflowRecreationPreflight => {
  const transition = classifyWorkflowPreviewTransition(input.previous, input.proposed);
  const oldRoleIdentities = Object.keys(input.oldGroup.workloadOAuthClientIds);
  if (transition.classification === "unverified")
    return { transition, rejectedReason: "workflow-transition-compatibility-evidence-unverified" };
  if (!workflowExecutionArtifactsEqual(input.oldGroup.artifacts, input.previous.artifacts))
    return { transition, rejectedReason: "workflow-old-group-artifact-mismatch" };
  if (!workflowStringSetsMatch(input.previous.workloadRoles, oldRoleIdentities))
    return { transition, rejectedReason: "workflow-old-group-role-identity-mismatch" };
  if (transition.classification === "compatible")
    return { transition, rejectedReason: "transition-is-compatible" };
  if (!input.explicitlyRequested)
    return { transition, rejectedReason: "explicit-recreation-required" };
  return { transition, rejectedReason: undefined };
};

const recreationStep = <A>(
  step: Effect.Effect<A, WorkflowExecutionError>,
  reason: string,
  preserveReason?: string,
  duration: (typeof workflowRecreationTimeouts)[keyof typeof workflowRecreationTimeouts] = workflowRecreationTimeouts.providerOperation,
  onTimeout?: () => WorkflowExecutionError,
): Effect.Effect<A, WorkflowExecutionError> =>
  withWorkflowRecreationTimeout(
    step,
    duration,
    onTimeout ?? (() => recreationFailure(reason)),
  ).pipe(
    Effect.mapError((error) =>
      error.reason === preserveReason || error.oldCleanupRecordId !== undefined
        ? error
        : recreationFailure(reason),
    ),
  );

const prepareOldWorkflowForSettlement = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  transition: WorkflowPreviewTransition,
  phases: WorkflowTransitionPhaseState,
  expectedBinding: WorkflowExecutionEvidenceBinding,
) =>
  Effect.gen(function* () {
    yield* recreationStep(runtime.presentProposal(transition), "proposal-not-presented").pipe(
      Effect.tap(() =>
        Effect.sync(() => setWorkflowTransitionPhase(phases, "proposal", "presented")),
      ),
      Effect.tapError(() =>
        Effect.sync(() => setWorkflowTransitionPhase(phases, "proposal", "unconfirmed")),
      ),
    );
    yield* recreationStep(runtime.pauseAdmission(oldGroup), "admission-pause-unconfirmed").pipe(
      Effect.tap(() =>
        Effect.sync(() => setWorkflowTransitionPhase(phases, "admission", "paused")),
      ),
      Effect.tapError(() =>
        Effect.sync(() => setWorkflowTransitionPhase(phases, "admission", "unconfirmed")),
      ),
    );
    const producerFence = yield* recreationStep(
      runtime.fenceProducers({
        oldGroup,
        sourceRevision: transition.previousDefinition.sourceRevision,
        expectedBinding,
      }),
      "producer-fencing-unconfirmed",
    ).pipe(
      Effect.flatMap((evidence) =>
        Schema.decodeUnknownEffect(WorkflowProducerFenceEvidenceSchema)(evidence).pipe(
          Effect.mapError(() => recreationFailure("producer-fence-evidence-invalid")),
          Effect.flatMap((decoded) =>
            workflowExecutionEvidenceBindingMatches(decoded.binding, expectedBinding)
              ? Effect.succeed(decoded)
              : Effect.fail(recreationFailure("producer-fence-evidence-invalid")),
          ),
        ),
      ),
      Effect.tap((evidence) =>
        Effect.sync(() =>
          setWorkflowTransitionPhase(
            phases,
            "producerFencing",
            evidence.submissionConnectionsFenced &&
              evidence.autonomousTriggersFenced &&
              !evidence.unknownProducerOwnership
              ? "fenced"
              : "unconfirmed",
          ),
        ),
      ),
      Effect.tapError(() =>
        Effect.sync(() => setWorkflowTransitionPhase(phases, "producerFencing", "unconfirmed")),
      ),
    );
    if (
      !producerFence.submissionConnectionsFenced ||
      !producerFence.autonomousTriggersFenced ||
      producerFence.unknownProducerOwnership
    )
      return yield* reject("producer-fencing-unconfirmed");
    const drainStartedAt = yield* Effect.clockWith((clock) => clock.currentTimeNanos);
    const drain = yield* recreationStep(
      runtime.drainOldWork({
        oldGroup,
        oldArtifacts: oldGroup.artifacts,
        sourceRevision: transition.previousDefinition.sourceRevision,
        expectedBinding,
      }),
      "old-work-drain-unconfirmed",
      undefined,
      workflowRecreationTimeouts.acceptedWorkDrain,
    ).pipe(
      Effect.flatMap((evidence) =>
        Schema.decodeUnknownEffect(WorkflowOldWorkDrainEvidenceSchema)(evidence).pipe(
          Effect.mapError(() => recreationFailure("old-work-drain-evidence-invalid")),
          Effect.flatMap((decoded) =>
            workflowExecutionEvidenceBindingMatches(decoded.binding, expectedBinding)
              ? Effect.succeed(decoded)
              : Effect.fail(recreationFailure("old-work-drain-evidence-invalid")),
          ),
        ),
      ),
      Effect.tap((evidence) =>
        Effect.sync(() => setWorkflowTransitionPhase(phases, "drain", evidence.drain)).pipe(
          Effect.andThen(recordWorkflowTransitionElapsed(phases, "drainElapsedMs", drainStartedAt)),
          Effect.andThen(
            recordWorkflowTransitionElapsed(phases, "acceptedWorkElapsedMs", drainStartedAt),
          ),
        ),
      ),
      Effect.tapError(() =>
        Effect.sync(() => setWorkflowTransitionPhase(phases, "drain", "unconfirmed")).pipe(
          Effect.andThen(recordWorkflowTransitionElapsed(phases, "drainElapsedMs", drainStartedAt)),
          Effect.andThen(
            recordWorkflowTransitionElapsed(phases, "acceptedWorkElapsedMs", drainStartedAt),
          ),
        ),
      ),
    );
    if (drain.drain !== "completed" && drain.drain !== "not-required") {
      yield* recordWorkflowTransitionElapsed(phases, "acceptedWorkElapsedMs", drainStartedAt);
      setWorkflowTransitionPhase(
        phases,
        "settlement",
        drain.drain === "ambiguous" ? "ambiguous" : "unconfirmed",
      );
      return yield* reject("old-work-settlement-ambiguous");
    }

    return { drain, drainStartedAt };
  });

const finalizeOldWorkflowSettlement = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  transition: WorkflowPreviewTransition,
  phases: WorkflowTransitionPhaseState,
  expectedBinding: WorkflowExecutionEvidenceBinding,
  drain: WorkflowOldWorkDrainEvidence,
  drainStartedAt: bigint,
) =>
  Effect.gen(function* () {
    // The second five-minute window covers cancellation, reconciliation and cessation proof
    // together. If it expires, unfinished external facts remain unconfirmed; timeout is not proof
    // that provider work stopped.
    let cessationProofStarted = false;
    const finalizationStartedAt = yield* Effect.clockWith((clock) => clock.currentTimeNanos);
    const finalization = yield* withWorkflowRecreationTimeout(
      Effect.gen(function* () {
        const cancellationReconciliationStartedAt = yield* Effect.clockWith(
          (clock) => clock.currentTimeNanos,
        );
        const settlement = yield* recreationStep(
          runtime.settleWithOldCode({
            oldGroup,
            oldArtifacts: oldGroup.artifacts,
            sourceRevision: transition.previousDefinition.sourceRevision,
            expectedBinding,
            drain,
            strategy: "cancel-reconcile",
          }),
          "old-work-settlement-ambiguous",
          undefined,
          workflowRecreationTimeouts.acceptedWorkFinalization,
        ).pipe(
          Effect.flatMap((evidence) =>
            Schema.decodeUnknownEffect(WorkflowOldWorkSettlementEvidenceSchema)(evidence).pipe(
              Effect.mapError(() => recreationFailure("old-work-settlement-evidence-invalid")),
              Effect.flatMap((decoded) =>
                workflowExecutionEvidenceBindingMatches(decoded.binding, expectedBinding) &&
                decoded.drain === drain.drain
                  ? Effect.succeed(decoded)
                  : Effect.fail(recreationFailure("old-work-settlement-evidence-invalid")),
              ),
            ),
          ),
          Effect.tap((evidence) =>
            Effect.sync(() => {
              setWorkflowTransitionPhase(phases, "cancellation", evidence.cancellation);
              setWorkflowTransitionPhase(phases, "reconciliation", evidence.reconciliation);
              const settled =
                evidence.disposition === "settled" &&
                [evidence.cancellation, evidence.reconciliation].every(
                  (phase) => phase === "completed" || phase === "not-required",
                );
              const state = Match.value({ settled, disposition: evidence.disposition }).pipe(
                Match.when(
                  { settled: true },
                  (): WorkflowTransitionPhaseFacts["settlement"] => "settled",
                ),
                Match.when(
                  { disposition: "ambiguous" },
                  (): WorkflowTransitionPhaseFacts["settlement"] => "ambiguous",
                ),
                Match.orElse((): WorkflowTransitionPhaseFacts["settlement"] => "unconfirmed"),
              );
              setWorkflowTransitionPhase(phases, "settlement", state);
            }),
          ),
          Effect.tap(() =>
            recordWorkflowTransitionElapsed(
              phases,
              "cancellationReconciliationElapsedMs",
              cancellationReconciliationStartedAt,
            ),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              setWorkflowTransitionPhase(phases, "cancellation", "unconfirmed");
              setWorkflowTransitionPhase(phases, "reconciliation", "unconfirmed");
              setWorkflowTransitionPhase(phases, "settlement", "unconfirmed");
            }).pipe(
              Effect.andThen(
                recordWorkflowTransitionElapsed(
                  phases,
                  "cancellationReconciliationElapsedMs",
                  cancellationReconciliationStartedAt,
                ),
              ),
            ),
          ),
        );
        if (settlement.disposition !== "settled" || phases.current.settlement !== "settled")
          return { settlement, cessation: undefined };

        const cessationProofStartedAt = yield* Effect.clockWith((clock) => clock.currentTimeNanos);
        cessationProofStarted = true;
        const cessation = yield* recreationStep(
          runtime.proveOldCessation({
            oldGroup,
            sourceRevision: transition.previousDefinition.sourceRevision,
            expectedBinding,
          }),
          "old-execution-cessation-unproven",
          undefined,
          workflowRecreationTimeouts.acceptedWorkFinalization,
        ).pipe(
          Effect.tap((value) =>
            Effect.sync(() =>
              setWorkflowTransitionPhase(
                phases,
                "cessation",
                workflowExecutionCleanupDisposition(value, expectedBinding) === "deletable"
                  ? "proven"
                  : "unproven",
              ),
            ),
          ),
          Effect.tapError(() =>
            Effect.sync(() => setWorkflowTransitionPhase(phases, "cessation", "unconfirmed")),
          ),
          Effect.tap(() =>
            recordWorkflowTransitionElapsed(
              phases,
              "cessationProofElapsedMs",
              cessationProofStartedAt,
            ),
          ),
          Effect.tapError(() =>
            recordWorkflowTransitionElapsed(
              phases,
              "cessationProofElapsedMs",
              cessationProofStartedAt,
            ),
          ),
        );
        return { settlement, cessation };
      }),
      workflowRecreationTimeouts.acceptedWorkFinalization,
      () => recreationFailure("old-work-finalization-timeout"),
    ).pipe(
      Effect.tapError(() =>
        Effect.sync(() => {
          if (phases.current.cancellation === "not-started")
            setWorkflowTransitionPhase(phases, "cancellation", "unconfirmed");
          if (phases.current.reconciliation === "not-started")
            setWorkflowTransitionPhase(phases, "reconciliation", "unconfirmed");
          if (phases.current.settlement === "not-started")
            setWorkflowTransitionPhase(phases, "settlement", "unconfirmed");
          if (cessationProofStarted && phases.current.cessation === "not-started")
            setWorkflowTransitionPhase(phases, "cessation", "unconfirmed");
        }),
      ),
      Effect.tap(() =>
        recordWorkflowTransitionElapsed(phases, "settlementElapsedMs", finalizationStartedAt),
      ),
      Effect.tapError(() =>
        recordWorkflowTransitionElapsed(phases, "settlementElapsedMs", finalizationStartedAt),
      ),
      Effect.tap(() =>
        recordWorkflowTransitionElapsed(phases, "acceptedWorkElapsedMs", drainStartedAt),
      ),
      Effect.tapError(() =>
        recordWorkflowTransitionElapsed(phases, "acceptedWorkElapsedMs", drainStartedAt),
      ),
    );
    return finalization;
  });

const settleAndEndOldWorkflowGroup = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  transition: WorkflowPreviewTransition,
  phases: WorkflowTransitionPhaseState,
): Effect.Effect<string, WorkflowExecutionError> => {
  return Effect.gen(function* () {
    const expectedBinding = workflowExecutionEvidenceBinding(
      oldGroup,
      transition.previousDefinition.sourceRevision,
    );
    const { drain, drainStartedAt } = yield* prepareOldWorkflowForSettlement(
      runtime,
      oldGroup,
      transition,
      phases,
      expectedBinding,
    );
    const finalization = yield* finalizeOldWorkflowSettlement(
      runtime,
      oldGroup,
      transition,
      phases,
      expectedBinding,
      drain,
      drainStartedAt,
    );
    if (
      finalization.settlement.disposition !== "settled" ||
      phases.current.settlement !== "settled"
    )
      return yield* reject("old-work-settlement-ambiguous");
    const cessation = finalization.cessation;
    if (cessation === undefined) return yield* reject("old-work-settlement-ambiguous");
    if (workflowExecutionCleanupDisposition(cessation, expectedBinding) !== "deletable")
      return yield* reject("old-execution-cessation-unproven");

    let providerCleanupRecordId: string | undefined;
    const cleanupRecordId = yield* recreationStep(
      runtime.endOldSessionAndCleanup(oldGroup, (confirmedRecordId) => {
        if (confirmedRecordId.trim().length > 0) providerCleanupRecordId = confirmedRecordId;
      }),
      "old-cleanup-record-unavailable",
      "old-session-binding-mismatch",
      workflowRecreationTimeouts.providerOperation,
      () =>
        providerCleanupRecordId === undefined
          ? recreationFailure("old-cleanup-record-unavailable")
          : recreationFailure("old-session-end-unconfirmed", providerCleanupRecordId),
    ).pipe(
      Effect.tap((recordId) =>
        Effect.sync(() => {
          if (recordId.trim().length > 0) providerCleanupRecordId = recordId;
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => setWorkflowTransitionPhase(phases, "cleanup", "completed")),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          setWorkflowTransitionPhase(phases, "oldSessionEnd", "unconfirmed");
          setWorkflowTransitionPhase(
            phases,
            "cleanup",
            error.oldCleanupRecordId === undefined ? "unconfirmed" : "completed",
          );
        }),
      ),
    );
    if (cleanupRecordId.trim().length === 0) {
      setWorkflowTransitionPhase(phases, "oldSessionEnd", "unconfirmed");
      setWorkflowTransitionPhase(phases, "cleanup", "unconfirmed");
      return yield* reject("old-cleanup-record-unavailable");
    }
    setWorkflowTransitionPhase(phases, "oldSessionEnd", "ended");
    return cleanupRecordId;
  });
};

export const freshWorkflowGroupHasNewIdentities = (
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

export const freshOAuthClientIdentitiesAreValid = (
  proposed: WorkflowPreviewDefinition,
  oldGroup: WorkflowExecutionGroup,
  evidence: WorkflowFreshGroupEvidence,
) => {
  const freshClientIds = Object.values(evidence.workloadOAuthClientIds);
  const priorClientIds = Object.values(oldGroup.workloadOAuthClientIds);
  return (
    proposed.workloadRoles.length > 0 &&
    workflowStringSetsMatch(proposed.workloadRoles, Object.keys(evidence.workloadOAuthClientIds)) &&
    new Set(freshClientIds).size === freshClientIds.length &&
    freshClientIds.every((clientId) => !priorClientIds.includes(clientId)) &&
    workflowExecutionGroupDigest(evidence.workloadOAuthClientIds) ===
      workflowExecutionGroupDigest(evidence.group.workloadOAuthClientIds)
  );
};

const freshGroupArtifactsMatchProposal = (
  proposed: WorkflowPreviewDefinition,
  group: WorkflowExecutionGroup,
) =>
  workflowRolesAreSupportedAndUnique(proposed) &&
  proposedRunnerArtifactsCoverRoles(proposed) &&
  workflowExecutionArtifactsEqual(group.artifacts, proposed.artifacts);

const freshGroupRequiredGroupsMatchProposal = (
  proposed: WorkflowPreviewDefinition,
  evidence: WorkflowFreshGroupEvidence,
) => {
  return workflowStringSetsMatch(proposed.requiredGroups, evidence.requiredGroups);
};

const isExpectedFreshWorkflowGroup = (
  oldGroup: WorkflowExecutionGroup,
  proposed: WorkflowPreviewDefinition,
  cleanupRecordId: string,
  evidence: WorkflowFreshGroupEvidence,
): boolean => {
  return (
    evidence.priorCleanupRecordId === cleanupRecordId &&
    freshWorkflowGroupHasNewIdentities(oldGroup, evidence.group) &&
    freshGroupRequiredGroupsMatchProposal(proposed, evidence) &&
    freshOAuthClientIdentitiesAreValid(proposed, oldGroup, evidence) &&
    freshGroupArtifactsMatchProposal(proposed, evidence.group)
  );
};

const freshGroupQuarantineCandidate = (
  oldGroup: WorkflowExecutionGroup,
  cleanupRecordId: string,
  provisioned: unknown,
): FreshGroupQuarantineCandidate | undefined => {
  if (typeof provisioned !== "object" || provisioned === null || !("group" in provisioned))
    return undefined;
  try {
    const group = Schema.decodeUnknownSync(WorkflowExecutionGroup)(provisioned.group);
    if (!freshWorkflowGroupHasNewIdentities(oldGroup, group)) return undefined;
    return {
      freshSessionId: group.sessionId,
      freshOwnerToken: group.ownerToken,
      freshGeneration: group.generation,
      priorCleanupRecordId: cleanupRecordId,
    };
  } catch {
    return undefined;
  }
};

const approvedFreshGroupProvisioningFailureReasons = new Map<string, string>([
  ["fresh-group-provisioning-unconfirmed", "fresh-group-provisioning-unconfirmed"],
  ["fresh-group-provisioning-unverified", "fresh-group-provisioning-unverified"],
  ["fresh-group-evidence-invalid", "fresh-group-evidence-invalid"],
  ["fresh-group-session-binding-mismatch", "fresh-group-session-binding-mismatch"],
  ["fresh-group-quarantine-unavailable", "fresh-group-quarantine-unavailable"],
  ["fresh-group-quarantine-binding-mismatch", "fresh-group-quarantine-binding-mismatch"],
  ["fresh-session-lease-unconfirmed", "fresh-session-lease-unconfirmed"],
  ["fresh-session-lease-maintenance-unconfirmed", "fresh-session-lease-maintenance-unconfirmed"],
  ["fresh-session-provisioning-failed", "fresh-session-provisioning-failed"],
  ["fresh-session-credentials-path-unavailable", "fresh-session-credentials-path-unavailable"],
  ["fresh-session-credentials-write-failed", "fresh-session-credentials-write-failed"],
]);

export const safeWorkflowFreshGroupProvisioningFailureReason = (reason: string): string =>
  approvedFreshGroupProvisioningFailureReasons.get(reason) ?? "fresh-group-provisioning-unverified";

const normalizedFreshGroupProvisioningError = (
  error: unknown,
  cleanupRecordId: string,
): WorkflowExecutionError => {
  const reason =
    error instanceof WorkflowExecutionError
      ? safeWorkflowFreshGroupProvisioningFailureReason(error.reason)
      : "fresh-group-provisioning-unverified";
  if (!(error instanceof WorkflowExecutionError)) return recreationFailure(reason);

  const recovery = error.recovery;
  if (recovery === undefined) return recreationFailure(reason);
  const { recovery: recoveryState, ...diagnostic } = recovery;
  return new WorkflowExecutionError({
    reason,
    oldCleanupRecordId: cleanupRecordId,
    recovery: {
      ...diagnostic,
      oldCleanupRecordId: cleanupRecordId,
      ...(recoveryState === undefined
        ? {}
        : {
            recovery: {
              ...recoveryState,
              failureReason: safeWorkflowFreshGroupProvisioningFailureReason(
                recoveryState.failureReason,
              ),
            },
          }),
    },
  });
};

const provisionFreshWorkflowGroup = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  proposed: WorkflowPreviewDefinition,
  cleanupRecordId: string,
): Effect.Effect<WorkflowFreshGroupEvidence, WorkflowExecutionError> =>
  withWorkflowRecreationTimeout(
    runtime.provisionFreshGroup({
      oldGroup,
      artifacts: proposed.artifacts,
      requiredGroups: proposed.requiredGroups,
      priorCleanupRecordId: cleanupRecordId,
      transferPendingWork: false,
    }),
    workflowRecreationTimeouts.freshGroupStartup,
    () => recreationFailure("fresh-group-provisioning-unconfirmed"),
  ).pipe(
    Effect.mapError((error) => normalizedFreshGroupProvisioningError(error, cleanupRecordId)),
    Effect.flatMap((input) =>
      Schema.decodeUnknownEffect(WorkflowFreshGroupEvidence)(input).pipe(
        Effect.mapError(() =>
          invalidFreshGroupEvidence(
            freshGroupQuarantineCandidate(oldGroup, cleanupRecordId, input),
          ),
        ),
      ),
    ),
    Effect.flatMap((evidence) =>
      isExpectedFreshWorkflowGroup(oldGroup, proposed, cleanupRecordId, evidence)
        ? Effect.succeed(evidence)
        : Effect.fail(
            invalidFreshGroupEvidence(
              freshGroupQuarantineCandidate(oldGroup, cleanupRecordId, evidence),
            ),
          ),
    ),
  );

type FreshWorkflowGroupProvisioningResult =
  | {
      readonly _tag: "Failed";
      readonly reason: string;
      readonly freshGroupCandidate?: FreshGroupQuarantineCandidate;
      readonly oldCleanupRecordId?: string;
      readonly recovery?: typeof WorkflowRecreationDiagnosticSchema.Type;
    }
  | { readonly _tag: "Provisioned"; readonly evidence: WorkflowFreshGroupEvidence };

const provisionFreshWorkflowGroupForRecreation = (
  runtime: IncompatibleWorkflowRecreationRuntimeApi,
  oldGroup: WorkflowExecutionGroup,
  proposed: WorkflowPreviewDefinition,
  cleanupRecordId: string,
  phaseState: WorkflowTransitionPhaseState,
): Effect.Effect<FreshWorkflowGroupProvisioningResult> => {
  phaseState.oldCleanupRecordId = cleanupRecordId;
  setWorkflowTransitionPhase(phaseState, "freshGroup", "unconfirmed");
  return Effect.match(provisionFreshWorkflowGroup(runtime, oldGroup, proposed, cleanupRecordId), {
    onFailure: (error) => {
      const freshGroupCandidate = freshGroupQuarantineCandidates.get(error);
      return {
        _tag: "Failed" as const,
        reason: error.reason,
        ...(freshGroupCandidate === undefined ? {} : { freshGroupCandidate }),
        ...(error.oldCleanupRecordId === undefined
          ? {}
          : { oldCleanupRecordId: error.oldCleanupRecordId }),
        ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
      };
    },
    onSuccess: (evidence) => {
      setWorkflowTransitionPhase(phaseState, "freshGroup", "provisioned");
      return { _tag: "Provisioned" as const, evidence };
    },
  });
};

/**
 * Recreate only after old-code settlement and provider cessation proof. Every uncertain
 * result retains quarantine and prevents cleanup or allocation of a replacement group.
 */
export const recreateIncompatibleWorkflowPreview = (
  input: WorkflowRecreationInput,
): Effect.Effect<WorkflowRecreationResult, never, IncompatibleWorkflowRecreationRuntime> => {
  const phaseState: WorkflowTransitionPhaseState = {
    current: emptyWorkflowTransitionPhases(),
  };
  return Effect.gen(function* () {
    const runtime = yield* IncompatibleWorkflowRecreationRuntime;
    const preflight = workflowRecreationPreflight(input);
    if (preflight.rejectedReason !== undefined)
      return {
        _tag: "Rejected" as const,
        transition: preflight.transition,
        phases: phaseState.current,
        reason: preflight.rejectedReason,
      };
    const transition = preflight.transition;

    const priorGroup = yield* Effect.match(
      settleAndEndOldWorkflowGroup(runtime, input.oldGroup, transition, phaseState),
      {
        onFailure: (error) => ({
          _tag: "Failed" as const,
          reason: error.reason,
          ...(error.oldCleanupRecordId === undefined
            ? {}
            : { oldCleanupRecordId: error.oldCleanupRecordId }),
        }),
        onSuccess: (cleanupRecordId) => ({ _tag: "Settled" as const, cleanupRecordId }),
      },
    );
    if (priorGroup._tag === "Failed") {
      if (priorGroup.oldCleanupRecordId !== undefined)
        phaseState.oldCleanupRecordId = priorGroup.oldCleanupRecordId;
      return yield* quarantineWorkflowRecreation(
        runtime,
        input.oldGroup,
        transition,
        phaseState.current,
        priorGroup.reason,
        undefined,
        priorGroup.oldCleanupRecordId,
      );
    }

    const freshGroup = yield* provisionFreshWorkflowGroupForRecreation(
      runtime,
      input.oldGroup,
      input.proposed,
      priorGroup.cleanupRecordId,
      phaseState,
    );
    if (freshGroup._tag === "Failed")
      return yield* quarantineWorkflowRecreation(
        runtime,
        input.oldGroup,
        transition,
        phaseState.current,
        freshGroup.reason,
        freshGroup.recovery,
        freshGroup.oldCleanupRecordId ?? priorGroup.cleanupRecordId,
        freshGroup.freshGroupCandidate,
      );
    return {
      _tag: "Recreated" as const,
      transition,
      phases: phaseState.current,
      oldCleanupRecordId: priorGroup.cleanupRecordId,
      fresh: freshGroup.evidence,
    };
  }).pipe(
    Effect.catchCause(() =>
      Effect.gen(function* () {
        const runtime = yield* IncompatibleWorkflowRecreationRuntime;
        const reason = "recreation-failed";
        return yield* quarantineWorkflowRecreation(
          runtime,
          input.oldGroup,
          classifyWorkflowPreviewTransition(input.previous, input.proposed),
          phaseState.current,
          reason,
          undefined,
          phaseState.oldCleanupRecordId,
        );
      }),
    ),
  );
};

/** Live profile activation is deliberately unavailable until a provider owns provisioning and proof. */
export const ownedWorkflowExecutionLiveProfileEnabled = false;
