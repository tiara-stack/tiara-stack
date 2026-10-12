import { createHash } from "node:crypto";
import { Cause, Context, Effect, Layer, Match, Option, Schema } from "effect";
import {
  RunnerRevisionStatusSchema,
  RunnerRoleSchema,
  stagedSourceActivationTimeouts,
  stagedSourceDigestInput,
  validateStagedSourceSnapshot,
  StagedSourceFileSchema,
  StagedSourcePackageManifestSchema,
  StagedSourceSnapshotSchema,
  WorkflowRecreationDiagnosticSchema,
  WorkflowTransitionPhaseFactsSchema,
  type RunnerRevisionStatus,
  type RunnerRole,
  type StagedSourceFile,
  type StagedSourceSnapshot,
  type WorkflowRecreationDiagnostic,
  type WorkflowTransitionPhaseFacts,
} from "sheet-workflow-contracts";
import {
  classifyWorkflowPreviewTransition,
  IncompatibleWorkflowRecreationRuntimeLayer,
  WorkflowExecutionError,
  WorkflowExecutionGroup,
  WorkflowPreviewDefinition,
  recreateIncompatibleWorkflowPreview,
  emptyWorkflowTransitionPhases,
  workflowRecreationTimeouts,
  withWorkflowRecreationTimeout,
  workflowExecutionArtifactsEqual,
  workflowStringSetsMatch,
  type IncompatibleWorkflowRecreationRuntimeApi,
  type WorkflowRecreationResult,
} from "./owned-workflow-execution";

export {
  RunnerRevisionStatusSchema,
  RunnerRoleSchema,
  StagedSourceFileSchema,
  StagedSourcePackageManifestSchema,
  StagedSourceSnapshotSchema,
};
export type { RunnerRevisionStatus, RunnerRole, StagedSourceFile, StagedSourceSnapshot };

/** A complete, host-independent source image. Missing paths in a newer image are deletions. */
const snapshotFilesDigest = (revision: string, files: ReadonlyArray<StagedSourceFile>) =>
  createHash("sha256").update(stagedSourceDigestInput(revision, files)).digest("hex");

const snapshotValidationReason = (input: unknown): string | undefined => {
  let snapshot: StagedSourceSnapshot;
  try {
    snapshot = Schema.decodeUnknownSync(StagedSourceSnapshotSchema)(input);
  } catch {
    return "invalid-snapshot-completion";
  }
  return validateStagedSourceSnapshot(
    snapshot,
    snapshotFilesDigest(snapshot.revision, snapshot.files),
  );
};

/** Seal the expected complete tree before transfer so omissions can be detected at activation. */
export const sealStagedSourceSnapshot = (
  revision: string,
  files: ReadonlyArray<StagedSourceFile>,
): StagedSourceSnapshot => ({
  revision,
  files: [...files],
  completion: {
    expectedFileCount: files.length,
    filesDigest: snapshotFilesDigest(revision, files),
  },
});
const packageManifestPath = /^packages\/([^/]+)\/package\.json$/;
const workspacePackageDirectory = (path: string): string | undefined =>
  packageManifestPath.exec(path)?.[1];
const sourcePackageDirectory = (path: string): string | undefined =>
  /^packages\/([^/]+)\//.exec(path)?.[1];

export class SnapshotError extends Schema.TaggedErrorClass<SnapshotError>()("SnapshotError", {
  reason: Schema.String,
}) {}

export class SnapshotRuntimeError extends Schema.TaggedErrorClass<SnapshotRuntimeError>()(
  "SnapshotRuntimeError",
  {
    reason: Schema.String,
    oldCleanupRecordId: Schema.optionalKey(Schema.NonEmptyString),
    workflowRecreation: Schema.optionalKey(WorkflowRecreationDiagnosticSchema),
    workflowTransitionPhases: Schema.optionalKey(WorkflowTransitionPhaseFactsSchema),
  },
) {}

type RunnerActivationError = SnapshotError | SnapshotRuntimeError;

const validateSnapshotCompletion = (
  snapshot: StagedSourceSnapshot,
): Effect.Effect<StagedSourceSnapshot, SnapshotError> => {
  const reason = validateStagedSourceSnapshot(
    snapshot,
    snapshotFilesDigest(snapshot.revision, snapshot.files),
  );
  return reason === undefined
    ? Effect.succeed(snapshot)
    : Effect.fail(new SnapshotError({ reason }));
};

const decodeCompleteSnapshot = (
  snapshot: StagedSourceSnapshot,
): Effect.Effect<StagedSourceSnapshot, SnapshotError> =>
  Schema.decodeUnknownEffect(StagedSourceSnapshotSchema)(snapshot).pipe(
    Effect.mapError(() => new SnapshotError({ reason: "invalid-snapshot-completion" })),
    Effect.flatMap(validateSnapshotCompletion),
  );

