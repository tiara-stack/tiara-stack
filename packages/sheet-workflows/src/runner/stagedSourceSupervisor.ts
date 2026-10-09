import { createHash, randomUUID } from "node:crypto";
import {
  Cause,
  Context,
  Duration,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Path,
  Predicate,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  Headers,
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  StagedRunnerSnapshotActivationRequestSchema,
  StagedRunnerSnapshotIdentitySchema,
  StagedSourceSnapshotSchema,
  stagedSourceDigestInput,
  stagedSourceActivationTimeouts,
  validateStagedSourceSnapshot,
  type RunnerRevisionStatus,
  type StagedRunnerSnapshotActivationRequest,
  type StagedRunnerSnapshotIdentity,
  type StagedSourceSnapshot,
} from "sheet-workflow-contracts";

export class RunnerSourceSupervisorError extends Schema.TaggedErrorClass<RunnerSourceSupervisorError>()(
  "RunnerSourceSupervisorError",
  { reason: Schema.String },
) {}

export class RunnerSourceCapacityError extends Schema.TaggedErrorClass<RunnerSourceCapacityError>()(
  "RunnerSourceCapacityError",
  { reason: Schema.Literal("staged-storage-capacity-exceeded") },
) {}

class RunnerSourceRequestBodyError extends Schema.TaggedErrorClass<RunnerSourceRequestBodyError>()(
  "RunnerSourceRequestBodyError",
  {
    reason: Schema.Literals([
      "payload-too-large",
      "invalid-content-length",
      "invalid-request-body",
      "request-timeout",
    ]),
  },
) {}

export interface RunnerSourceProcessControllerApi {
  /** Must be an upper bound for the prepared tree, including offline dependency links/copies. */
  readonly estimatePreparedSnapshotBytes: (
    snapshot: StagedSourceSnapshot,
  ) => Effect.Effect<number, RunnerSourceSupervisorError>;
  /** True only when settlement/reference evidence proves this revision is safe to prune. */
  readonly isRevisionSafelyReclaimable?: (input: {
    readonly identity: StagedRunnerSnapshotIdentity;
    readonly revision: string;
    readonly digest: string;
  }) => Effect.Effect<boolean, RunnerSourceSupervisorError>;
  readonly restart: (input: {
    readonly identity: StagedRunnerSnapshotIdentity;
    readonly sourceRoot: string | null;
    readonly revision: string | null;
  }) => Effect.Effect<void, RunnerSourceSupervisorError>;
  readonly verifyReadiness: (input: {
    readonly identity: StagedRunnerSnapshotIdentity;
    readonly revision: string;
  }) => Effect.Effect<boolean, RunnerSourceSupervisorError>;
}

export class RunnerSourceProcessController extends Context.Service<
  RunnerSourceProcessController,
  RunnerSourceProcessControllerApi
>()("sheet-workflows/RunnerSourceProcessController") {}

export interface RunnerSourceRuntimeApi {
  /** Must be an upper bound for the prepared tree, including offline dependency links/copies. */
  readonly estimatePreparedSnapshotBytes: RunnerSourceProcessControllerApi["estimatePreparedSnapshotBytes"];
  /** False, missing, or failed evidence retains the revision. */
  readonly isRevisionSafelyReclaimable?: RunnerSourceProcessControllerApi["isRevisionSafelyReclaimable"];
  readonly prepareSnapshot: (
    sourceRoot: string,
  ) => Effect.Effect<void, RunnerSourceSupervisorError>;
  readonly restart: RunnerSourceProcessControllerApi["restart"];
  readonly verifyReadiness: RunnerSourceProcessControllerApi["verifyReadiness"];
}

export class RunnerSourceRuntime extends Context.Service<
  RunnerSourceRuntime,
  RunnerSourceRuntimeApi
>()("sheet-workflows/RunnerSourceRuntime") {}

const withRunnerSourceTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  timeout: Duration.Input,
  reason: string,
): Effect.Effect<A, E | RunnerSourceSupervisorError, R> =>
  effect.pipe(
    Effect.timeout(timeout),
    Effect.mapError((error) =>
      Cause.isTimeoutError(error) ? new RunnerSourceSupervisorError({ reason }) : error,
    ),
  );

const pnpmRunnerSourceInstallCommands = [
  [
    "install",
    "--offline",
    "--frozen-lockfile",
    "--frozen-store",
    "--filter",
    "sheet-workflows...",
    "--prod",
    "--ignore-scripts",
  ],
  ["rebuild", "--pending", "--filter", "sheet-workflows..."],
] as const;

/** Runs the pinned pnpm contract and delegates process lifecycle to the owning supervisor. */
export const RunnerSourceRuntimeLive = Layer.effect(
  RunnerSourceRuntime,
  Effect.gen(function* () {
    const processes = yield* RunnerSourceProcessController;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return {
      estimatePreparedSnapshotBytes: processes.estimatePreparedSnapshotBytes,
      isRevisionSafelyReclaimable: processes.isRevisionSafelyReclaimable,
      prepareSnapshot: (sourceRoot) =>
        Effect.forEach(
          pnpmRunnerSourceInstallCommands,
          (args) =>
            spawner
              .exitCode(
                ChildProcess.make("pnpm", args, {
                  cwd: sourceRoot,
                  stdout: "ignore",
                  stderr: "ignore",
                  env: {
                    COREPACK_ENABLE_PROJECT_SPEC: "0",
                    pnpm_config_pm_on_fail: "ignore",
                    pnpm_config_store_dir: "/pnpm/store",
                    pnpm_config_side_effects_cache_readonly: "true",
                  },
                  extendEnv: true,
                }),
              )
              .pipe(
                Effect.mapError(
                  () => new RunnerSourceSupervisorError({ reason: "offline-install-failed" }),
                ),
                Effect.flatMap((exitCode) =>
                  Number(exitCode) === 0
                    ? Effect.void
                    : Effect.fail(
                        new RunnerSourceSupervisorError({
                          reason: "offline-store-miss-or-install-failed",
                        }),
                      ),
                ),
              ),
          { concurrency: 1, discard: true },
        ),
      restart: processes.restart,
      verifyReadiness: processes.verifyReadiness,
    } satisfies RunnerSourceRuntimeApi;
  }),
);

