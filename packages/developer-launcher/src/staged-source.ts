import { createHash } from "node:crypto";
import { Cause, Context, Effect, Layer, Schema } from "effect";
import {
  RunnerRevisionStatusSchema,
  RunnerRoleSchema,
  stagedSourceActivationTimeouts,
  stagedSourceDigestInput,
  validateStagedSourceSnapshot,
  StagedSourceFileSchema,
  StagedSourcePackageManifestSchema,
  StagedSourceSnapshotSchema,
  type RunnerRevisionStatus,
  type RunnerRole,
  type StagedSourceFile,
  type StagedSourceSnapshot,
} from "sheet-workflow-contracts";

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
  { reason: Schema.String },
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
};

type RunnerActivationState = {
  roles: ReadonlyArray<RunnerRole>;
  activated: boolean;
};

const statusForRevision = (revision: string): RunnerRevisionStatus => ({
  requestedRevision: revision,
  activeRevision: revision,
  unavailableRoles: [],
  failure: null,
});

const failureReason = (reason: RunnerActivationError) => reason.reason;

const failureStatus = (
  input: RunnerActivationInput,
  state: RunnerActivationState,
  reason: RunnerActivationError,
): RunnerRevisionStatus => ({
  requestedRevision: input.snapshot.revision,
  activeRevision: state.activated ? input.snapshot.revision : (input.previous?.revision ?? null),
  unavailableRoles: state.roles,
  failure: failureReason(reason),
});

const prepareRunnerRevision = (
  input: RunnerActivationInput,
  snapshot: StagedSourceSnapshot,
  runtime: StagedRunnerRuntimeApi,
): Effect.Effect<SnapshotChange, SnapshotRuntimeError> =>
  Effect.gen(function* () {
    yield* runtime.stageComplete(snapshot);
    yield* runtime.fenceOldOwner(input.owner, input.nextOwner);
    if (input.previous) yield* runtime.retainImmutableRevision(input.previous.revision);
    const change = input.previous ? classifySnapshotChange(input.previous, snapshot) : "artifact";
    if (change === "artifact") yield* runtime.rebuildArtifacts(snapshot.revision);
    return change;
  });

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

const executeRunnerActivation = (
  input: RunnerActivationInput,
  state: RunnerActivationState,
): Effect.Effect<RunnerRevisionStatus, RunnerActivationError, StagedRunnerRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* StagedRunnerRuntime;
    const snapshot = yield* validateStagedSnapshot(input.snapshot);
    if (input.previous) yield* validateStagedSnapshot(input.previous);
    const isSameRevision = yield* sameRevisionSnapshot(input.previous, snapshot);
    const roleOrder: ReadonlyArray<RunnerRole> = ["workflow-api", "ordinary-runner"];
    const selectedRoles = roleOrder.filter((role) =>
      (input.roles ?? ["ordinary-runner"]).includes(role),
    );
    const roles = input.previous
      ? affectedRunnerRoles(input.previous, snapshot, selectedRoles)
      : selectedRoles;
    state.roles = roles;
    if (isSameRevision) {
      yield* requireRunnerReadiness(runtime, snapshot.revision, roles);
      return statusForRevision(snapshot.revision);
    }
    const change = yield* prepareRunnerRevision(input, snapshot, runtime);
    yield* runtime.activateComplete(snapshot.revision);
    state.activated = true;
    yield* restartRunnerRoles(runtime, snapshot.revision, change, roles);
    yield* requireRunnerReadiness(runtime, snapshot.revision, roles);
    return statusForRevision(snapshot.revision);
  });

/** Sequential supervisor operation. A failed phase never exposes a partial revision. */
export const activateRunnerSnapshot = (
  input: RunnerActivationInput,
): Effect.Effect<RunnerRevisionStatus, never, StagedRunnerRuntime> => {
  const state: RunnerActivationState = {
    roles: input.roles ?? ["ordinary-runner"],
    activated: false,
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