/** Reject unsafe/incomplete transfer input before any active tree can be changed. */
export const validateStagedSnapshot = (
  snapshot: StagedSourceSnapshot,
): Effect.Effect<StagedSourceSnapshot, SnapshotError> => decodeCompleteSnapshot(snapshot);

export type SnapshotChange = "source" | "artifact";
const artifactPath =
  /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|.*\.(?:node|wasm)|vite\.config\.[^/]+|tsconfig[^/]*\.json|.*\.config\.[^/]+)$/;
const changedSnapshotPaths = (
  previous: StagedSourceSnapshot,
  next: StagedSourceSnapshot,
): ReadonlyArray<string> => {
  const before = new Map(previous.files.map((file) => [file.path, file]));
  const after = new Map(next.files.map((file) => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => {
    const previousFile = before.get(path);
    const nextFile = after.get(path);
    return (
      previousFile?.content !== nextFile?.content ||
      previousFile?.contentEncoding !== nextFile?.contentEncoding ||
      previousFile?.mode !== nextFile?.mode
    );
  });
};

export const classifySnapshotChange = (
  previous: StagedSourceSnapshot,
  next: StagedSourceSnapshot,
): SnapshotChange =>
  changedSnapshotPaths(previous, next).some((path) => artifactPath.test(path))
    ? "artifact"
    : "source";

/** A watcher can submit all saves observed in one event-loop turn; only its newest complete tree is activated. */
export const coalesceSnapshotSaves = (
  saves: ReadonlyArray<StagedSourceSnapshot>,
): StagedSourceSnapshot | undefined => {
  for (let index = saves.length - 1; index >= 0; index -= 1) {
    const snapshot = saves[index];
    if (snapshot !== undefined && snapshotValidationReason(snapshot) === undefined) return snapshot;
  }
  return undefined;
};

type WorkspacePackageManifest = typeof StagedSourcePackageManifestSchema.Type;
type WorkspacePackageManifests = ReadonlyMap<
  string,
  { readonly path: string; readonly manifest: WorkspacePackageManifest }
>;

const workspacePackageManifests = (snapshot: StagedSourceSnapshot): WorkspacePackageManifests => {
  const manifests = new Map<
    string,
    { readonly path: string; readonly manifest: WorkspacePackageManifest }
  >();
  for (const file of snapshot.files) {
    const directory = workspacePackageDirectory(file.path);
    if (directory === undefined) continue;
    const manifest = Schema.decodeUnknownSync(
      Schema.fromJsonString(StagedSourcePackageManifestSchema),
    )(file.content);
    manifests.set(directory, { path: file.path, manifest });
  }
  return manifests;
};

const workspacePackageNames = (manifests: WorkspacePackageManifests) => {
  const names = new Map<string, string>();
  for (const [directory, entry] of manifests) names.set(directory, entry.manifest.name);
  return names;
};

/** Propagate changed workspace packages to selected workflow consumers through workspace dependencies. */
export const affectedRunnerRoles = (
  previous: StagedSourceSnapshot,
  next: StagedSourceSnapshot,
  selectedRoles: ReadonlyArray<RunnerRole>,
): ReadonlyArray<RunnerRole> => {
  const changedPaths = changedSnapshotPaths(previous, next);
  if (changedPaths.length === 0) return selectedRoles;
  const changedDirectories = changedPackageDirectories(changedPaths);
  if (changedDirectories === undefined) return selectedRoles;
  const previousManifests = workspacePackageManifests(previous);
  const nextManifests = workspacePackageManifests(next);
  const changedNames = changedWorkspacePackageNames(
    previousManifests,
    nextManifests,
    changedDirectories,
  );
  if (changedNames === undefined) return selectedRoles;
  const affectedNames = workspaceDependencyClosure(
    workspaceDependencyGraph(nextManifests),
    changedNames,
  );
  if (!new Set(workspacePackageNames(nextManifests).values()).has("sheet-workflows"))
    return selectedRoles;
  if (!affectedNames.has("sheet-workflows")) return [];
  return selectedRoles;
};

const changedPackageDirectories = (
  paths: ReadonlyArray<string>,
): ReadonlySet<string> | undefined => {
  const directories = new Set<string>();
  for (const path of paths) {
    const directory = sourcePackageDirectory(path);
    if (directory === undefined) return undefined;
    directories.add(directory);
  }
  return directories;
};

const changedWorkspacePackageNames = (
  previous: WorkspacePackageManifests,
  next: WorkspacePackageManifests,
  changedDirectories: ReadonlySet<string>,
): ReadonlySet<string> | undefined => {
  const before = workspacePackageNames(previous);
  const after = workspacePackageNames(next);
  const names = new Set<string>();
  for (const directory of changedDirectories) {
    const name = after.get(directory) ?? before.get(directory);
    if (name === undefined) return undefined;
    names.add(name);
  }
  return names;
};

const workspaceDependencies = (
  path: string,
  manifest: WorkspacePackageManifest,
): ReadonlyArray<string> => {
  if (!packageManifestPath.test(path)) return [];
  return [
    ...Object.entries(manifest.dependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
    ...Object.entries(manifest.optionalDependencies ?? {}),
  ]
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([name]) => name);
};

const workspaceDependencyGraph = (manifests: WorkspacePackageManifests) => {
  const dependents = new Map<string, Set<string>>();
  for (const entry of manifests.values()) {
    const dependentName = entry.manifest.name;
    for (const dependencyName of workspaceDependencies(entry.path, entry.manifest)) {
      const names = dependents.get(dependencyName) ?? new Set<string>();
      names.add(dependentName);
      dependents.set(dependencyName, names);
    }
  }
  return { dependents };
};

const workspaceDependencyClosure = (
  graph: ReturnType<typeof workspaceDependencyGraph>,
  changedNames: ReadonlySet<string>,
): ReadonlySet<string> => {
  const affectedNames = new Set(changedNames);
  const pending = [...changedNames];
  while (pending.length > 0) {
    const dependencyName = pending.pop();
    if (dependencyName === undefined) continue;
    for (const dependentName of graph.dependents.get(dependencyName) ?? []) {
      if (affectedNames.has(dependentName)) continue;
      affectedNames.add(dependentName);
      pending.push(dependentName);
    }
  }
  return affectedNames;
};

/** Provider boundary: writes are scoped to one owned writable volume and activate is atomic. */
export interface StagedRunnerRuntimeApi {
  /**
   * Trusted server-side authorization for each new revision. Explicit incompatible workflow
   * recreation evaluates it before any destructive transition work; other activations evaluate
   * it immediately before staging. The staging supervisor independently enforces its own
   * authority boundary. Implementations resolve bound durable state themselves; transition
   * declarations are context, not authority. Missing, denied, or timed-out authorization fails
   * closed.
   */
  readonly authorizeActivation?: (input: {
    readonly previous: StagedSourceSnapshot | null;
    readonly proposed: StagedSourceSnapshot;
    readonly owner: string;
    readonly nextOwner: string;
    readonly roles: ReadonlyArray<RunnerRole>;
    readonly workflowTransition: RunnerActivationInput["workflowTransition"];
  }) => Effect.Effect<void, SnapshotRuntimeError>;
  readonly stageComplete: (
    snapshot: StagedSourceSnapshot,
  ) => Effect.Effect<void, SnapshotRuntimeError>;
  readonly fenceOldOwner: (
    owner: string,
    nextOwner: string,
  ) => Effect.Effect<void, SnapshotRuntimeError>;
  readonly activateComplete: (revision: string) => Effect.Effect<void, SnapshotRuntimeError>;
  readonly retainImmutableRevision: (revision: string) => Effect.Effect<void, SnapshotRuntimeError>;
  readonly rebuildArtifacts: (revision: string) => Effect.Effect<void, SnapshotRuntimeError>;
  readonly restartRole: (
    role: RunnerRole,
    revision: string,
    kind: SnapshotChange,
  ) => Effect.Effect<void, SnapshotRuntimeError>;
  readonly verifyActualReadiness: (
    revision: string,
    roles: ReadonlyArray<RunnerRole>,
  ) => Effect.Effect<boolean, SnapshotRuntimeError>;
  /** Build/verify complete execution artifacts for the exact sealed snapshot, without activating it. */
  readonly resolveWorkflowArtifacts: (
    snapshot: StagedSourceSnapshot,
  ) => Effect.Effect<
    import("./owned-workflow-execution").WorkflowExecutionArtifacts,
    SnapshotRuntimeError
  >;
  /** Persist the old cleanup link before promoting the fresh source pointer. */
  readonly persistWorkflowRecreationDiagnostic: (
    diagnostic: WorkflowRecreationDiagnostic,
  ) => Effect.Effect<void, SnapshotRuntimeError>;
  /** Provider-owned settlement boundary for explicit incompatible workflow changes. */
  readonly workflowRecreation?: IncompatibleWorkflowRecreationRuntimeApi;
}

export class StagedRunnerRuntime extends Context.Service<
  StagedRunnerRuntime,
  StagedRunnerRuntimeApi
>()("developer-launcher/StagedRunnerRuntime") {}

export const StagedRunnerRuntimeLayer = (runtime: StagedRunnerRuntimeApi) =>
  Layer.succeed(StagedRunnerRuntime, runtime);

type RunnerActivationInput = {
  readonly snapshot: StagedSourceSnapshot;
  readonly previous: StagedSourceSnapshot | null;
  readonly owner: string;
  readonly nextOwner: string;
  readonly roles?: ReadonlyArray<RunnerRole>;
  readonly workflowTransition?:
    | {
        readonly oldGroup: WorkflowExecutionGroup;
        readonly previous: WorkflowPreviewDefinition;
        readonly proposed: WorkflowPreviewDefinition;
        readonly explicitlyRequested: boolean;
      }
    | undefined;
};

type RunnerActivationState = {
  roles: ReadonlyArray<RunnerRole>;
  activated: boolean;
  workflowRecreation: WorkflowRecreationDiagnostic | undefined;
  workflowRecreationAuthorityAuthorized: boolean;
  workflowTransitionPhases: WorkflowTransitionPhaseFacts | undefined;
};

const statusForRevision = (
  revision: string,
  workflowRecreation?: WorkflowRecreationDiagnostic,
): RunnerRevisionStatus => ({
  requestedRevision: revision,
  activeRevision: revision,
  unavailableRoles: [],
  failure: null,
  ...(workflowRecreation === undefined ? {} : { workflowRecreation }),
  ...(workflowRecreation?.phases === undefined
    ? {}
    : { workflowTransitionPhases: workflowRecreation.phases }),
});

const failureReason = (reason: RunnerActivationError) => reason.reason;

const workflowRecreationForFailure = (
  state: RunnerActivationState,
  reason: RunnerActivationError,
): WorkflowRecreationDiagnostic | undefined =>
  state.workflowRecreation ??
  (reason instanceof SnapshotRuntimeError ? reason.workflowRecreation : undefined);

const workflowTransitionPhasesForFailure = (
  state: RunnerActivationState,
  reason: RunnerActivationError,
): WorkflowTransitionPhaseFacts | undefined =>
  state.workflowTransitionPhases ??
  (reason instanceof SnapshotRuntimeError ? reason.workflowTransitionPhases : undefined);

const failureStatus = (
  input: RunnerActivationInput,
  state: RunnerActivationState,
  reason: RunnerActivationError,
): RunnerRevisionStatus => {
  const workflowRecreation = workflowRecreationForFailure(state, reason);
  const workflowTransitionPhases = workflowTransitionPhasesForFailure(state, reason);
  return {
    requestedRevision: input.snapshot.revision,
    activeRevision: state.activated ? input.snapshot.revision : (input.previous?.revision ?? null),
    unavailableRoles: state.roles,
    failure: failureReason(reason),
    ...(reason instanceof SnapshotRuntimeError && reason.oldCleanupRecordId !== undefined
      ? { oldCleanupRecordId: reason.oldCleanupRecordId }
      : {}),
    ...(workflowRecreation === undefined ? {} : { workflowRecreation }),
    ...(workflowTransitionPhases === undefined ? {} : { workflowTransitionPhases }),
  };
};

const prepareRunnerRevision = (
  input: RunnerActivationInput,
  snapshot: StagedSourceSnapshot,
  runtime: StagedRunnerRuntimeApi,
): Effect.Effect<SnapshotChange, SnapshotRuntimeError> =>
  Effect.timeoutOrElse(
    Effect.gen(function* () {
      yield* runtime.stageComplete(snapshot);
      yield* runtime.fenceOldOwner(input.owner, input.nextOwner);
      if (input.previous) yield* runtime.retainImmutableRevision(input.previous.revision);
      const change = input.previous ? classifySnapshotChange(input.previous, snapshot) : "artifact";
      if (change === "artifact") yield* runtime.rebuildArtifacts(snapshot.revision);
      return change;
    }),
    {
      duration: stagedSourceActivationTimeouts.preparation,
      orElse: () => Effect.fail(new SnapshotRuntimeError({ reason: "runner-preparation-timeout" })),
    },
  );

const authorizeRunnerActivation = (
  input: RunnerActivationInput,
  snapshot: StagedSourceSnapshot,
  roles: ReadonlyArray<RunnerRole>,
  runtime: StagedRunnerRuntimeApi,
): Effect.Effect<void, SnapshotRuntimeError> => {
  const authorize = runtime.authorizeActivation;
  if (authorize === undefined)
    return Effect.fail(
      new SnapshotRuntimeError({ reason: "snapshot-activation-authority-unavailable" }),
    );
  return Effect.exit(
    Effect.interruptible(
      Effect.timeoutOrElse(
        authorize({
          previous: input.previous,
          proposed: snapshot,
          owner: input.owner,
          nextOwner: input.nextOwner,
          roles,
          workflowTransition: input.workflowTransition,
        }),
        {
          duration: stagedSourceActivationTimeouts.authority,
          orElse: () =>
            Effect.fail(
              new SnapshotRuntimeError({ reason: "snapshot-activation-authority-timeout" }),
            ),
        },
      ),
    ),
  ).pipe(
    Effect.flatMap((exit) => {
      if (exit._tag === "Success") return Effect.void;
      return Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () =>
          Effect.fail(
            new SnapshotRuntimeError({ reason: "snapshot-activation-authority-timeout" }),
          ),
        onSome: (error) =>
          Effect.fail(
            error instanceof SnapshotRuntimeError &&
              error.reason === "snapshot-activation-authority-timeout"
              ? error
              : new SnapshotRuntimeError({ reason: "snapshot-activation-authority-rejected" }),
          ),
      });
    }),
  );
};