export interface RunnerSourceSupervisorApi {
  readonly activate: (
    input: StagedRunnerSnapshotActivationRequest,
  ) => Effect.Effect<RunnerRevisionStatus>;
  readonly readiness: (
    identity: StagedRunnerSnapshotIdentity,
  ) => Effect.Effect<RunnerRevisionStatus>;
}

export class RunnerSourceSupervisor extends Context.Service<
  RunnerSourceSupervisor,
  RunnerSourceSupervisorApi
>()("sheet-workflows/RunnerSourceSupervisor") {}

export interface RunnerSourceSnapshotAuthorizerApi {
  /** Authenticates the request headers and returns the runner identity bound to them. */
  readonly authorize: (input: {
    readonly headers: Headers.Headers;
  }) => Effect.Effect<StagedRunnerSnapshotIdentity, RunnerSourceSupervisorError>;
}

/** The live session authority must provide this service before the route can be mounted. */
export class RunnerSourceSnapshotAuthorizer extends Context.Service<
  RunnerSourceSnapshotAuthorizer,
  RunnerSourceSnapshotAuthorizerApi
>()("sheet-workflows/RunnerSourceSnapshotAuthorizer") {}

type ActiveSnapshot = {
  readonly revision: string;
  readonly digest: string;
  readonly unavailableReason: string | null;
};

const canonicalRunnerIdentityTuple = (identity: StagedRunnerSnapshotIdentity) =>
  [identity.sessionId, identity.generation, identity.role] as const;

const identityKey = (identity: StagedRunnerSnapshotIdentity) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalRunnerIdentityTuple(identity)))
    .digest("hex");

const sameRunnerIdentity = (
  left: StagedRunnerSnapshotIdentity,
  right: StagedRunnerSnapshotIdentity,
) =>
  left.sessionId === right.sessionId &&
  left.generation === right.generation &&
  left.role === right.role;

export const runnerSourceIdentityKey = identityKey;

export const runnerSourceRevisionKey = (
  identity: StagedRunnerSnapshotIdentity,
  revision: string,
  digest: string,
) =>
  createHash("sha256")
    .update(JSON.stringify([canonicalRunnerIdentityTuple(identity), revision, digest]))
    .digest("hex");