const requireRunnerReadiness = (
  runtime: StagedRunnerRuntimeApi,
  revision: string,
  roles: ReadonlyArray<RunnerRole>,
): Effect.Effect<void, SnapshotError | SnapshotRuntimeError> =>
  runtime
    .verifyActualReadiness(revision, roles)
    .pipe(
      Effect.timeout(stagedSourceActivationTimeouts.readiness),
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? new SnapshotRuntimeError({ reason: "runner-readiness-timeout" })
          : error,
      ),
    )
    .pipe(
      Effect.flatMap((ready) =>
        ready ? Effect.void : Effect.fail(new SnapshotError({ reason: "readiness-check-failed" })),
      ),
    );

const sameRevisionSnapshot = (
  previous: StagedSourceSnapshot | null,
  next: StagedSourceSnapshot,
): Effect.Effect<boolean, SnapshotError> => {
  if (previous === null || previous.revision !== next.revision) return Effect.succeed(false);
  if (previous.completion.filesDigest !== next.completion.filesDigest)
    return Effect.fail(new SnapshotError({ reason: "revision-content-conflict" }));
  return Effect.succeed(true);
};

const workflowRecreationFailureDetails = (result: WorkflowRecreationResult) =>
  Match.value(result).pipe(
    Match.tag("Quarantined", ({ recovery, oldCleanupRecordId }) => ({
      recovery,
      oldCleanupRecordId,
      quarantineReason: undefined,
    })),
    Match.tag("QuarantineUnconfirmed", ({ recovery, oldCleanupRecordId, quarantineReason }) => ({
      recovery,
      oldCleanupRecordId,
      quarantineReason,
    })),
    Match.orElse(() => ({
      recovery: undefined,
      oldCleanupRecordId: undefined,
      quarantineReason: undefined,
    })),
  );

const applyWorkflowTransition = (
  transitionInput: NonNullable<RunnerActivationInput["workflowTransition"]>,
  runtime: StagedRunnerRuntimeApi,
): Effect.Effect<WorkflowRecreationDiagnostic | undefined, SnapshotRuntimeError> =>
  Effect.gen(function* () {
    const phases = { current: emptyWorkflowTransitionPhases() };
    const transition = classifyWorkflowPreviewTransition(
      transitionInput.previous,
      transitionInput.proposed,
    );
    if (transition.classification === "unverified")
      return yield* Effect.fail(
        new SnapshotRuntimeError({
          reason: "workflow-transition-compatibility-evidence-unverified",
          workflowTransitionPhases: phases.current,
        }),
      );
    if (transition.classification === "compatible") return undefined;
    const recreation = runtime.workflowRecreation;
    if (recreation === undefined)
      return yield* Effect.fail(
        new SnapshotRuntimeError({
          reason: "workflow-recreation-runtime-unavailable",
          workflowTransitionPhases: phases.current,
        }),
      );
    if (!transitionInput.explicitlyRequested) {
      yield* withWorkflowRecreationTimeout(
        recreation.presentProposal(transition),
        workflowRecreationTimeouts.providerOperation,
        () => new WorkflowExecutionError({ reason: "proposal-not-presented" }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            phases.current = { ...phases.current, proposal: "presented" };
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            phases.current = { ...phases.current, proposal: "unconfirmed" };
          }),
        ),
        Effect.mapError(
          () =>
            new SnapshotRuntimeError({
              reason: "workflow-proposal-unavailable",
              workflowTransitionPhases: phases.current,
            }),
        ),
      );
      yield* withWorkflowRecreationTimeout(
        recreation.pauseAdmission(transitionInput.oldGroup),
        workflowRecreationTimeouts.providerOperation,
        () => new WorkflowExecutionError({ reason: "admission-pause-unconfirmed" }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            phases.current = { ...phases.current, admission: "paused" };
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            phases.current = { ...phases.current, admission: "unconfirmed" };
          }),
        ),
        Effect.mapError(
          () =>
            new SnapshotRuntimeError({
              reason: "workflow-admission-pause-unconfirmed",
              workflowTransitionPhases: phases.current,
            }),
        ),
      );
      return yield* Effect.fail(
        new SnapshotRuntimeError({
          reason: "incompatible-workflow-transition-requires-explicit-recreation",
          workflowTransitionPhases: phases.current,
        }),
      );
    }
    const result = yield* recreateIncompatibleWorkflowPreview({
      ...transitionInput,
      explicitlyRequested: true,
    }).pipe(Effect.provide(IncompatibleWorkflowRecreationRuntimeLayer(recreation)));
    if (result._tag !== "Recreated") {
      const { recovery, oldCleanupRecordId, quarantineReason } =
        workflowRecreationFailureDetails(result);
      return yield* Effect.fail(
        new SnapshotRuntimeError({
          reason: `workflow-${result._tag.toLowerCase()}:${result.reason}${quarantineReason === undefined ? "" : `:${quarantineReason}`}`,
          workflowTransitionPhases: result.phases,
          ...(oldCleanupRecordId === undefined ? {} : { oldCleanupRecordId }),
          ...(recovery === undefined ? {} : { workflowRecreation: recovery }),
        }),
      );
    }
    return {
      oldCleanupRecordId: result.oldCleanupRecordId,
      freshSessionId: result.fresh.group.sessionId,
      freshGeneration: result.fresh.group.generation,
      priorRevision: transitionInput.previous.sourceRevision,
      requestedRevision: transitionInput.proposed.sourceRevision,
      reasons: transition.reasons,
      phases: result.phases,
    };
  });