const safeRoots = (
  stagedRoot: string,
  activeRoot: string,
  workspaceRoot: string,
  path: Path.Path,
) => {
  const staged = path.resolve(stagedRoot);
  const active = path.resolve(activeRoot);
  const workspace = path.resolve(workspaceRoot);
  const beneathWorkspace = (candidate: string) => {
    const relative = path.relative(workspace, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const stagedPrefix = `${staged}${path.sep}`;
  const activePrefix = `${active}${path.sep}`;
  if (
    !path.isAbsolute(staged) ||
    !path.isAbsolute(active) ||
    !beneathWorkspace(staged) ||
    !beneathWorkspace(active) ||
    staged === active ||
    staged.startsWith(activePrefix) ||
    active.startsWith(stagedPrefix)
  )
    return Effect.fail(new RunnerSourceSupervisorError({ reason: "unsafe-source-roots" }));
  return Effect.succeed({ staged, active });
};

const snapshotFilesDigest = (snapshot: StagedSourceSnapshot) =>
  createHash("sha256")
    .update(stagedSourceDigestInput(snapshot.revision, snapshot.files))
    .digest("hex");

const maximumStagedStorageBytes = 1536 * 1024 * 1024;
const metadataReserveBytes = 4096;

const StagedRevisionMetadataSchema = Schema.Struct({
  identity: StagedRunnerSnapshotIdentitySchema,
  revision: Schema.NonEmptyString,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  revisionDirectory: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  estimatedStorageBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
type StagedRevisionMetadata = typeof StagedRevisionMetadataSchema.Type;

type StoredRevision = {
  readonly metadata: StagedRevisionMetadata;
  readonly sourceRoot: string;
  readonly metadataPath: string;
  readonly isCurrent: boolean;
};

type StagedStorageInventory = {
  readonly revisions: ReadonlyArray<StoredRevision>;
  readonly usedBytes: number;
  readonly hasUnknownEntries: boolean;
};

const validateSnapshot = (
  input: unknown,
): Effect.Effect<StagedSourceSnapshot, RunnerSourceSupervisorError> =>
  Schema.decodeUnknownEffect(StagedSourceSnapshotSchema)(input).pipe(
    Effect.mapError(() => new RunnerSourceSupervisorError({ reason: "invalid-snapshot-schema" })),
    Effect.flatMap((snapshot) => {
      const reason = validateStagedSourceSnapshot(snapshot, snapshotFilesDigest(snapshot));
      return reason === undefined
        ? Effect.succeed(snapshot)
        : Effect.fail(new RunnerSourceSupervisorError({ reason }));
    }),
  );

const failedStatus = (
  requestedRevision: string,
  previous: ActiveSnapshot | undefined,
  failure: string,
): RunnerRevisionStatus => ({
  requestedRevision,
  activeRevision: previous?.revision ?? null,
  unavailableRoles: ["ordinary-runner"],
  failure,
});

type RunnerSourceSupervisorDependencies = {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly runtime: RunnerSourceRuntimeApi;
  readonly roots: { readonly staged: string; readonly active: string };
  readonly activeSnapshots: Ref.Ref<ReadonlyMap<string, ActiveSnapshot>>;
  readonly maxStagedStorageBytes: number;
};

type SnapshotPaths = {
  readonly stageParent: string;
  readonly identityKey: string;
  readonly revisionDirectory: string;
  readonly metadataPath: string;
  readonly sourceRoot: string;
  readonly temporaryRoot: string;
  readonly activeDirectory: string;
  readonly activeLink: string;
  readonly nextLink: string;
};

const snapshotPathsFor = (
  dependencies: RunnerSourceSupervisorDependencies,
  identity: StagedRunnerSnapshotIdentity,
  snapshot: StagedSourceSnapshot,
): SnapshotPaths => {
  const { path, roots } = dependencies;
  const key = identityKey(identity);
  const revisionKey = runnerSourceRevisionKey(
    identity,
    snapshot.revision,
    snapshot.completion.filesDigest,
  );
  const stageParent = path.join(roots.staged, key);
  const activeDirectory = path.join(roots.active, key);
  return {
    stageParent,
    identityKey: key,
    revisionDirectory: revisionKey,
    metadataPath: path.join(stageParent, `.${revisionKey}.metadata.json`),
    sourceRoot: path.join(stageParent, revisionKey),
    temporaryRoot: path.join(stageParent, `.staging-${randomUUID()}`),
    activeDirectory,
    activeLink: path.join(activeDirectory, "current"),
    nextLink: path.join(activeDirectory, `.current-${randomUUID()}`),
  };
};

const isStorageKey = (name: string) => /^[a-f0-9]{64}$/.test(name);
const metadataFileName = /^\.([a-f0-9]{64})\.metadata\.json$/;

const capacityFailure = () =>
  new RunnerSourceCapacityError({ reason: "staged-storage-capacity-exceeded" });

/** Runs under the activation permit, so these temporary trees cannot belong to in-flight work. */
const cleanupAbandonedStagingDirectories = (
  dependencies: RunnerSourceSupervisorDependencies,
): Effect.Effect<void, RunnerSourceCapacityError> =>
  Effect.gen(function* () {
    const { fileSystem, path, roots } = dependencies;
    if (!(yield* fileSystem.exists(roots.staged))) return;
    const parents = yield* fileSystem.readDirectory(roots.staged);
    for (const parentName of parents) {
      if (!isStorageKey(parentName)) continue;
      const parent = path.join(roots.staged, parentName);
      const entries = yield* fileSystem.readDirectory(parent);
      for (const entry of entries) {
        if (!entry.startsWith(".staging-")) continue;
        yield* fileSystem.remove(path.join(parent, entry), { recursive: true, force: true });
      }
    }
  }).pipe(Effect.mapError(() => capacityFailure()));

const currentTargetForIdentity = (
  dependencies: RunnerSourceSupervisorDependencies,
  key: string,
): Effect.Effect<
  { readonly target: string | undefined; readonly unknown: boolean },
  RunnerSourceCapacityError
> =>
  Effect.gen(function* () {
    const { fileSystem, path, roots } = dependencies;
    const activeDirectory = path.join(roots.active, key);
    const activeLink = path.join(activeDirectory, "current");
    const exists = yield* Effect.result(fileSystem.exists(activeLink));
    if (exists._tag === "Failure") return { target: undefined, unknown: true };
    if (!exists.success) return { target: undefined, unknown: false };
    const link = yield* Effect.result(fileSystem.readLink(activeLink));
    return link._tag === "Failure"
      ? { target: undefined, unknown: true }
      : { target: path.resolve(activeDirectory, link.success), unknown: false };
  }).pipe(Effect.mapError(() => capacityFailure()));

const decodeStoredRevisionMetadata = (content: string): StagedRevisionMetadata | undefined => {
  try {
    return Schema.decodeUnknownSync(StagedRevisionMetadataSchema)(JSON.parse(content));
  } catch {
    return undefined;
  }
};

const isMetadataForStorageEntry = (
  metadata: StagedRevisionMetadata | undefined,
  identityHash: string,
  revisionDirectory: string,
): metadata is StagedRevisionMetadata =>
  metadata !== undefined &&
  metadata.revisionDirectory === revisionDirectory &&
  Number.isSafeInteger(metadata.estimatedStorageBytes) &&
  identityKey(metadata.identity) === identityHash &&
  runnerSourceRevisionKey(metadata.identity, metadata.revision, metadata.digest) ===
    revisionDirectory;

type LoadedRevisionMetadata = {
  readonly metadata: ReadonlyMap<string, StagedRevisionMetadata>;
  readonly hasUnknownEntries: boolean;
};

const readRevisionMetadata = (
  dependencies: RunnerSourceSupervisorDependencies,
  identityHash: string,
  stageParent: string,
  entries: ReadonlyArray<string>,
  directories: ReadonlySet<string>,
): Effect.Effect<LoadedRevisionMetadata, RunnerSourceCapacityError> =>
  Effect.gen(function* () {
    const metadata = new Map<string, StagedRevisionMetadata>();
    let hasUnknownEntries = false;
    for (const entry of entries) {
      const fileName = metadataFileName.exec(entry);
      if (fileName === null) {
        if (!isStorageKey(entry) && !entry.startsWith(".staging-")) hasUnknownEntries = true;
        continue;
      }
      const revisionDirectory = fileName[1];
      if (revisionDirectory === undefined) {
        hasUnknownEntries = true;
        continue;
      }
      const metadataPath = dependencies.path.join(stageParent, entry);
      if (!directories.has(revisionDirectory)) {
        yield* dependencies.fileSystem
          .remove(metadataPath, { force: true })
          .pipe(Effect.mapError(() => capacityFailure()));
        continue;
      }
      const contents = yield* Effect.result(dependencies.fileSystem.readFileString(metadataPath));
      const decoded =
        contents._tag === "Success" ? decodeStoredRevisionMetadata(contents.success) : undefined;
      if (!isMetadataForStorageEntry(decoded, identityHash, revisionDirectory)) {
        hasUnknownEntries = true;
        continue;
      }
      metadata.set(revisionDirectory, decoded);
    }
    return { metadata, hasUnknownEntries };
  }).pipe(Effect.mapError(() => capacityFailure()));

const storedRevisionsFromDirectory = (input: {
  readonly path: Path.Path;
  readonly stageParent: string;
  readonly revisionDirectories: ReadonlySet<string>;
  readonly metadata: ReadonlyMap<string, StagedRevisionMetadata>;
  readonly currentTarget: string | undefined;
  readonly currentTargetUnknown: boolean;
  readonly activeInMemory: ActiveSnapshot | undefined;
}): { readonly revisions: ReadonlyArray<StoredRevision>; readonly hasUnknownEntries: boolean } => {
  let hasUnknownEntries = false;
  const revisions = [...input.revisionDirectories]
    .sort()
    .flatMap((revisionDirectory): Array<StoredRevision> => {
      const decoded = input.metadata.get(revisionDirectory);
      if (decoded === undefined) {
        hasUnknownEntries = true;
        return [];
      }
      const sourceRoot = input.path.join(input.stageParent, revisionDirectory);
      return [
        {
          metadata: decoded,
          sourceRoot,
          metadataPath: input.path.join(input.stageParent, `.${revisionDirectory}.metadata.json`),
          isCurrent:
            input.currentTargetUnknown ||
            input.currentTarget === sourceRoot ||
            (input.activeInMemory?.revision === decoded.revision &&
              input.activeInMemory.digest === decoded.digest),
        },
      ];
    });
  if (
    input.currentTarget !== undefined &&
    !revisions.some((revision) => revision.sourceRoot === input.currentTarget)
  )
    hasUnknownEntries = true;
  return { revisions, hasUnknownEntries };
};

const readIdentityStorage = (
  dependencies: RunnerSourceSupervisorDependencies,
  key: string,
): Effect.Effect<StagedStorageInventory, RunnerSourceCapacityError> =>
  Effect.gen(function* () {
    const { fileSystem, path, roots } = dependencies;
    const stageParent = path.join(roots.staged, key);
    const entries = yield* fileSystem.readDirectory(stageParent);
    const currentTarget = yield* currentTargetForIdentity(dependencies, key);
    const directories = new Set(entries.filter(isStorageKey));
    const loadedMetadata = yield* readRevisionMetadata(
      dependencies,
      key,
      stageParent,
      entries,
      directories,
    );
    const activeInMemory = (yield* Ref.get(dependencies.activeSnapshots)).get(key);
    const stored = storedRevisionsFromDirectory({
      path,
      stageParent,
      revisionDirectories: directories,
      metadata: loadedMetadata.metadata,
      currentTarget: currentTarget.target,
      currentTargetUnknown: currentTarget.unknown,
      activeInMemory,
    });
    const revisions = stored.revisions;
    const usedBytes = revisions.reduce(
      (sum, revision) => sum + revision.metadata.estimatedStorageBytes + metadataReserveBytes,
      0,
    );
    const hasUnknownEntries =
      currentTarget.unknown ||
      loadedMetadata.hasUnknownEntries ||
      stored.hasUnknownEntries ||
      !Number.isSafeInteger(usedBytes);
    return { revisions, usedBytes, hasUnknownEntries };
  }).pipe(Effect.mapError(() => capacityFailure()));

const readStagedStorage = (
  dependencies: RunnerSourceSupervisorDependencies,
): Effect.Effect<StagedStorageInventory, RunnerSourceCapacityError> =>
  Effect.gen(function* () {
    const { fileSystem, path, roots } = dependencies;
    if (!(yield* fileSystem.exists(roots.staged)))
      return { revisions: [], usedBytes: 0, hasUnknownEntries: false };
    const parents = yield* fileSystem.readDirectory(roots.staged);
    const revisions: Array<StoredRevision> = [];
    let usedBytes = 0;
    let hasUnknownEntries = false;
    for (const parentName of parents) {
      if (!isStorageKey(parentName)) {
        hasUnknownEntries = true;
        continue;
      }
      const parent = path.join(roots.staged, parentName);
      const inventory = yield* readIdentityStorage(dependencies, parentName);
      revisions.push(...inventory.revisions);
      usedBytes += inventory.usedBytes;
      hasUnknownEntries ||= inventory.hasUnknownEntries;
      if (!(yield* fileSystem.exists(parent))) hasUnknownEntries = true;
    }
    return { revisions, usedBytes, hasUnknownEntries };
  }).pipe(Effect.mapError(() => capacityFailure()));

const isSafelyPrunableRevision = (
  runtime: RunnerSourceRuntimeApi,
  revision: StoredRevision,
): Effect.Effect<boolean> => {
  if (revision.isCurrent || runtime.isRevisionSafelyReclaimable === undefined)
    return Effect.succeed(false);
  return runtime
    .isRevisionSafelyReclaimable({
      identity: revision.metadata.identity,
      revision: revision.metadata.revision,
      digest: revision.metadata.digest,
    })
    .pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: (isSafeToReclaim) => isSafeToReclaim,
      }),
    );
};

const pruneStoredRevision = (
  fileSystem: FileSystem.FileSystem,
  revision: StoredRevision,
): Effect.Effect<void, RunnerSourceCapacityError> =>
  fileSystem.remove(revision.sourceRoot, { recursive: true, force: true }).pipe(
    Effect.flatMap(() => fileSystem.remove(revision.metadataPath, { force: true })),
    Effect.mapError(() => capacityFailure()),
  );

const overCapacity = (projectedBytes: number, limitBytes: number) =>
  projectedBytes > limitBytes || !Number.isSafeInteger(projectedBytes);

const pruneSettledRevisionsForCapacity = (
  dependencies: RunnerSourceSupervisorDependencies,
  identity: StagedRunnerSnapshotIdentity,
  snapshot: StagedSourceSnapshot,
  paths: SnapshotPaths,
  estimatedBytes: number,
): Effect.Effect<void, RunnerSourceCapacityError> =>
  Effect.gen(function* () {
    const { fileSystem, runtime, maxStagedStorageBytes } = dependencies;
    const inventory = yield* readStagedStorage(dependencies);
    if (inventory.hasUnknownEntries) return yield* Effect.fail(capacityFailure());

    const targetAlreadyStaged = yield* fileSystem
      .exists(paths.sourceRoot)
      .pipe(Effect.mapError(() => capacityFailure()));
    const incomingBytes = targetAlreadyStaged ? 0 : estimatedBytes + metadataReserveBytes;
    let projectedBytes = inventory.usedBytes + incomingBytes;
    if (!overCapacity(projectedBytes, maxStagedStorageBytes)) return;

    for (const revision of inventory.revisions) {
      if (!overCapacity(projectedBytes, maxStagedStorageBytes)) break;
      if (!(yield* isSafelyPrunableRevision(runtime, revision))) continue;
      yield* pruneStoredRevision(fileSystem, revision);
      projectedBytes -= revision.metadata.estimatedStorageBytes + metadataReserveBytes;
    }

    if (overCapacity(projectedBytes, maxStagedStorageBytes))
      return yield* Effect.fail(capacityFailure());
    return yield* Effect.void;
  });

const prepareStagedStorage = (
  dependencies: RunnerSourceSupervisorDependencies,
  identity: StagedRunnerSnapshotIdentity,
  snapshot: StagedSourceSnapshot,
  paths: SnapshotPaths,
): Effect.Effect<number, RunnerSourceCapacityError> =>
  Effect.gen(function* () {
    yield* cleanupAbandonedStagingDirectories(dependencies);
    const estimated = yield* Effect.result(
      dependencies.runtime.estimatePreparedSnapshotBytes(snapshot),
    );
    if (
      estimated._tag === "Failure" ||
      !Number.isSafeInteger(estimated.success) ||
      estimated.success < 0 ||
      estimated.success + metadataReserveBytes > dependencies.maxStagedStorageBytes
    )
      return yield* Effect.fail(capacityFailure());
    yield* pruneSettledRevisionsForCapacity(
      dependencies,
      identity,
      snapshot,
      paths,
      estimated.success,
    );
    return estimated.success;
  });

const stageSnapshot = (
  dependencies: RunnerSourceSupervisorDependencies,
  identity: StagedRunnerSnapshotIdentity,
  snapshot: StagedSourceSnapshot,
  paths: SnapshotPaths,
  estimatedStorageBytes: number,
): Effect.Effect<void, RunnerSourceSupervisorError> => {
  const { fileSystem, path, runtime } = dependencies;
  return Effect.gen(function* () {
    if (yield* fileSystem.exists(paths.sourceRoot)) return yield* Effect.void;
    yield* fileSystem.makeDirectory(paths.temporaryRoot, { recursive: true });
    yield* Effect.forEach(
      snapshot.files,
      (file) =>
        Effect.gen(function* () {
          const destination = path.resolve(paths.temporaryRoot, file.path);
          const relative = path.relative(paths.temporaryRoot, destination);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            return yield* Effect.fail(
              new RunnerSourceSupervisorError({ reason: "excluded-or-unsafe-path" }),
            );
          yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
          const bytes =
            file.contentEncoding === "base64"
              ? Buffer.from(file.content, "base64")
              : Buffer.from(file.content, "utf8");
          yield* fileSystem.writeFile(destination, bytes, { mode: file.mode });
          yield* fileSystem.chmod(destination, file.mode);
        }),
      { concurrency: 1, discard: true },
    );
    yield* withRunnerSourceTimeout(
      runtime.prepareSnapshot(paths.temporaryRoot),
      stagedSourceActivationTimeouts.preparation,
      "snapshot-preparation-timeout",
    );
    yield* fileSystem.makeDirectory(paths.stageParent, { recursive: true });
    if (yield* fileSystem.exists(paths.sourceRoot))
      return yield* fileSystem.remove(paths.temporaryRoot, { recursive: true, force: true });
    const metadata: StagedRevisionMetadata = {
      identity,
      revision: snapshot.revision,
      digest: snapshot.completion.filesDigest,
      revisionDirectory: paths.revisionDirectory,
      estimatedStorageBytes,
    };
    yield* fileSystem.writeFileString(paths.metadataPath, JSON.stringify(metadata));
    yield* fileSystem.rename(paths.temporaryRoot, paths.sourceRoot);
  }).pipe(
    Effect.mapError((error) =>
      error instanceof RunnerSourceSupervisorError
        ? error
        : new RunnerSourceSupervisorError({ reason: "snapshot-stage-failed" }),
    ),
  );
};

type PromotionResult =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly failure: string;
      readonly active: ActiveSnapshot | undefined;
    };