const validateWorkflowTransitionGroupBinding = (
  transition: NonNullable<RunnerActivationInput["workflowTransition"]>,
  previous: StagedSourceSnapshot,
  snapshot: StagedSourceSnapshot,
): Effect.Effect<void, SnapshotRuntimeError> => {
  if (transition.previous.sourceRevision !== previous.revision)
    return Effect.fail(new SnapshotRuntimeError({ reason: "workflow-previous-revision-mismatch" }));
  if (transition.proposed.sourceRevision !== snapshot.revision)
    return Effect.fail(new SnapshotRuntimeError({ reason: "workflow-proposed-revision-mismatch" }));
  if (
    !workflowExecutionArtifactsEqual(transition.previous.artifacts, transition.oldGroup.artifacts)
  )
    return Effect.fail(
      new SnapshotRuntimeError({ reason: "workflow-old-group-artifact-mismatch" }),
    );
  const rolesMatch = workflowStringSetsMatch(
    transition.previous.workloadRoles,
    Object.keys(transition.oldGroup.workloadOAuthClientIds),
  );
  return rolesMatch
    ? Effect.void
    : Effect.fail(
        new SnapshotRuntimeError({ reason: "workflow-old-group-role-identity-mismatch" }),
      );
};

const validateProposedWorkflowSnapshot = (
  transition: NonNullable<RunnerActivationInput["workflowTransition"]>,
  snapshot: StagedSourceSnapshot,
  runtime: StagedRunnerRuntimeApi,
): Effect.Effect<void, SnapshotRuntimeError> =>
  withWorkflowRecreationTimeout(
    runtime.resolveWorkflowArtifacts(snapshot),
    workflowRecreationTimeouts.freshGroupStartup,
    () => new SnapshotRuntimeError({ reason: "workflow-proposed-snapshot-resolution-timeout" }),
  ).pipe(
    Effect.flatMap((snapshotArtifacts) =>
      workflowExecutionArtifactsEqual(snapshotArtifacts, transition.proposed.artifacts)
        ? Effect.void
        : Effect.fail(
            new SnapshotRuntimeError({ reason: "workflow-proposed-snapshot-artifact-mismatch" }),
          ),
    ),
  );