const promoteSnapshot = (
  dependencies: RunnerSourceSupervisorDependencies,
  identity: StagedRunnerSnapshotIdentity,
  snapshot: StagedSourceSnapshot,
  paths: SnapshotPaths,
  previous: ActiveSnapshot | undefined,
): Effect.Effect<PromotionResult> => {
  const { fileSystem, path, runtime } = dependencies;
  return Effect.gen(function* () {
    const previousTargetResult = yield* Effect.result(
      Effect.gen(function* () {
        const exists = yield* fileSystem.exists(paths.activeLink);
        return exists ? yield* fileSystem.readLink(paths.activeLink) : undefined;
      }),
    );
    if (previousTargetResult._tag === "Failure")
      return {
        ready: false,
        failure: "active-pointer-read-failed",
        active: undefined,
      } satisfies PromotionResult;
    const previousTarget = previousTargetResult.success;
    const requestedTarget = path.relative(paths.activeDirectory, paths.sourceRoot);
    const activation = yield* Effect.result(
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(paths.activeDirectory, { recursive: true });
        yield* fileSystem.symlink(requestedTarget, paths.nextLink);
        yield* fileSystem.rename(paths.nextLink, paths.activeLink);
        yield* withRunnerSourceTimeout(
          runtime.restart({
            identity,
            sourceRoot: paths.activeLink,
            revision: snapshot.revision,
          }),
          stagedSourceActivationTimeouts.restart,
          "runner-restart-timeout",
        );
        const ready = yield* withRunnerSourceTimeout(
          runtime.verifyReadiness({ identity, revision: snapshot.revision }),
          stagedSourceActivationTimeouts.readiness,
          "runner-readiness-timeout",
        );
        if (!ready)
          return yield* Effect.fail(
            new RunnerSourceSupervisorError({ reason: "readiness-check-failed" }),
          );
      }),
    );
    if (activation._tag === "Success") return { ready: true } satisfies PromotionResult;

    yield* fileSystem.remove(paths.nextLink, { force: true }).pipe(Effect.catch(() => Effect.void));
    const activeTargetResult = yield* Effect.result(
      Effect.gen(function* () {
        const exists = yield* fileSystem.exists(paths.activeLink);
        return exists ? yield* fileSystem.readLink(paths.activeLink) : undefined;
      }),
    );
    const activationError =
      activation.failure instanceof RunnerSourceSupervisorError
        ? activation.failure.reason
        : "activation-failed";
    const active =
      activeTargetResult._tag === "Success" && activeTargetResult.success === requestedTarget
        ? { revision: snapshot.revision, digest: snapshot.completion.filesDigest }
        : activeTargetResult._tag === "Success" && activeTargetResult.success === previousTarget
          ? previous
          : undefined;
    return {
      ready: false,
      failure: activationError,
      active: active === undefined ? undefined : { ...active, unavailableReason: activationError },
    } satisfies PromotionResult;
  });
};

const readinessStatus = (
  runtime: RunnerSourceRuntimeApi,
  identity: StagedRunnerSnapshotIdentity,
  active: ActiveSnapshot | undefined,
): Effect.Effect<RunnerRevisionStatus> =>
  Effect.gen(function* () {
    if (active === undefined)
      return {
        requestedRevision: "",
        activeRevision: null,
        unavailableRoles: ["ordinary-runner"],
        failure: "no-active-revision",
      } satisfies RunnerRevisionStatus;
    if (active.unavailableReason !== null)
      return {
        requestedRevision: active.revision,
        activeRevision: active.revision,
        unavailableRoles: ["ordinary-runner"],
        failure: active.unavailableReason,
      } satisfies RunnerRevisionStatus;
    const ready = yield* withRunnerSourceTimeout(
      runtime.verifyReadiness({ identity, revision: active.revision }),
      stagedSourceActivationTimeouts.readiness,
      "runner-readiness-timeout",
    ).pipe(Effect.catch(() => Effect.succeed(false)));
    return {
      requestedRevision: active.revision,
      activeRevision: active.revision,
      unavailableRoles: ready ? [] : ["ordinary-runner"],
      failure: ready ? null : "readiness-check-failed",
    } satisfies RunnerRevisionStatus;
  });

const setActiveSnapshot = (
  dependencies: RunnerSourceSupervisorDependencies,
  key: string,
  active: ActiveSnapshot | undefined,
) =>
  Ref.update(dependencies.activeSnapshots, (current) => {
    const next = new Map(current);
    if (active === undefined) next.delete(key);
    else next.set(key, active);
    return next;
  });