const validateWorkflowTransition = (
  transition: NonNullable<RunnerActivationInput["workflowTransition"]>,
  previous: StagedSourceSnapshot,
  snapshot: StagedSourceSnapshot,
  runtime: StagedRunnerRuntimeApi,
): Effect.Effect<void, SnapshotRuntimeError> =>
  Effect.gen(function* () {
    yield* validateWorkflowTransitionGroupBinding(transition, previous, snapshot);
    yield* validateProposedWorkflowSnapshot(transition, snapshot, runtime);
  });

const validateAndApplyWorkflowTransition = (
  transition: NonNullable<RunnerActivationInput["workflowTransition"]>,
  previous: StagedSourceSnapshot,
  snapshot: StagedSourceSnapshot,
  runtime: StagedRunnerRuntimeApi,
): Effect.Effect<WorkflowRecreationDiagnostic | undefined, SnapshotRuntimeError> =>
  validateWorkflowTransition(transition, previous, snapshot, runtime).pipe(
    Effect.andThen(applyWorkflowTransition(transition, runtime)),
  );

const selectedRunnerRoles = (input: RunnerActivationInput): ReadonlyArray<RunnerRole> => {
  const roleOrder: ReadonlyArray<RunnerRole> = [
    "workflow-api",
    "ordinary-runner",
    "browser-runner",
  ];
  return roleOrder.filter((role) => (input.roles ?? ["ordinary-runner"]).includes(role));
};

const workflowTransitionPreconditionFailure = (
  input: RunnerActivationInput,
  isSameRevision: boolean,
): SnapshotRuntimeError | undefined => {
  if (input.workflowTransition !== undefined && input.previous === null)
    return new SnapshotRuntimeError({ reason: "workflow-transition-previous-snapshot-required" });
  if (input.previous !== null && !isSameRevision && input.workflowTransition === undefined)
    return new SnapshotRuntimeError({ reason: "workflow-transition-evidence-required" });
  return undefined;
};

const prepareWorkflowTransition = (
  input: RunnerActivationInput,
  snapshot: StagedSourceSnapshot,
  runtime: StagedRunnerRuntimeApi,
  isSameRevision: boolean,
): Effect.Effect<
  {
    readonly workflowRecreation: WorkflowRecreationDiagnostic | undefined;
    readonly authorityAuthorized: boolean;
  },
  SnapshotRuntimeError
> =>
  Effect.gen(function* () {
    const transitionInput = input.workflowTransition;
    const preconditionFailure = workflowTransitionPreconditionFailure(input, isSameRevision);
    if (preconditionFailure !== undefined) return yield* Effect.fail(preconditionFailure);
    if (transitionInput === undefined || input.previous === null)
      return { workflowRecreation: undefined, authorityAuthorized: false };

    const oldGroup = yield* Schema.decodeUnknownEffect(WorkflowExecutionGroup)(
      transitionInput.oldGroup,
    ).pipe(
      Effect.mapError(
        () => new SnapshotRuntimeError({ reason: "workflow-transition-definition-invalid" }),
      ),
    );
    const previousDefinition = yield* Schema.decodeUnknownEffect(WorkflowPreviewDefinition)(
      transitionInput.previous,
    ).pipe(
      Effect.mapError(
        () => new SnapshotRuntimeError({ reason: "workflow-transition-definition-invalid" }),
      ),
    );
    const proposedDefinition = yield* Schema.decodeUnknownEffect(WorkflowPreviewDefinition)(
      transitionInput.proposed,
    ).pipe(
      Effect.mapError(
        () => new SnapshotRuntimeError({ reason: "workflow-transition-definition-invalid" }),
      ),
    );
    const validatedTransition = {
      ...transitionInput,
      oldGroup,
      previous: previousDefinition,
      proposed: proposedDefinition,
    };
    const transition = classifyWorkflowPreviewTransition(
      validatedTransition.previous,
      validatedTransition.proposed,
    );
    if (!isSameRevision || transition.classification !== "compatible") {
      if (transition.classification === "incompatible" && transitionInput.explicitlyRequested) {
        yield* validateWorkflowTransition(validatedTransition, input.previous, snapshot, runtime);
        const authorizedInput = { ...input, workflowTransition: validatedTransition };
        yield* authorizeRunnerActivation(
          authorizedInput,
          snapshot,
          selectedRunnerRoles(input),
          runtime,
        );
        return {
          workflowRecreation: yield* applyWorkflowTransition(validatedTransition, runtime),
          authorityAuthorized: true,
        };
      }
      return {
        workflowRecreation: yield* validateAndApplyWorkflowTransition(
          validatedTransition,
          input.previous,
          snapshot,
          runtime,
        ),
        authorityAuthorized: false,
      };
    }
    return { workflowRecreation: undefined, authorityAuthorized: false };
  });

const restartRunnerRoles = (
  runtime: StagedRunnerRuntimeApi,
  revision: string,
  change: SnapshotChange,
  roles: ReadonlyArray<RunnerRole>,
): Effect.Effect<void, SnapshotRuntimeError> =>
  Effect.gen(function* () {
    for (const role of roles)
      yield* runtime.restartRole(role, revision, change).pipe(
        Effect.timeout(stagedSourceActivationTimeouts.restart),
        Effect.mapError((error) =>
          Cause.isTimeoutError(error)
            ? new SnapshotRuntimeError({ reason: "runner-restart-timeout" })
            : error,
        ),
      );
  });

const prepareWorkflowActivation = (
  input: RunnerActivationInput,
  runtime: StagedRunnerRuntimeApi,
): Effect.Effect<
  {
    readonly snapshot: StagedSourceSnapshot;
    readonly isSameRevision: boolean;
    readonly workflowRecreation: WorkflowRecreationDiagnostic | undefined;
    readonly workflowRecreationAuthorityAuthorized: boolean;
  },
  RunnerActivationError
> =>
  Effect.gen(function* () {
    const snapshot = yield* validateStagedSnapshot(input.snapshot);
    if (input.previous) yield* validateStagedSnapshot(input.previous);
    const isSameRevision = yield* sameRevisionSnapshot(input.previous, snapshot);
    const transition = yield* prepareWorkflowTransition(input, snapshot, runtime, isSameRevision);
    return {
      snapshot,
      isSameRevision,
      workflowRecreation: transition.workflowRecreation,
      workflowRecreationAuthorityAuthorized: transition.authorityAuthorized,
    };
  });