const markSnapshotUnavailable = (
  dependencies: RunnerSourceSupervisorDependencies,
  key: string,
  active: ActiveSnapshot | undefined,
  reason: string,
) =>
  active === undefined
    ? Effect.void
    : setActiveSnapshot(dependencies, key, { ...active, unavailableReason: reason });

const rejectInvalidSnapshot = (
  dependencies: RunnerSourceSupervisorDependencies,
  request: StagedRunnerSnapshotActivationRequest,
  key: string,
  active: ActiveSnapshot | undefined,
  reason: string,
): Effect.Effect<RunnerRevisionStatus> =>
  markSnapshotUnavailable(dependencies, key, active, reason).pipe(
    Effect.as(failedStatus(request.snapshot.revision, active, reason)),
  );

const activateCurrentSnapshot = (
  dependencies: RunnerSourceSupervisorDependencies,
  identity: StagedRunnerSnapshotIdentity,
  snapshot: StagedSourceSnapshot,
  key: string,
  active: ActiveSnapshot,
): Effect.Effect<RunnerRevisionStatus> => {
  if (active.digest !== snapshot.completion.filesDigest)
    return Effect.succeed(failedStatus(snapshot.revision, active, "revision-content-conflict"));
  return Effect.gen(function* () {
    if (active.unavailableReason !== null) {
      const paths = snapshotPathsFor(dependencies, identity, snapshot);
      const restarted = yield* Effect.result(
        withRunnerSourceTimeout(
          dependencies.runtime.restart({
            identity,
            sourceRoot: paths.activeLink,
            revision: snapshot.revision,
          }),
          stagedSourceActivationTimeouts.restart,
          "runner-restart-timeout",
        ),
      );
      if (restarted._tag === "Failure") {
        const unavailable = { ...active, unavailableReason: restarted.failure.reason };
        yield* setActiveSnapshot(dependencies, key, unavailable);
        return failedStatus(snapshot.revision, unavailable, restarted.failure.reason);
      }
    }
    const ready = yield* withRunnerSourceTimeout(
      dependencies.runtime.verifyReadiness({ identity, revision: snapshot.revision }),
      stagedSourceActivationTimeouts.readiness,
      "runner-readiness-timeout",
    ).pipe(Effect.catch(() => Effect.succeed(false)));
    const recovered = {
      ...active,
      unavailableReason: ready ? null : "readiness-check-failed",
    };
    yield* setActiveSnapshot(dependencies, key, recovered);
    return {
      requestedRevision: snapshot.revision,
      activeRevision: snapshot.revision,
      unavailableRoles: ready ? [] : ["ordinary-runner"],
      failure: ready ? null : recovered.unavailableReason,
    } satisfies RunnerRevisionStatus;
  });
};

const failedStageStatus = (
  dependencies: RunnerSourceSupervisorDependencies,
  key: string,
  snapshot: StagedSourceSnapshot,
  paths: SnapshotPaths,
  active: ActiveSnapshot | undefined,
  reason: string,
): Effect.Effect<RunnerRevisionStatus> =>
  Effect.gen(function* () {
    yield* dependencies.fileSystem
      .remove(paths.temporaryRoot, { recursive: true, force: true })
      .pipe(Effect.catch(() => Effect.void));
    yield* markSnapshotUnavailable(dependencies, key, active, reason);
    return failedStatus(snapshot.revision, active, reason);
  });

const failedPromotionStatus = (
  dependencies: RunnerSourceSupervisorDependencies,
  key: string,
  snapshot: StagedSourceSnapshot,
  promotion: Extract<PromotionResult, { readonly ready: false }>,
): Effect.Effect<RunnerRevisionStatus> =>
  setActiveSnapshot(dependencies, key, promotion.active).pipe(
    Effect.as(failedStatus(snapshot.revision, promotion.active, promotion.failure)),
  );

const stageAndPromoteSnapshot = (
  dependencies: RunnerSourceSupervisorDependencies,
  request: StagedRunnerSnapshotActivationRequest,
  snapshot: StagedSourceSnapshot,
  key: string,
  active: ActiveSnapshot | undefined,
): Effect.Effect<RunnerRevisionStatus> =>
  Effect.gen(function* () {
    const paths = snapshotPathsFor(dependencies, request.identity, snapshot);
    const storage = yield* Effect.result(
      prepareStagedStorage(dependencies, request.identity, snapshot, paths),
    );
    if (storage._tag === "Failure") {
      yield* markSnapshotUnavailable(dependencies, key, active, storage.failure.reason);
      return failedStatus(snapshot.revision, active, storage.failure.reason);
    }
    const staged = yield* Effect.result(
      stageSnapshot(dependencies, request.identity, snapshot, paths, storage.success),
    );
    if (staged._tag === "Failure")
      return yield* failedStageStatus(
        dependencies,
        key,
        snapshot,
        paths,
        active,
        staged.failure.reason,
      );
    const promotion = yield* promoteSnapshot(
      dependencies,
      request.identity,
      snapshot,
      paths,
      active,
    );
    if (!promotion.ready)
      return yield* failedPromotionStatus(dependencies, key, snapshot, promotion);
    yield* setActiveSnapshot(dependencies, key, {
      revision: snapshot.revision,
      digest: snapshot.completion.filesDigest,
      unavailableReason: null,
    });
    return {
      requestedRevision: snapshot.revision,
      activeRevision: snapshot.revision,
      unavailableRoles: [],
      failure: null,
    } satisfies RunnerRevisionStatus;
  });

const activateSnapshot = (
  dependencies: RunnerSourceSupervisorDependencies,
  request: StagedRunnerSnapshotActivationRequest,
): Effect.Effect<RunnerRevisionStatus> =>
  Effect.gen(function* () {
    const decoded = yield* validateSnapshot(request.snapshot).pipe(
      Effect.match({
        onFailure: (error) => ({ error }),
        onSuccess: (snapshot) => ({ snapshot }),
      }),
    );
    const key = identityKey(request.identity);
    const active = (yield* Ref.get(dependencies.activeSnapshots)).get(key);
    if ("error" in decoded)
      return yield* rejectInvalidSnapshot(dependencies, request, key, active, decoded.error.reason);
    const snapshot = decoded.snapshot;
    if (active?.revision === snapshot.revision)
      return yield* activateCurrentSnapshot(dependencies, request.identity, snapshot, key, active);
    return yield* stageAndPromoteSnapshot(dependencies, request, snapshot, key, active);
  });

export const RunnerSourceSupervisorLive = (options: {
  readonly stagedRoot: string;
  readonly activeRoot: string;
  readonly workspaceRoot?: string;
  readonly maxStagedStorageBytes?: number;
}) =>
  Layer.effect(
    RunnerSourceSupervisor,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runtime = yield* RunnerSourceRuntime;
      const maxStagedStorageBytes = options.maxStagedStorageBytes ?? maximumStagedStorageBytes;
      if (
        !Number.isSafeInteger(maxStagedStorageBytes) ||
        maxStagedStorageBytes <= 0 ||
        maxStagedStorageBytes > maximumStagedStorageBytes
      )
        return yield* Effect.fail(
          new RunnerSourceSupervisorError({ reason: "unsafe-storage-limit" }),
        );
      const roots = yield* safeRoots(
        options.stagedRoot,
        options.activeRoot,
        options.workspaceRoot ?? "/workspace",
        path,
      );
      const activeSnapshots = yield* Ref.make<ReadonlyMap<string, ActiveSnapshot>>(new Map());
      const activationSemaphore = yield* Semaphore.make(1);
      const activationScope = yield* Effect.scope;
      const dependencies: RunnerSourceSupervisorDependencies = {
        fileSystem,
        path,
        runtime,
        roots,
        activeSnapshots,
        maxStagedStorageBytes,
      };
      const verifyReadiness: RunnerSourceSupervisorApi["readiness"] = (identity) =>
        Effect.flatMap(Ref.get(activeSnapshots), (current) =>
          readinessStatus(runtime, identity, current.get(identityKey(identity))),
        );
      const activate: RunnerSourceSupervisorApi["activate"] = (request) =>
        activationSemaphore
          .withPermit(activateSnapshot(dependencies, request))
          .pipe(Effect.forkIn(activationScope), Effect.flatMap(Fiber.join));

      return {
        activate,
        readiness: verifyReadiness,
      } satisfies RunnerSourceSupervisorApi;
    }),
  );