const executeRunnerActivation = (
  input: RunnerActivationInput,
  state: RunnerActivationState,
): Effect.Effect<RunnerRevisionStatus, RunnerActivationError, StagedRunnerRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* StagedRunnerRuntime;
    const { snapshot, isSameRevision, workflowRecreation, workflowRecreationAuthorityAuthorized } =
      yield* prepareWorkflowActivation(input, runtime);
    state.workflowRecreation = workflowRecreation;
    state.workflowRecreationAuthorityAuthorized = workflowRecreationAuthorityAuthorized;
    state.workflowTransitionPhases = workflowRecreation?.phases;
    const selectedRoles = selectedRunnerRoles(input);
    let roles: ReadonlyArray<RunnerRole> = selectedRoles;
    if (input.previous && state.workflowRecreation === undefined)
      roles = affectedRunnerRoles(input.previous, snapshot, selectedRoles);
    state.roles = roles;
    if (isSameRevision && state.workflowRecreation === undefined) {
      yield* requireRunnerReadiness(runtime, snapshot.revision, roles);
      return statusForRevision(snapshot.revision, state.workflowRecreation);
    }
    if (!state.workflowRecreationAuthorityAuthorized)
      yield* authorizeRunnerActivation(input, snapshot, roles, runtime);
    const change = yield* prepareRunnerRevision(input, snapshot, runtime);
    if (state.workflowRecreation !== undefined)
      yield* withWorkflowRecreationTimeout(
        runtime.persistWorkflowRecreationDiagnostic(state.workflowRecreation),
        workflowRecreationTimeouts.providerOperation,
        () =>
          new SnapshotRuntimeError({
            reason: "workflow-recreation-diagnostic-persistence-unconfirmed",
          }),
      );
    yield* Effect.timeoutOrElse(runtime.activateComplete(snapshot.revision), {
      duration: stagedSourceActivationTimeouts.transportRequest,
      orElse: () =>
        Effect.fail(new SnapshotRuntimeError({ reason: "runner-activation-unconfirmed" })),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (state.workflowTransitionPhases !== undefined) {
            state.workflowTransitionPhases = {
              ...state.workflowTransitionPhases,
              activation: "activated",
            };
            if (state.workflowRecreation !== undefined)
              state.workflowRecreation = {
                ...state.workflowRecreation,
                phases: state.workflowTransitionPhases,
              };
          }
        }),
      ),
      Effect.tapError(() =>
        Effect.sync(() => {
          if (state.workflowTransitionPhases !== undefined) {
            state.workflowTransitionPhases = {
              ...state.workflowTransitionPhases,
              activation: "unconfirmed",
            };
            if (state.workflowRecreation !== undefined)
              state.workflowRecreation = {
                ...state.workflowRecreation,
                phases: state.workflowTransitionPhases,
              };
          }
        }),
      ),
    );
    state.activated = true;
    yield* restartRunnerRoles(runtime, snapshot.revision, change, roles);
    yield* requireRunnerReadiness(runtime, snapshot.revision, roles);
    return statusForRevision(snapshot.revision, state.workflowRecreation);
  });

/** Sequential supervisor operation. A failed phase never exposes a partial revision. */
export const activateRunnerSnapshot = (
  input: RunnerActivationInput,
): Effect.Effect<RunnerRevisionStatus, never, StagedRunnerRuntime> => {
  const state: RunnerActivationState = {
    roles: input.roles ?? ["ordinary-runner"],
    activated: false,
    workflowRecreation: undefined,
    workflowRecreationAuthorityAuthorized: false,
    workflowTransitionPhases: undefined,
  };
  return executeRunnerActivation(input, state).pipe(
    Effect.catch((reason) => Effect.succeed(failureStatus(input, state, reason))),
  );
};

/** Activate only the newest full snapshot from one save burst. */
export const activateCoalescedRunnerSnapshots = (input: {
  readonly snapshots: ReadonlyArray<StagedSourceSnapshot>;
  readonly previous: StagedSourceSnapshot | null;
  readonly owner: string;
  readonly nextOwner: string;
  readonly roles?: ReadonlyArray<RunnerRole>;
  readonly workflowTransition?: RunnerActivationInput["workflowTransition"];
}): Effect.Effect<RunnerRevisionStatus, never, StagedRunnerRuntime> => {
  const snapshot = coalesceSnapshotSaves(input.snapshots);
  if (snapshot === undefined) {
    const latest = input.snapshots.at(-1);
    return Effect.succeed({
      requestedRevision:
        latest !== undefined && typeof latest.revision === "string" ? latest.revision : "",
      activeRevision: input.previous?.revision ?? null,
      unavailableRoles: input.roles ?? ["ordinary-runner"],
      failure:
        latest === undefined
          ? "no-snapshot-requested"
          : (snapshotValidationReason(latest) ?? "invalid-snapshot-completion"),
    });
  }
  return activateRunnerSnapshot({ ...input, snapshot });
};