const maximumRunnerSourceRequestBodyBytes = 128 * 1024 * 1024;

const readBoundedSnapshotBody = (
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
  context: Context.Context<never>,
): Effect.Effect<string, RunnerSourceRequestBodyError> =>
  Effect.gen(function* () {
    const contentLength = request.headers["content-length"];
    if (contentLength !== undefined) {
      if (!/^\d+$/.test(contentLength))
        return yield* Effect.fail(
          new RunnerSourceRequestBodyError({ reason: "invalid-content-length" }),
        );
      const declaredLength = Number(contentLength);
      if (!Number.isSafeInteger(declaredLength))
        return yield* Effect.fail(
          new RunnerSourceRequestBodyError({ reason: "invalid-content-length" }),
        );
      if (declaredLength > maxBytes)
        return yield* Effect.fail(
          new RunnerSourceRequestBodyError({ reason: "payload-too-large" }),
        );
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    yield* request.stream.pipe(
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          const nextSize = totalBytes + chunk.byteLength;
          if (nextSize > maxBytes)
            return Effect.fail(new RunnerSourceRequestBodyError({ reason: "payload-too-large" }));
          chunks.push(chunk);
          totalBytes = nextSize;
          return Effect.void;
        }),
      ),
      Effect.mapError((error) =>
        Predicate.isTagged("RunnerSourceRequestBodyError")(error)
          ? error
          : new RunnerSourceRequestBodyError({ reason: "invalid-request-body" }),
      ),
      Effect.provideContext(context),
    );
    return yield* Effect.try({
      try: () =>
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes)),
      catch: () => new RunnerSourceRequestBodyError({ reason: "invalid-request-body" }),
    });
  });

const badRequest = () =>
  HttpServerResponse.json({ error: "invalid-request-body" }, { status: 400 });
const unauthorized = () => HttpServerResponse.json({ error: "unauthorized" }, { status: 401 });
const payloadTooLarge = () =>
  HttpServerResponse.json({ error: "payload-too-large" }, { status: 413 });
const requestBodyTimedOut = () =>
  HttpServerResponse.json({ error: "request-body-timeout" }, { status: 408 });

/** Route builder only: callers must provide the live session authorizer and source process layers. */
export const runnerSourceSnapshotRoutesLayer = Layer.unwrap(
  Effect.gen(function* () {
    const supervisor = yield* RunnerSourceSupervisor;
    const authorizer = yield* RunnerSourceSnapshotAuthorizer;
    const requestBodySemaphore = yield* Semaphore.make(1);
    return HttpRouter.add(
      "POST",
      "/_internal/runner-source/v1/activate",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        if (authorization === undefined || authorization.trim().length === 0)
          return yield* unauthorized();
        const authorizedIdentity = yield* Effect.result(
          authorizer.authorize({ headers: request.headers }),
        );
        if (authorizedIdentity._tag === "Failure") return yield* unauthorized();
        const inheritedContext = yield* Effect.context();
        const inheritedLimit = Context.get(inheritedContext, HttpIncomingMessage.MaxBodySize);
        const maxBodyBytes = Math.min(
          maximumRunnerSourceRequestBodyBytes,
          inheritedLimit === undefined
            ? maximumRunnerSourceRequestBodyBytes
            : Number(inheritedLimit),
        );
        const bodyContext = Context.add(
          inheritedContext,
          HttpIncomingMessage.MaxBodySize,
          FileSystem.Size(maxBodyBytes),
        );
        const decoded = yield* requestBodySemaphore.withPermit(
          Effect.gen(function* () {
            const body = yield* readBoundedSnapshotBody(request, maxBodyBytes, bodyContext).pipe(
              Effect.match({
                onFailure: (error) => ({ error }),
                onSuccess: (body) => ({ body }),
              }),
            );
            if ("error" in body) return { error: body.error.reason };
            return yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(StagedRunnerSnapshotActivationRequestSchema),
            )(body.body).pipe(
              Effect.match({
                onFailure: () => ({ error: "invalid-request-body" as const }),
                onSuccess: (requestBody) => ({ requestBody }),
              }),
            );
          }).pipe(
            Effect.timeout(stagedSourceActivationTimeouts.requestBody),
            Effect.match({
              onFailure: (error) => ({
                error: Cause.isTimeoutError(error)
                  ? ("request-timeout" as const)
                  : ("invalid-request-body" as const),
              }),
              onSuccess: (result) => result,
            }),
          ),
        );
        if ("error" in decoded) {
          if (decoded.error === "payload-too-large") return yield* payloadTooLarge();
          if (decoded.error === "request-timeout") return yield* requestBodyTimedOut();
          return yield* badRequest();
        }
        if (!sameRunnerIdentity(decoded.requestBody.identity, authorizedIdentity.success))
          return yield* unauthorized();
        const status = yield* supervisor.activate(decoded.requestBody);
        return yield* HttpServerResponse.json(status);
      }),
    ).pipe(Layer.provideMerge(HttpRouter.layer));
  }),
);
