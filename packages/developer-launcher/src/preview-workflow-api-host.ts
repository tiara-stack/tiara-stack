import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Result, Schema } from "effect";
import { unpack } from "msgpackr";
import { parse as parseYaml } from "yaml";
import {
  SheetDbMigrationArtifactManifestSchema,
  sheetDbMigrationArtifactDigestFromSources,
} from "sheet-db-schema/migration-artifact-identity";
import { sheetDbMigrationArtifacts } from "sheet-db-schema/migrations";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type { ProcessStarter, RunningProcess } from "./types";
import { startLongLivedProcess } from "./executor";
import type { PreviewSession } from "./preview-sessions";
import type { ConnectedPreviewConfig } from "./connected-preview";
import { sheetWorkflowContractCatalogDigest } from "sheet-workflows/catalog-identity";
import { isPreviewPathWithin as pathIsWithin } from "./preview-path-containment";
import {
  PreviewSharedWorkflowError,
  runPreviewSharedWorkflowHttpRequest,
  type PreviewSharedWorkflowHttpRequestInput,
  type PreviewSharedWorkflowHttpRequestRunner,
} from "./preview-shared-workflow";
import {
  isApprovedDevelopmentPostgresEndpoint,
  makePreviewWorkflowApiSupervisor,
  makePreviewWorkflowApiSupervisorError,
  PreviewWorkflowApiSupervisor,
  previewWorkflowApiDatabaseEndpointIdentity,
  previewWorkflowApiProcessRequest,
  type PreviewWorkflowApiProcess,
  type PreviewWorkflowApiDatabaseTarget,
  type PreviewWorkflowApiSupervisorAdapters,
  PreviewWorkflowApiSupervisorError,
} from "./preview-workflow-api-supervisor";
import type { PreviewSharedWorkflowGroup } from "./preview-shared-workflow";

export class PreviewWorkflowApiHostError extends Schema.TaggedErrorClass<PreviewWorkflowApiHostError>()(
  "PreviewWorkflowApiHostError",
  { reason: Schema.String, phase: Schema.optionalKey(Schema.String) },
) {}

const workflowApiStageError = (error: unknown, phase: string) =>
  new PreviewWorkflowApiHostError({
    reason: "workflow-source-unavailable",
    phase:
      error instanceof PreviewWorkflowApiHostError && error.phase !== undefined
        ? error.phase
        : phase,
  });

export interface PreviewWorkflowApiCredentialProviderApi {
  /** Revalidates signed authority at each current target, process and route boundary. */
  readonly assertCurrent?: () => Effect.Effect<void, PreviewWorkflowApiHostError>;
  /** Expiry from the independently verified signed authority payload. */
  readonly authorityExpiresAt?: number;
  /** Clock used by assertCurrent, so the supervisor deadline shares the same time source. */
  readonly authorityNow?: () => number;
  /**
   * Resolves the selected group's non-secret identity before any credential reference is read.
   */
  readonly resolveDatabaseTarget: (input: {
    readonly session: PreviewSession;
    readonly config: ConnectedPreviewConfig;
    readonly group: PreviewSharedWorkflowGroup;
  }) => Effect.Effect<PreviewWorkflowApiDatabaseTarget, PreviewWorkflowApiHostError>;
  /** Reads only references on this selected role after the trusted target matches the group. */
  readonly resolve: (input: {
    readonly session: PreviewSession;
    readonly config: ConnectedPreviewConfig;
    readonly references: Readonly<Record<string, string>>;
    readonly databaseTarget: PreviewWorkflowApiDatabaseTarget;
  }) => Effect.Effect<
    {
      readonly authIssuer: string;
      readonly environment: Readonly<Record<string, string>>;
    },
    PreviewWorkflowApiHostError
  >;
}
export class PreviewWorkflowApiCredentialProvider extends Context.Service<
  PreviewWorkflowApiCredentialProvider,
  PreviewWorkflowApiCredentialProviderApi
>()("developer-launcher/PreviewWorkflowApiCredentialProvider") {}

export interface PreviewWorkflowApiRouteRemovalInput {
  readonly sessionId: string;
  readonly generation: number;
  readonly ownerIdentity: string;
  readonly expectedRevision: string;
}

export interface PreviewWorkflowApiApplicationRouteApi {
  /** Stable origin for this session role, derived from the common gateway's owned route. */
  readonly applicationOrigin: (input: {
    readonly sessionId: string;
    readonly role: "sheet-workflows-api";
  }) => Effect.Effect<string, PreviewWorkflowApiHostError>;
  /**
   * Publishes one exact listener/revision using the common gateway application target.
   * Every catalogued enqueue and invocation-observation request must go through
   * admitWorkflowRequest before it is forwarded to the API process.
   */
  readonly publish: (input: {
    readonly session: PreviewSession;
    readonly ownerIdentity: string;
    readonly revision: string;
    readonly group: PreviewSharedWorkflowGroup;
    readonly listener: NonNullable<ConnectedPreviewConfig["hostListeners"]>[number];
    readonly admitWorkflowRequest: PreviewSharedWorkflowHttpRequestRunner;
    readonly assertAuthorityCurrent?: () => Effect.Effect<void, PreviewWorkflowApiHostError>;
  }) => Effect.Effect<string, PreviewWorkflowApiHostError>;
  readonly remove: (
    input: PreviewWorkflowApiRouteRemovalInput,
  ) => Effect.Effect<void, PreviewWorkflowApiHostError>;
}
export class PreviewWorkflowApiApplicationRoute extends Context.Service<
  PreviewWorkflowApiApplicationRoute,
  PreviewWorkflowApiApplicationRouteApi
>()("developer-launcher/PreviewWorkflowApiApplicationRoute") {}

type ProcessInfo = {
  readonly process: RunningProcess;
  readonly session: PreviewSession;
  readonly listener: NonNullable<ConnectedPreviewConfig["hostListeners"]>[number];
  readonly group: PreviewSharedWorkflowGroup;
  readonly revision: string;
  readonly oauthClientId: string;
  readonly localOrigin: string;
  readonly stagedCheckout: string;
};

const previewWorkflowApiRequestTimeoutMs = 30_000;

/** Builds the fail-closed request gate used by the common session application route. */
export const makePreviewWorkflowApiWorkflowRequestRunner =
  (input: {
    readonly controller: import("./preview-sessions").PreviewSessionControllerApi;
    readonly group: PreviewSharedWorkflowGroup;
    readonly oauthClientId: string;
    readonly endpoint: () => string | undefined;
    readonly assertAuthorityCurrent?: () => Effect.Effect<void, PreviewWorkflowApiHostError>;
  }): PreviewSharedWorkflowHttpRequestRunner =>
  <A, E, R>(request: PreviewSharedWorkflowHttpRequestInput<A, E, R>) => {
    const endpoint = input.endpoint();
    if (endpoint === undefined)
      return Effect.fail(
        new PreviewSharedWorkflowError({ reason: "route-not-ready", outcome: "not-sent" }),
      );
    const admittedRequest = runPreviewSharedWorkflowHttpRequest({
      controller: input.controller,
      group: input.group,
      oauthClientId: input.oauthClientId,
      endpoint,
      method: request.method,
      path: request.path,
      ...(request.body === undefined ? {} : { body: request.body }),
      timeoutMs: previewWorkflowApiRequestTimeoutMs,
      forward: request.forward,
    });
    return input.assertAuthorityCurrent === undefined
      ? admittedRequest
      : input.assertAuthorityCurrent().pipe(
          Effect.mapError(
            () =>
              new PreviewSharedWorkflowError({ reason: "admission-denied", outcome: "not-sent" }),
          ),
          Effect.andThen(admittedRequest),
        );
  };

export const previewWorkflowApiSourceRoots = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "preview-workflow-api-runtime-attestations.json",
  "patches",
  "tsconfig.base.json",
  "tsconfig.browser.json",
  "tsconfig.json",
  "packages/sheet-workflows/src",
  "packages/sheet-workflows/package.json",
  "packages/sheet-workflows/tsconfig.json",
  "packages/sheet-workflows/vite.config.ts",
  "packages/sheet-workflow-contracts/src",
  "packages/sheet-workflow-contracts/package.json",
  "packages/sheet-workflow-contracts/tsconfig.json",
  "packages/effect-zero-workflow/src",
  "packages/effect-zero-workflow/package.json",
  "packages/effect-zero-workflow/tsconfig.json",
  "packages/effect-zero/src",
  "packages/effect-zero/package.json",
  "packages/effect-zero/tsconfig.json",
  "packages/effect-sql-kit/src",
  "packages/effect-sql-kit/package.json",
  "packages/effect-sql-kit/tsconfig.json",
  "packages/effect-sql-schema/src",
  "packages/effect-sql-schema/package.json",
  "packages/effect-sql-schema/tsconfig.json",
  "packages/sheet-zero-api/src",
  "packages/sheet-zero-api/package.json",
  "packages/sheet-zero-api/tsconfig.json",
  "packages/sheet-zero-server/src",
  "packages/sheet-zero-server/package.json",
  "packages/sheet-zero-server/tsconfig.json",
  "packages/sheet-db-schema/src",
  "packages/sheet-db-schema/package.json",
  "packages/sheet-db-schema/tsconfig.json",
  "packages/sheet-db-schema/effect-sql-migrations",
  "packages/sheet-auth/package.json",
  "packages/sheet-auth/tsconfig.json",
  "packages/sheet-auth/src",
  "packages/sheet-bot-api/package.json",
  "packages/sheet-bot-api/tsconfig.json",
  "packages/sheet-bot-api/src",
  "packages/sheet-domain/package.json",
  "packages/sheet-domain/tsconfig.json",
  "packages/sheet-domain/src",
  "packages/sheet-message-content/package.json",
  "packages/sheet-message-content/tsconfig.json",
  "packages/sheet-message-content/src",
  "packages/typhoon-core/package.json",
  "packages/typhoon-core/tsconfig.json",
  "packages/typhoon-core/src",
  "packages/typhoon-zero/package.json",
  "packages/typhoon-zero/tsconfig.json",
  "packages/typhoon-zero/src",
] as const;
const sourceFileExtensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".sql",
  ".patch",
]);
const previewWorkflowApiSourcePackages = new Set(
  previewWorkflowApiSourceRoots
    .filter((sourceRoot) => sourceRoot.startsWith("packages/"))
    .map((sourceRoot) => sourceRoot.split("/")[1]!),
);
const previewWorkflowApiManifestSchemaFields = {
  name: Schema.String,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  peerDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  bin: Schema.optional(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)])),
};
const previewWorkflowApiPackageManifestSchema = Schema.Struct(
  previewWorkflowApiManifestSchemaFields,
);
const previewWorkflowApiLockDependencySchema = Schema.Struct({
  specifier: Schema.String,
  version: Schema.String,
});
const previewWorkflowApiLockImporterSchema = Schema.Struct({
  dependencies: Schema.optional(
    Schema.Record(Schema.String, previewWorkflowApiLockDependencySchema),
  ),
  optionalDependencies: Schema.optional(
    Schema.Record(Schema.String, previewWorkflowApiLockDependencySchema),
  ),
  devDependencies: Schema.optional(
    Schema.Record(Schema.String, previewWorkflowApiLockDependencySchema),
  ),
});
const previewWorkflowApiLockSnapshotSchema = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const previewWorkflowApiPnpmLockfileSchema = Schema.Struct({
  lockfileVersion: Schema.Union([Schema.String, Schema.Number]),
  importers: Schema.Record(Schema.String, previewWorkflowApiLockImporterSchema),
  packages: Schema.Record(
    Schema.String,
    Schema.Struct({
      resolution: Schema.optional(Schema.Struct({ integrity: Schema.optional(Schema.String) })),
    }),
  ),
  snapshots: Schema.Record(Schema.String, previewWorkflowApiLockSnapshotSchema),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const previewWorkflowApiPnpmModulesSchema = Schema.Struct({
  storeDir: Schema.String,
  virtualStoreDir: Schema.String,
  virtualStoreDirMaxLength: Schema.Number,
});
const previewWorkflowApiPnpmStorePackageFileSchema = Schema.Struct({
  digest: Schema.String,
  mode: Schema.Number,
  size: Schema.Number,
  symlink: Schema.optional(Schema.String),
});
const previewWorkflowApiPnpmStorePackageIndexSchema = Schema.Struct({
  algo: Schema.Literal("sha512"),
  files: Schema.Record(Schema.String, previewWorkflowApiPnpmStorePackageFileSchema),
  manifest: Schema.Struct({ name: Schema.String, version: Schema.String }),
});
const previewWorkflowApiRuntimePackageAttestationSchema = Schema.Struct({
  integrity: Schema.String,
  runtimeDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))),
});
export const PreviewWorkflowApiRuntimeArtifactAttestationsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  packages: Schema.Record(Schema.String, previewWorkflowApiRuntimePackageAttestationSchema),
});
export type PreviewWorkflowApiRuntimeArtifactAttestations = Schema.Schema.Type<
  typeof PreviewWorkflowApiRuntimeArtifactAttestationsSchema
>;
const previewWorkflowApiPnpmWorkspaceSchema = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  catalogs: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
const previewWorkflowApiRootManifestSchema = Schema.Struct({
  ...previewWorkflowApiManifestSchemaFields,
  pnpm: Schema.optional(
    Schema.Struct({
      overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
const migrationArtifactManifestPath =
  "packages/sheet-db-schema/src/migration-artifact-manifest.json";
const migrationArtifactUnavailable = () =>
  new PreviewWorkflowApiHostError({ reason: "workflow-source-unavailable" });

const migrationManifestFromFiles = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
): Effect.Effect<
  Schema.Schema.Type<typeof SheetDbMigrationArtifactManifestSchema>,
  PreviewWorkflowApiHostError
> => {
  const manifestEntry = entries.find(
    ({ relativePath }) => relativePath === migrationArtifactManifestPath,
  );
  if (manifestEntry === undefined) return Effect.fail(migrationArtifactUnavailable());
  return Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(manifestEntry.contents)) as unknown,
    catch: migrationArtifactUnavailable,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SheetDbMigrationArtifactManifestSchema)),
    Effect.mapError(() => migrationArtifactUnavailable()),
  );
};

const migrationPathsMatchLoadedRegistration = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
  manifest: Schema.Schema.Type<typeof SheetDbMigrationArtifactManifestSchema>,
) => {
  const migrationDirectory = "packages/sheet-db-schema/effect-sql-migrations/";
  const migrationPathPattern =
    /^packages\/sheet-db-schema\/effect-sql-migrations\/\d{4}_[a-z0-9_]+\.ts$/;
  const discoveredPaths = entries
    .map(({ relativePath }) => relativePath)
    .filter((relativePath) => migrationPathPattern.test(relativePath))
    .sort();
  const manifestPaths = manifest.sources.map(([relativePath]) => relativePath);
  return (
    manifestPaths.every((relativePath) => relativePath.startsWith(migrationDirectory)) &&
    discoveredPaths.length === manifestPaths.length &&
    discoveredPaths.every((relativePath, index) => relativePath === manifestPaths[index]) &&
    previewWorkflowApiRegisteredMigrationsMatch(
      manifestPaths,
      sheetDbMigrationArtifacts.map(([id, , , relativePath]) => ({ id, relativePath })),
    )
  );
};

const migrationSourceBytesMatchManifest = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
  manifest: Schema.Schema.Type<typeof SheetDbMigrationArtifactManifestSchema>,
) => {
  const sourceEntries = new Map(entries.map((entry) => [entry.relativePath, entry]));
  const seen = new Set<string>();
  return (
    manifest.sources.length > 0 &&
    manifest.sources.every(([relativePath, expectedDigest], index) => {
      const migrationId = relativePath.match(/\/(\d{4})_[a-z0-9_]+\.ts$/)?.[1];
      const source = sourceEntries.get(relativePath);
      if (
        migrationId !== String(index + 1).padStart(4, "0") ||
        source === undefined ||
        seen.has(relativePath)
      )
        return false;
      seen.add(relativePath);
      const actualDigest = `sha256:${createHash("sha256").update(source.contents).digest("hex")}`;
      return actualDigest === expectedDigest;
    })
  );
};

const migrationArtifactDigestFromFiles = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  migrationManifestFromFiles(entries).pipe(
    Effect.flatMap((manifest) =>
      migrationPathsMatchLoadedRegistration(entries, manifest) &&
      migrationSourceBytesMatchManifest(entries, manifest)
        ? Effect.succeed(sheetDbMigrationArtifactDigestFromSources(manifest.sources))
        : Effect.fail(migrationArtifactUnavailable()),
    ),
  );

const previewWorkflowApiCandidateParent = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
) =>
  Effect.gen(function* () {
    const parent = path.join(
      path.dirname(checkoutRoot),
      ".tiara-workflow-api-candidates",
      path.basename(checkoutRoot),
    );
    yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.makeDirectory(parent, { recursive: true, mode: 0o700 }),
      "candidate-parent-directory",
    );
    const canonicalParent = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(parent),
      "candidate-parent-realpath",
    );
    if (canonicalParent !== parent)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "candidate-parent-symlink",
        }),
      );
    yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.chmod(parent, 0o700),
      "candidate-parent-permissions",
    );

    let ancestor = parent;
    while (true) {
      const hasNodeModules = yield* mapWorkflowApiSourceFileSystemError(
        fileSystem.exists(path.join(ancestor, "node_modules")),
        "candidate-parent-module-resolution",
      );
      if (hasNodeModules)
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: "candidate-parent-node-modules",
          }),
        );
      const parentDirectory = path.dirname(ancestor);
      if (parentDirectory === ancestor) break;
      ancestor = parentDirectory;
    }
    return parent;
  });

const assertSourcePathContained = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  absolute: string,
  phase: string,
) =>
  fileSystem.realPath(absolute).pipe(
    Effect.mapError(
      () =>
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase,
        }),
    ),
    Effect.flatMap((resolved) =>
      resolved === absolute && pathIsWithin(root, resolved)
        ? Effect.void
        : Effect.fail(
            new PreviewWorkflowApiHostError({
              reason: "workflow-source-unavailable",
              phase: "source-symlink-rejected",
            }),
          ),
    ),
  );

const sourceFilesUnder = (
  fileSystem: FileSystem.FileSystem,
  root: string,
  current: string,
): Effect.Effect<ReadonlyArray<string>, PreviewWorkflowApiHostError> =>
  Effect.gen(function* () {
    const entries = yield* fileSystem
      .readDirectory(current)
      .pipe(
        Effect.mapError(
          () => new PreviewWorkflowApiHostError({ reason: "workflow-source-unavailable" }),
        ),
      );
    const nested = yield* Effect.forEach(entries, (entry) =>
      Effect.gen(function* () {
        const absolute = path.join(current, entry);
        yield* assertSourcePathContained(fileSystem, root, absolute, "source-entry-realpath");
        const stat = yield* fileSystem
          .stat(absolute)
          .pipe(
            Effect.mapError(
              () => new PreviewWorkflowApiHostError({ reason: "workflow-source-unavailable" }),
            ),
          );
        if (stat.type === "Directory") return yield* sourceFilesUnder(fileSystem, root, absolute);
        const extension = path.extname(entry);
        return sourceFileExtensions.has(extension) &&
          !/\.test\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/.test(entry)
          ? [absolute]
          : [];
      }),
    );
    return nested.flat();
  });

export const previewWorkflowApiSourceRevisionFromFiles = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
  dependencyClosureDigest?: string,
) => {
  const digest = createHash("sha256");
  const updateFramed = (bytes: Uint8Array) => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    digest.update(length).update(bytes);
  };
  const ordered = [...entries].sort((left, right) => {
    if (left.relativePath < right.relativePath) return -1;
    if (left.relativePath > right.relativePath) return 1;
    return 0;
  });
  for (const entry of ordered) {
    updateFramed(Buffer.from(entry.relativePath, "utf8"));
    updateFramed(entry.contents);
  }
  if (dependencyClosureDigest !== undefined) {
    updateFramed(Buffer.from("pnpm-runtime-dependency-closure-v1", "utf8"));
    updateFramed(Buffer.from(dependencyClosureDigest, "utf8"));
  }
  return `sha256:${digest.digest("hex")}`;
};

export const previewWorkflowApiRegisteredMigrationsMatch = (
  manifestPaths: ReadonlyArray<string>,
  registrations: ReadonlyArray<{ readonly id: number; readonly relativePath: string }>,
) =>
  manifestPaths.length === registrations.length &&
  registrations.every(({ id, relativePath }, index) => {
    const manifestPath = manifestPaths[index];
    const migrationId = relativePath.match(/\/(\d{4})_[a-z0-9_]+\.ts$/)?.[1];
    return relativePath === manifestPath && migrationId !== undefined && Number(migrationId) === id;
  });

const previewWorkflowApiSourceEntries = (fileSystem: FileSystem.FileSystem, checkout: string) =>
  Effect.gen(function* () {
    const root = yield* fileSystem.realPath(checkout).pipe(
      Effect.mapError(
        () =>
          new PreviewWorkflowApiHostError({
            reason: "workflow-checkout-unavailable",
            phase: "checkout-realpath",
          }),
      ),
    );
    const files = yield* Effect.forEach(previewWorkflowApiSourceRoots, (relative) => {
      const absolute = path.resolve(root, relative);
      return assertSourcePathContained(fileSystem, root, absolute, `source-root:${relative}`).pipe(
        Effect.andThen(fileSystem.stat(absolute)),
        Effect.mapError(
          () =>
            new PreviewWorkflowApiHostError({
              reason: "workflow-source-unavailable",
              phase: `source-root:${relative}`,
            }),
        ),
        Effect.flatMap((info) =>
          info.type === "Directory"
            ? sourceFilesUnder(fileSystem, root, absolute)
            : Effect.succeed([absolute]),
        ),
        Effect.mapError((error) => workflowApiStageError(error, `source-root:${relative}`)),
      );
    });
    const entries = yield* Effect.forEach(files.flat(), (file) =>
      Effect.gen(function* () {
        const relative = path.relative(root, file);
        yield* assertSourcePathContained(
          fileSystem,
          root,
          file,
          `source-file-realpath:${relative}`,
        );
        const contents = yield* fileSystem.readFile(file).pipe(
          Effect.mapError(
            () =>
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: `source-file:${relative}`,
              }),
          ),
        );
        yield* assertSourcePathContained(
          fileSystem,
          root,
          file,
          `source-file-realpath:${relative}`,
        );
        return { relativePath: relative, contents };
      }),
    );
    return { root, entries };
  });

type PreviewWorkflowApiPackageManifest = {
  readonly name: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  readonly bin?: string | Readonly<Record<string, string>> | undefined;
};

type PreviewWorkflowApiPnpmLockfile = Schema.Schema.Type<
  typeof previewWorkflowApiPnpmLockfileSchema
>;
type PreviewWorkflowApiPnpmStorePackageIndex = Schema.Schema.Type<
  typeof previewWorkflowApiPnpmStorePackageIndexSchema
>;
type PreviewWorkflowApiPnpmStorePackageReference = {
  readonly packageId: string;
  readonly integrity: string;
  readonly packageInfo: { readonly name: string; readonly version: string };
};
type PreviewWorkflowApiPatchedPackage = {
  readonly packageId: string;
  readonly packageLocator: string;
  readonly patchHash: string;
  readonly patchPath: string;
  readonly files: ReadonlyMap<string, PreviewWorkflowApiUnifiedPatchFile>;
};
type PreviewWorkflowApiUnifiedPatchOperation = {
  readonly kind: "context" | "add" | "remove";
  readonly text: string;
  readonly noNewline: boolean;
};
type PreviewWorkflowApiUnifiedPatchHunk = {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly operations: ReadonlyArray<PreviewWorkflowApiUnifiedPatchOperation>;
};
type PreviewWorkflowApiUnifiedPatchFile = {
  readonly relativePath: string;
  readonly hunks: ReadonlyArray<PreviewWorkflowApiUnifiedPatchHunk>;
};
type PreviewWorkflowApiPnpmStorePackageIndexes = ReadonlyMap<
  string,
  PreviewWorkflowApiPnpmStorePackageIndex
>;
type PreviewWorkflowApiDependencyClosure = {
  readonly baseDigest: string;
  readonly digest: string;
  readonly indexes: PreviewWorkflowApiPnpmStorePackageIndexes;
  readonly patchedPackages: ReadonlyMap<string, PreviewWorkflowApiPatchedPackage>;
  readonly runtimePackageDigests: ReadonlyMap<string, string>;
};
type PreviewWorkflowApiPnpmModulesMetadata = {
  readonly storeDir: string;
  readonly storeIndexPath: string;
  readonly virtualStoreDirMaxLength: number;
};

type PreviewWorkflowApiWorkspaceDependency = {
  readonly packageName: string;
  readonly dependencyName: string;
};

const previewWorkflowApiPackageManifests = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  Effect.gen(function* () {
    const manifests = new Map<string, PreviewWorkflowApiPackageManifest>();
    for (const entry of entries) {
      const match = entry.relativePath.match(/^packages\/([^/]+)\/package\.json$/);
      if (match === null) continue;
      const packageName = match[1];
      if (packageName === undefined) continue;
      const decoded = yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(previewWorkflowApiPackageManifestSchema)(
            JSON.parse(new TextDecoder().decode(entry.contents)),
          ),
        catch: () =>
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `package-manifest:${packageName}`,
          }),
      });
      if (decoded.name !== packageName)
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: "package-manifest-name",
          }),
        );
      manifests.set(packageName, {
        name: decoded.name,
        dependencies: decoded.dependencies ?? {},
        optionalDependencies: decoded.optionalDependencies ?? {},
        devDependencies: decoded.devDependencies ?? {},
        peerDependencies: decoded.peerDependencies ?? {},
      });
    }
    return manifests;
  });

const workspacePackageManifest = (
  packageName: string,
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
): Effect.Effect<PreviewWorkflowApiPackageManifest, PreviewWorkflowApiHostError> => {
  if (!previewWorkflowApiSourcePackages.has(packageName))
    return Effect.fail(
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: "workspace-dependency-source-root",
      }),
    );
  const manifest = manifests.get(packageName);
  if (manifest === undefined)
    return Effect.fail(
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: "workspace-package-manifest",
      }),
    );
  if (manifest.name !== packageName)
    return Effect.fail(
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: "workspace-package-manifest-name",
      }),
    );
  return Effect.succeed(manifest);
};

const workspaceDependencyNames = (manifest: PreviewWorkflowApiPackageManifest) =>
  [
    ...Object.entries(manifest.dependencies),
    ...Object.entries(manifest.optionalDependencies),
    ...Object.entries(manifest.peerDependencies),
  ]
    .filter(([, version]) => version.startsWith("workspace:"))
    .map(([dependencyName]) => dependencyName);

const workspaceDependencyEdges = (
  packageName: string,
  manifest: PreviewWorkflowApiPackageManifest,
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
) =>
  Effect.forEach(
    workspaceDependencyNames(manifest),
    (dependencyName) =>
      workspacePackageManifest(dependencyName, manifests).pipe(
        Effect.as({ packageName, dependencyName }),
      ),
    { concurrency: 1 },
  );

const validatePreviewWorkflowApiWorkspaceClosure = (
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
): Effect.Effect<
  ReadonlyArray<PreviewWorkflowApiWorkspaceDependency>,
  PreviewWorkflowApiHostError
> =>
  Effect.gen(function* () {
    const pending = ["sheet-workflows"];
    const visited = new Set<string>();
    const edges = new Map<string, PreviewWorkflowApiWorkspaceDependency>();
    while (pending.length > 0) {
      const packageName = pending.pop()!;
      if (visited.has(packageName)) continue;
      visited.add(packageName);
      const manifest = yield* workspacePackageManifest(packageName, manifests);
      const dependencies = yield* workspaceDependencyEdges(packageName, manifest, manifests);
      for (const edge of dependencies) {
        edges.set(`${edge.packageName}\\u0000${edge.dependencyName}`, edge);
        pending.push(edge.dependencyName);
      }
    }
    return [...edges.values()];
  });

const previewWorkflowApiEntriesByPath = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) => new Map(entries.map((entry) => [entry.relativePath, entry.contents]));

const decodePreviewWorkflowApiPackageManifest = (relativePath: string, contents: Uint8Array) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(previewWorkflowApiRootManifestSchema)(
        JSON.parse(new TextDecoder().decode(contents)),
      ),
    catch: () =>
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: `package-manifest:${relativePath}`,
      }),
  });

const decodePreviewWorkflowApiLockfileBytes = (lockBytes: Uint8Array) =>
  Effect.gen(function* () {
    const lockfile = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(previewWorkflowApiPnpmLockfileSchema)(
          parseYaml(new TextDecoder().decode(lockBytes)),
        ),
      catch: () =>
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-lockfile",
        }),
    });
    if (String(lockfile.lockfileVersion) !== "9.0")
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-lockfile-version",
        }),
      );
    return lockfile;
  });

const decodePreviewWorkflowApiWorkspaceBytes = (workspaceBytes: Uint8Array) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(previewWorkflowApiPnpmWorkspaceSchema)(
        parseYaml(new TextDecoder().decode(workspaceBytes)),
      ),
    catch: () =>
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: "dependency-workspace-config",
      }),
  });

const previewWorkflowApiPnpmLockInputBytes = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  Effect.gen(function* () {
    const byPath = previewWorkflowApiEntriesByPath(entries);
    const lockBytes = byPath.get("pnpm-lock.yaml");
    const workspaceBytes = byPath.get("pnpm-workspace.yaml");
    const rootManifestBytes = byPath.get("package.json");
    if (lockBytes === undefined || workspaceBytes === undefined || rootManifestBytes === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-lock-inputs",
        }),
      );
    return { lockBytes, workspaceBytes, rootManifestBytes };
  });

const previewWorkflowApiRecordOrEmpty = <Value>(
  record: Readonly<Record<string, Value>> | undefined,
): Readonly<Record<string, Value>> => record ?? {};

const decodePreviewWorkflowApiPnpmLockfile = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  previewWorkflowApiPnpmLockInputBytes(entries).pipe(
    Effect.flatMap(({ lockBytes, workspaceBytes, rootManifestBytes }) =>
      Effect.all(
        {
          lockfile: decodePreviewWorkflowApiLockfileBytes(lockBytes),
          workspace: decodePreviewWorkflowApiWorkspaceBytes(workspaceBytes),
          decodedRootManifest: decodePreviewWorkflowApiPackageManifest(
            "package.json",
            rootManifestBytes,
          ),
        },
        { concurrency: 1 },
      ).pipe(Effect.map((decoded) => ({ ...decoded, lockBytes }))),
    ),
    Effect.map(({ lockfile, workspace, decodedRootManifest, lockBytes }) => {
      const rootManifest: PreviewWorkflowApiPackageManifest = {
        name: decodedRootManifest.name,
        dependencies: previewWorkflowApiRecordOrEmpty(decodedRootManifest.dependencies),
        optionalDependencies: previewWorkflowApiRecordOrEmpty(
          decodedRootManifest.optionalDependencies,
        ),
        devDependencies: previewWorkflowApiRecordOrEmpty(decodedRootManifest.devDependencies),
        peerDependencies: previewWorkflowApiRecordOrEmpty(decodedRootManifest.peerDependencies),
        bin: decodedRootManifest.bin,
      };
      return {
        lockfile,
        lockBytes,
        rootManifest,
        workspace,
        overrides: {
          ...previewWorkflowApiRecordOrEmpty(workspace.overrides),
          ...previewWorkflowApiRecordOrEmpty(decodedRootManifest.pnpm?.overrides),
        },
        catalogs: {
          ...previewWorkflowApiRecordOrEmpty(workspace.catalogs?.default),
          ...previewWorkflowApiRecordOrEmpty(workspace.catalog),
        },
        workspacePatchedDependencies: previewWorkflowApiRecordOrEmpty(
          workspace.patchedDependencies,
        ),
        rootPatchedDependencies: previewWorkflowApiRecordOrEmpty(
          decodedRootManifest.pnpm?.patchedDependencies,
        ),
      };
    }),
  );

const previewWorkflowApiDecodePnpmModulesMetadata = (bytes: Uint8Array) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(previewWorkflowApiPnpmModulesSchema)(
        parseYaml(new TextDecoder().decode(bytes)),
      ),
    catch: () =>
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: "pnpm-modules-metadata",
      }),
  });

const previewWorkflowApiPnpmModulesLayoutIsSupported = (
  modules: Schema.Schema.Type<typeof previewWorkflowApiPnpmModulesSchema>,
) =>
  path.isAbsolute(modules.storeDir) &&
  modules.virtualStoreDir === ".pnpm" &&
  Number.isInteger(modules.virtualStoreDirMaxLength) &&
  modules.virtualStoreDirMaxLength >= 80 &&
  modules.virtualStoreDirMaxLength <= 255;

const previewWorkflowApiPnpmStoreMetadata = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  storeDir: string,
) =>
  Effect.gen(function* () {
    const storeRoot = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(storeDir),
      "pnpm-content-store-realpath",
    );
    if (pathIsWithin(checkoutRoot, storeRoot))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "pnpm-content-store-inside-checkout",
        }),
      );
    const storeIndexPath = path.join(storeRoot, "index.db");
    const indexRealPath = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(storeIndexPath),
      "pnpm-content-store-index-realpath",
    );
    if (indexRealPath !== storeIndexPath)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "pnpm-content-store-index-path",
        }),
      );
    return { storeDir: storeRoot, storeIndexPath };
  });

const previewWorkflowApiPnpmModulesMetadata = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
) =>
  Effect.gen(function* () {
    const modulesPath = path.join(checkoutRoot, "node_modules", ".modules.yaml");
    const realModulesPath = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(modulesPath),
      "pnpm-modules-metadata-realpath",
    );
    if (realModulesPath !== modulesPath || !pathIsWithin(checkoutRoot, realModulesPath))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "pnpm-modules-metadata-outside-root",
        }),
      );
    const bytes = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.readFile(modulesPath),
      "pnpm-modules-metadata",
    );
    const modules = yield* previewWorkflowApiDecodePnpmModulesMetadata(bytes);
    if (!previewWorkflowApiPnpmModulesLayoutIsSupported(modules))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "pnpm-virtual-store-layout",
        }),
      );
    const store = yield* previewWorkflowApiPnpmStoreMetadata(
      fileSystem,
      checkoutRoot,
      modules.storeDir,
    );
    return {
      ...store,
      virtualStoreDirMaxLength: modules.virtualStoreDirMaxLength,
    };
  });

const previewWorkflowApiLockImporterDependencies = (
  importer: Schema.Schema.Type<typeof previewWorkflowApiLockImporterSchema>,
) => ({
  ...importer.dependencies,
  ...importer.optionalDependencies,
  ...importer.devDependencies,
});

const previewWorkflowApiManifestDependencies = (manifest: PreviewWorkflowApiPackageManifest) => ({
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.devDependencies,
  ...manifest.peerDependencies,
});

const previewWorkflowApiExpectedSpecifiers = (
  name: string,
  version: string,
  inputs: {
    readonly catalogs: Readonly<Record<string, string>>;
    readonly overrides: Readonly<Record<string, string>>;
  },
) =>
  new Set([
    version,
    ...(version === "catalog:" && inputs.catalogs[name] !== undefined
      ? [inputs.catalogs[name]!]
      : []),
    ...(inputs.overrides[name] === undefined ? [] : [inputs.overrides[name]!]),
  ]);

const validatePreviewWorkflowApiManifestLockImporter = (
  importerName: string,
  manifest: PreviewWorkflowApiPackageManifest,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  inputs: {
    readonly catalogs: Readonly<Record<string, string>>;
    readonly overrides: Readonly<Record<string, string>>;
  },
) =>
  Effect.gen(function* () {
    const importer = lockfile.importers[importerName];
    if (importer === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-lock-importer:${importerName}`,
        }),
      );
    const declared = previewWorkflowApiManifestDependencies(manifest);
    const resolved = previewWorkflowApiLockImporterDependencies(importer);
    for (const [name, resolution] of Object.entries(resolved)) {
      const declaredVersion = declared[name];
      if (
        declaredVersion === undefined ||
        !previewWorkflowApiExpectedSpecifiers(name, declaredVersion, inputs).has(
          resolution.specifier,
        )
      )
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-lock-declaration:${importerName}:${name}`,
          }),
        );
    }
    for (const name of Object.keys(declared)) {
      if (resolved[name] === undefined)
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-lock-resolution:${importerName}:${name}`,
          }),
        );
    }
    return importer;
  });

const previewWorkflowApiLockPackageId = (dependencyName: string, version: string) => {
  const resolution = version.startsWith("npm:") ? version.slice("npm:".length) : version;
  return /^\d/.test(resolution) ? `${dependencyName}@${resolution}` : resolution;
};

const previewWorkflowApiPackageLockKey = (
  packageId: string,
  lockfile: PreviewWorkflowApiPnpmLockfile,
) =>
  Object.keys(lockfile.packages)
    .filter((key) => packageId === key || packageId.startsWith(`${key}(`))
    .sort((left, right) => right.length - left.length)[0];

const previewWorkflowApiPackageNameAndVersion = (packageKey: string) => {
  const nameEnd = packageKey.startsWith("@")
    ? packageKey.indexOf("@", packageKey.indexOf("/") + 1)
    : packageKey.indexOf("@");
  if (nameEnd <= 0) return undefined;
  const version = packageKey.slice(nameEnd + 1).split("(", 1)[0];
  if (version === undefined || version.length === 0) return undefined;
  return { name: packageKey.slice(0, nameEnd), version };
};

const previewWorkflowApiPnpmStoreDirectory = (packageId: string, maxLength: number) => {
  let filename = packageId.startsWith("/") ? packageId.slice(1) : packageId;
  filename = filename.replace(/[\\/:*?"<>|#]/g, "+");
  if (filename.includes("(")) filename = filename.replace(/\)$/, "").replace(/\)\(|\(|\)/g, "_");
  if (
    filename.length > maxLength ||
    (filename !== filename.toLowerCase() && !filename.startsWith("file+"))
  ) {
    const hash = createHash("sha256").update(filename).digest("hex").slice(0, 32);
    return `${filename.slice(0, maxLength - 33)}_${hash}`;
  }
  return filename;
};

const previewWorkflowApiIntegrityIsValid = (integrity: string | undefined) => {
  if (integrity === undefined) return false;
  const match = integrity.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/);
  if (match === null) return false;
  let expectedBytes = 64;
  if (match[1] === "sha256") expectedBytes = 32;
  else if (match[1] === "sha384") expectedBytes = 48;
  const decoded = Buffer.from(match[2]!, "base64");
  return (
    decoded.byteLength === expectedBytes &&
    decoded.toString("base64").replace(/=+$/, "") === match[2]!.replace(/=+$/, "")
  );
};

const previewWorkflowApiRootRunnerLockDependency = (lockfile: PreviewWorkflowApiPnpmLockfile) =>
  Effect.gen(function* () {
    const rootImporter = lockfile.importers["."];
    const rootTsx = rootImporter?.devDependencies?.tsx ?? rootImporter?.dependencies?.tsx;
    if (rootTsx === undefined || rootTsx.version.startsWith("link:"))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "candidate-runner-lock-resolution",
        }),
      );
    return { name: "tsx", version: rootTsx.version };
  });

const previewWorkflowApiWorkspaceRuntimeLockDependencies = (
  lockfile: PreviewWorkflowApiPnpmLockfile,
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
  packageName: string,
) =>
  Effect.gen(function* () {
    const manifest = yield* workspacePackageManifest(packageName, manifests);
    const importer = lockfile.importers[`packages/${packageName}`];
    if (importer === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-lock-importer:packages/${packageName}`,
        }),
      );
    const runtimeDependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    const resolved = previewWorkflowApiLockImporterDependencies(importer);
    const dependencies: Array<{ readonly name: string; readonly version: string }> = [];
    for (const name of Object.keys(runtimeDependencies)) {
      const resolution = resolved[name];
      if (resolution === undefined)
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-lock-resolution:packages/${packageName}:${name}`,
          }),
        );
      if (!resolution.version.startsWith("link:"))
        dependencies.push({ name, version: resolution.version });
    }
    return dependencies;
  });

const previewWorkflowApiDirectRuntimeLockDependencies = (
  lockfile: PreviewWorkflowApiPnpmLockfile,
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
  workspacePackageNames: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const dependencies = [yield* previewWorkflowApiRootRunnerLockDependency(lockfile)];
    for (const packageName of workspacePackageNames)
      dependencies.push(
        ...(yield* previewWorkflowApiWorkspaceRuntimeLockDependencies(
          lockfile,
          manifests,
          packageName,
        )),
      );
    return dependencies;
  });

const previewWorkflowApiExpandLockPackageClosure = (
  lockfile: PreviewWorkflowApiPnpmLockfile,
  pending: Array<{ readonly name: string; readonly version: string }>,
) =>
  Effect.gen(function* () {
    const packageIds = new Set<string>();
    while (pending.length > 0) {
      const next = pending.pop()!;
      const packageId = previewWorkflowApiLockPackageId(next.name, next.version);
      if (packageIds.has(packageId)) continue;
      const packageKey = previewWorkflowApiPackageLockKey(packageId, lockfile);
      const snapshot = lockfile.snapshots[packageId];
      const metadata = packageKey === undefined ? undefined : lockfile.packages[packageKey];
      if (
        snapshot === undefined ||
        metadata === undefined ||
        !previewWorkflowApiIntegrityIsValid(metadata.resolution?.integrity)
      )
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-lock-integrity:${packageId}`,
          }),
        );
      packageIds.add(packageId);
      for (const [name, version] of Object.entries({
        ...snapshot.dependencies,
        ...snapshot.optionalDependencies,
      }))
        pending.push({ name, version });
    }
    return packageIds;
  });

const previewWorkflowApiPackageIdsForRuntime = (
  lockfile: PreviewWorkflowApiPnpmLockfile,
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
  workspacePackageNames: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const directDependencies = yield* previewWorkflowApiDirectRuntimeLockDependencies(
      lockfile,
      manifests,
      workspacePackageNames,
    );
    return yield* previewWorkflowApiExpandLockPackageClosure(lockfile, [...directDependencies]);
  });

const assertPreviewWorkflowApiPackageAllowed = (
  packageId: string,
  allowedPackageIds?: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    if (allowedPackageIds !== undefined && !allowedPackageIds.has(packageId))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-outside-locked-closure:${packageId}`,
        }),
      );
  });

const previewWorkflowApiLockedPackageIdentity = (
  packageId: string,
  lockfile: PreviewWorkflowApiPnpmLockfile,
) =>
  Effect.gen(function* () {
    const packageKey = previewWorkflowApiPackageLockKey(packageId, lockfile);
    const packageInfo =
      packageKey === undefined ? undefined : previewWorkflowApiPackageNameAndVersion(packageKey);
    const lockMetadata = packageKey === undefined ? undefined : lockfile.packages[packageKey];
    const integrity = lockMetadata?.resolution?.integrity;
    const snapshot = lockfile.snapshots[packageId];
    if (
      packageInfo === undefined ||
      snapshot === undefined ||
      lockMetadata === undefined ||
      integrity === undefined ||
      !previewWorkflowApiIntegrityIsValid(integrity)
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-lock-identity:${packageId}`,
        }),
      );
    return { packageInfo, snapshot, integrity };
  });

const previewWorkflowApiRuntimeArtifactAttestationsPath =
  "preview-workflow-api-runtime-attestations.json";

const previewWorkflowApiValidateEmptyRuntimeArtifactPlaceholder = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  Effect.gen(function* () {
    const attestationBytes = previewWorkflowApiEntriesByPath(entries).get(
      previewWorkflowApiRuntimeArtifactAttestationsPath,
    );
    if (attestationBytes === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-artifact-attestation-missing",
        }),
      );
    const placeholder = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(PreviewWorkflowApiRuntimeArtifactAttestationsSchema)(
          JSON.parse(new TextDecoder().decode(attestationBytes)),
        ),
      catch: () =>
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-artifact-attestation-invalid",
        }),
    });
    if (Object.keys(placeholder.packages).length !== 0)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-artifact-source-policy-untrusted",
        }),
      );
  });

const previewWorkflowApiCloneTrustedRuntimeArtifactAttestations = (
  attestations: PreviewWorkflowApiRuntimeArtifactAttestations,
) =>
  Schema.decodeUnknownSync(PreviewWorkflowApiRuntimeArtifactAttestationsSchema)(
    JSON.parse(JSON.stringify(attestations)),
  );

const previewWorkflowApiCopyTrustedRuntimeArtifactAttestations = (
  attestations: PreviewWorkflowApiRuntimeArtifactAttestations | undefined,
) =>
  attestations === undefined
    ? Effect.succeed(undefined)
    : Effect.try({
        try: () => previewWorkflowApiCloneTrustedRuntimeArtifactAttestations(attestations),
        catch: () =>
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: "dependency-artifact-attestation-provider-invalid",
          }),
      });

const previewWorkflowApiResolveTrustedRuntimeArtifactAttestations = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  allowedPackageIds: ReadonlySet<string>,
  trustedRuntimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations | undefined,
) =>
  Effect.gen(function* () {
    yield* previewWorkflowApiValidateEmptyRuntimeArtifactPlaceholder(entries);
    if (trustedRuntimeArtifactAttestations === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-artifact-attestation-provider-unavailable",
        }),
      );
    const attestations = yield* Effect.try({
      try: () =>
        previewWorkflowApiCloneTrustedRuntimeArtifactAttestations(
          trustedRuntimeArtifactAttestations,
        ),
      catch: () =>
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-artifact-attestation-provider-invalid",
        }),
    });
    for (const packageId of allowedPackageIds) {
      const attestation = attestations.packages[packageId];
      if (attestation === undefined)
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-artifact-attestation-missing:${packageId}`,
          }),
        );
      const lockIdentity = yield* previewWorkflowApiLockedPackageIdentity(packageId, lockfile);
      if (
        !previewWorkflowApiIntegrityIsValid(attestation.integrity) ||
        attestation.integrity !== lockIdentity.integrity
      )
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-artifact-lock-identity:${packageId}`,
          }),
        );
    }
    return attestations;
  });

const previewWorkflowApiVerifyOneRuntimeArtifactAttestation = (
  packageId: string,
  attestation: { readonly integrity: string; readonly runtimeDigest: string | null },
  runtimePackageDigests: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* () {
    if ((runtimePackageDigests.get(packageId) ?? null) !== attestation.runtimeDigest)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-artifact-runtime-identity:${packageId}`,
        }),
      );
  });

const previewWorkflowApiVerifyRuntimeArtifactAttestations = (
  attestations: PreviewWorkflowApiRuntimeArtifactAttestations,
  allowedPackageIds: ReadonlySet<string>,
  runtimePackageDigests: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      [...allowedPackageIds].sort(),
      (packageId) => {
        const attestation = attestations.packages[packageId];
        return attestation === undefined
          ? Effect.fail(
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: `dependency-artifact-attestation-missing:${packageId}`,
              }),
            )
          : previewWorkflowApiVerifyOneRuntimeArtifactAttestation(
              packageId,
              attestation,
              runtimePackageDigests,
            );
      },
      { concurrency: 1 },
    );
  });

const readPreviewWorkflowApiInstalledPackageManifest = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  packagePath: string,
  packageId: string,
) =>
  Effect.gen(function* () {
    const packageJsonPath = path.join(packagePath, "package.json");
    const packageJsonRealPath = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(packageJsonPath),
      `dependency-package-manifest-realpath:${packageId}`,
    );
    if (
      !pathIsWithin(checkoutRoot, packageJsonRealPath) ||
      !pathIsWithin(packagePath, packageJsonRealPath)
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-package-manifest-outside-root:${packageId}`,
        }),
      );
    const packageJsonBytes = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.readFile(packageJsonPath),
      `dependency-package-manifest:${packageId}`,
    );
    return yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(
          Schema.Struct({
            name: Schema.String,
            version: Schema.String,
            bin: Schema.optional(
              Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.String)]),
            ),
          }),
        )(JSON.parse(new TextDecoder().decode(packageJsonBytes))),
      catch: () =>
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-package-manifest:${packageId}`,
        }),
    });
  });

const assertPreviewWorkflowApiInstalledPackageManifestMatches = (
  packageId: string,
  lockIdentity: { readonly packageInfo: { readonly name: string; readonly version: string } },
  manifest: { readonly name: string; readonly version: string },
) =>
  Effect.gen(function* () {
    if (
      manifest.name !== lockIdentity.packageInfo.name ||
      manifest.version !== lockIdentity.packageInfo.version
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-lock-identity:${packageId}`,
        }),
      );
  });

const assertPreviewWorkflowApiInstalledPackagePath = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  packagePath: string,
  packageId: string,
) =>
  Effect.gen(function* () {
    const realPackagePath = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(packagePath),
      `dependency-package-realpath:${packageId}`,
    );
    if (!pathIsWithin(checkoutRoot, realPackagePath) || realPackagePath !== packagePath)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-package-outside-root:${packageId}`,
        }),
      );
  });

const readPreviewWorkflowApiPnpmStorePackageIndexes = (
  storeIndexPath: string,
  packages: ReadonlyArray<PreviewWorkflowApiPnpmStorePackageReference>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqliteClient.SqliteClient;
      const indexes = new Map<string, PreviewWorkflowApiPnpmStorePackageIndex>();
      yield* Effect.forEach(
        packages,
        (packageReference) =>
          Effect.gen(function* () {
            const key = `${packageReference.integrity}\t${packageReference.packageInfo.name}@${packageReference.packageInfo.version}`;
            const rows = yield* sql`SELECT data FROM package_index WHERE key = ${key}`;
            if (rows.length === 0) return;
            const row = rows[0];
            const bytes =
              row !== undefined && typeof row === "object" && row !== null && "data" in row
                ? row.data
                : undefined;
            if (!(bytes instanceof Uint8Array))
              return yield* Effect.fail(
                new PreviewWorkflowApiHostError({
                  reason: "workflow-source-unavailable",
                  phase: `dependency-store-index:${packageReference.packageId}`,
                }),
              );
            const index = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(previewWorkflowApiPnpmStorePackageIndexSchema)(
                  unpack(bytes),
                ),
              catch: () =>
                new PreviewWorkflowApiHostError({
                  reason: "workflow-source-unavailable",
                  phase: `dependency-store-index:${packageReference.packageId}`,
                }),
            });
            if (
              index.manifest.name !== packageReference.packageInfo.name ||
              index.manifest.version !== packageReference.packageInfo.version
            )
              return yield* Effect.fail(
                new PreviewWorkflowApiHostError({
                  reason: "workflow-source-unavailable",
                  phase: `dependency-store-identity:${packageReference.packageId}`,
                }),
              );
            indexes.set(packageReference.packageId, index);
          }),
        { concurrency: 1 },
      );
      return indexes satisfies PreviewWorkflowApiPnpmStorePackageIndexes;
    }).pipe(
      Effect.provide(
        SqliteClient.layer({ filename: storeIndexPath, readonly: true, disableWAL: true }),
      ),
      Effect.mapError((error) => workflowApiStageError(error, "dependency-store-index")),
    ),
  );

const previewWorkflowApiUnifiedPatchHunkCounts = (header: string | undefined) => {
  const match =
    header === undefined ? null : /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (match === null) throw new Error("patch contains an invalid hunk header");
  const counts = {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
  if (!Object.values(counts).every(Number.isSafeInteger))
    throw new Error("patch hunk line counts are invalid");
  return counts;
};

const previewWorkflowApiUnifiedPatchOperation = (lines: ReadonlyArray<string>, index: number) => {
  const line = lines[index];
  if (line === undefined) throw new Error("patch hunk ended before its declared line counts");
  const kind = ({ " ": "context", "+": "add", "-": "remove" } as const)[line[0] ?? ""];
  if (kind === undefined) throw new Error("patch hunk contains an unsupported operation");
  const noNewline = lines[index + 1] === "\\ No newline at end of file";
  return {
    operation: {
      kind,
      text: line.slice(1),
      noNewline,
    } satisfies PreviewWorkflowApiUnifiedPatchOperation,
    oldLines: Number(kind !== "add"),
    newLines: Number(kind !== "remove"),
    next: index + (noNewline ? 2 : 1),
  };
};

const previewWorkflowApiUnifiedPatchOperations = (
  lines: ReadonlyArray<string>,
  start: number,
  oldCount: number,
  newCount: number,
) => {
  let oldSeen = 0;
  let newSeen = 0;
  let index = start;
  const operations: PreviewWorkflowApiUnifiedPatchOperation[] = [];
  while (oldSeen < oldCount || newSeen < newCount) {
    const parsed = previewWorkflowApiUnifiedPatchOperation(lines, index);
    oldSeen += parsed.oldLines;
    newSeen += parsed.newLines;
    if (oldSeen > oldCount || newSeen > newCount)
      throw new Error("patch hunk exceeds its declared line counts");
    operations.push(parsed.operation);
    index = parsed.next;
  }
  return { operations, next: index };
};

const parsePreviewWorkflowApiUnifiedPatchHunk = (lines: ReadonlyArray<string>, start: number) => {
  const counts = previewWorkflowApiUnifiedPatchHunkCounts(lines[start]);
  const parsed = previewWorkflowApiUnifiedPatchOperations(
    lines,
    start + 1,
    counts.oldCount,
    counts.newCount,
  );
  return {
    hunk: { ...counts, operations: parsed.operations } satisfies PreviewWorkflowApiUnifiedPatchHunk,
    next: parsed.next,
  };
};

const previewWorkflowApiUnifiedPatchFilePath = (
  lines: ReadonlyArray<string>,
  index: number,
  existing: ReadonlyMap<string, PreviewWorkflowApiUnifiedPatchFile>,
) => {
  const oldHeader = lines[index];
  if (oldHeader === undefined || !oldHeader.startsWith("--- a/"))
    throw new Error("patch file header is missing");
  const relativePath = oldHeader.slice("--- a/".length);
  if (
    !previewWorkflowApiStoreIndexPathIsSafe(relativePath) ||
    lines[index + 1] !== `+++ b/${relativePath}` ||
    existing.has(relativePath)
  )
    throw new Error("patch contains an unsupported file path or rename");
  return relativePath;
};

const previewWorkflowApiUnifiedPatchFileHunks = (lines: ReadonlyArray<string>, start: number) => {
  let index = start;
  const hunks: PreviewWorkflowApiUnifiedPatchHunk[] = [];
  while (index < lines.length) {
    const header = lines[index];
    if (header?.startsWith("@@ ")) {
      const parsed = parsePreviewWorkflowApiUnifiedPatchHunk(lines, index);
      hunks.push(parsed.hunk);
      index = parsed.next;
    } else if (header?.startsWith("--- a/") || header?.startsWith("diff --git ")) break;
    else index += 1;
  }
  if (hunks.length === 0) throw new Error("patch file contains no hunks");
  return { hunks, next: index };
};

const parsePreviewWorkflowApiUnifiedPatch = (
  patchBytes: Uint8Array,
): ReadonlyMap<string, PreviewWorkflowApiUnifiedPatchFile> => {
  const patchText = new TextDecoder("utf-8", { fatal: true }).decode(patchBytes);
  const lines = patchText
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.at(-1) === "") lines.pop();
  const files = new Map<string, PreviewWorkflowApiUnifiedPatchFile>();
  let index = 0;
  while (index < lines.length) {
    const oldHeader = lines[index];
    if (oldHeader === undefined || !oldHeader.startsWith("--- a/")) {
      index += 1;
      continue;
    }
    const relativePath = previewWorkflowApiUnifiedPatchFilePath(lines, index, files);
    const parsed = previewWorkflowApiUnifiedPatchFileHunks(lines, index + 2);
    files.set(relativePath, { relativePath, hunks: parsed.hunks });
    index = parsed.next;
  }
  if (files.size === 0) throw new Error("patch contains no supported file changes");
  return files;
};

type PreviewWorkflowApiPatchApplyState = {
  readonly sourceHasFinalNewline: boolean;
  readonly sourceLines: ReadonlyArray<string>;
  sourceIndex: number;
  readonly resultLines: Array<string>;
  resultHasFinalNewline: boolean;
  unterminatedResultLine?: number;
};

const applyPreviewWorkflowApiPatchOperation = (
  state: PreviewWorkflowApiPatchApplyState,
  operation: PreviewWorkflowApiUnifiedPatchOperation,
) => {
  if (operation.kind !== "add") {
    const sourceLine = state.sourceLines[state.sourceIndex];
    if (sourceLine !== operation.text)
      throw new Error("patch context does not match the lock-keyed package content");
    if (
      operation.noNewline &&
      (state.sourceIndex !== state.sourceLines.length - 1 || state.sourceHasFinalNewline)
    )
      throw new Error("patch source newline marker does not match package content");
    state.sourceIndex += 1;
  }
  if (operation.kind !== "remove") {
    state.resultLines.push(operation.text);
    if (operation.noNewline) state.unterminatedResultLine = state.resultLines.length - 1;
  }
};

const previewWorkflowApiPatchHunkOffsets = (hunk: PreviewWorkflowApiUnifiedPatchHunk) => ({
  oldOffset: hunk.oldStart === 0 ? 0 : hunk.oldStart - 1,
  newOffset: hunk.newStart === 0 ? 0 : hunk.newStart - 1,
});

const previewWorkflowApiAdvancePatchContext = (
  state: PreviewWorkflowApiPatchApplyState,
  oldOffset: number,
  newOffset: number,
) => {
  if (oldOffset < state.sourceIndex || oldOffset > state.sourceLines.length)
    throw new Error("patch hunk does not match the source line positions");
  state.resultLines.push(...state.sourceLines.slice(state.sourceIndex, oldOffset));
  state.sourceIndex = oldOffset;
  if (newOffset !== state.resultLines.length)
    throw new Error("patch hunk does not match the patched line positions");
};

const previewWorkflowApiPatchHunkReachesEnd = (
  state: PreviewWorkflowApiPatchApplyState,
  hunk: PreviewWorkflowApiUnifiedPatchHunk,
) =>
  hunk.oldStart + hunk.oldCount - 1 === state.sourceLines.length &&
  hunk.newStart + hunk.newCount - 1 === state.resultLines.length;

const applyPreviewWorkflowApiUnifiedPatchHunk = (
  state: PreviewWorkflowApiPatchApplyState,
  hunk: PreviewWorkflowApiUnifiedPatchHunk,
) => {
  const { oldOffset, newOffset } = previewWorkflowApiPatchHunkOffsets(hunk);
  previewWorkflowApiAdvancePatchContext(state, oldOffset, newOffset);
  for (const operation of hunk.operations) applyPreviewWorkflowApiPatchOperation(state, operation);
  if (state.resultLines.length !== newOffset + hunk.newCount)
    throw new Error("patch hunk output does not match its declared line count");
  if (previewWorkflowApiPatchHunkReachesEnd(state, hunk)) state.resultHasFinalNewline = true;
};

const applyPreviewWorkflowApiUnifiedPatch = (
  sourceBytes: Uint8Array,
  filePatch: PreviewWorkflowApiUnifiedPatchFile,
): Uint8Array => {
  const sourceText = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  const sourceHasFinalNewline = sourceText.endsWith("\n");
  const sourceLines = sourceText.split("\n");
  if (sourceHasFinalNewline) sourceLines.pop();
  const state: PreviewWorkflowApiPatchApplyState = {
    sourceHasFinalNewline,
    sourceLines,
    sourceIndex: 0,
    resultLines: [],
    resultHasFinalNewline: sourceHasFinalNewline,
  };
  for (const hunk of filePatch.hunks) applyPreviewWorkflowApiUnifiedPatchHunk(state, hunk);
  state.resultLines.push(...sourceLines.slice(state.sourceIndex));
  if (state.unterminatedResultLine !== undefined) {
    if (
      state.unterminatedResultLine !== state.resultLines.length - 1 ||
      state.sourceIndex !== sourceLines.length
    )
      throw new Error("patch output newline marker is not at end of file");
    state.resultHasFinalNewline = false;
  }
  return Buffer.from(
    `${state.resultLines.join("\n")}${state.resultHasFinalNewline ? "\n" : ""}`,
    "utf8",
  );
};

const previewWorkflowApiPackageBinaryPaths = (
  packageId: string,
  manifest: { readonly bin?: string | Readonly<Record<string, string>> | undefined },
) =>
  Effect.try({
    try: () => {
      let binaries: ReadonlyArray<string>;
      if (manifest.bin === undefined) binaries = [];
      else if (typeof manifest.bin === "string") binaries = [manifest.bin];
      else binaries = Object.values(manifest.bin);
      const paths = new Set<string>();
      for (const binary of binaries) {
        if (binary.includes("\\") || path.posix.isAbsolute(binary))
          throw new Error("invalid package binary path");
        const relativePath = path.posix.normalize(binary);
        const segments = relativePath.split("/");
        if (
          relativePath.length === 0 ||
          relativePath === "." ||
          segments.some((segment) => segment.length === 0 || segment === "..")
        )
          throw new Error("invalid package binary path");
        paths.add(relativePath);
      }
      return paths;
    },
    catch: () =>
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: `dependency-package-bin:${packageId}`,
      }),
  });

const previewWorkflowApiPatchIdentity = (
  packageLocator: string,
  lockHashes: Readonly<Record<string, string>>,
  workspacePatchedDependencies: Readonly<Record<string, string>>,
  rootPatchedDependencies: Readonly<Record<string, string>>,
) =>
  Effect.try({
    try: () => {
      const workspacePath = workspacePatchedDependencies[packageLocator];
      const rootPath = rootPatchedDependencies[packageLocator];
      const patchPath = workspacePath ?? rootPath;
      const patchHash = lockHashes[packageLocator];
      if (
        patchPath === undefined ||
        patchHash === undefined ||
        (workspacePath !== undefined && rootPath !== undefined && workspacePath !== rootPath) ||
        !/^[a-f0-9]{64}$/.test(patchHash)
      )
        throw new Error("patch identity is incomplete");
      return { patchPath, patchHash };
    },
    catch: () =>
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: `dependency-patch-lock-identity:${packageLocator}`,
      }),
  });

const previewWorkflowApiPatchBytes = (
  packageLocator: string,
  patchPath: string,
  patchHash: string,
  entriesByPath: ReadonlyMap<string, Uint8Array>,
) =>
  Effect.gen(function* () {
    const patchBytes = entriesByPath.get(patchPath);
    if (
      patchBytes === undefined ||
      createHash("sha256").update(patchBytes).digest("hex") !== patchHash
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-patch-content:${packageLocator}`,
        }),
      );
    return patchBytes;
  });

const previewWorkflowApiLoadPatchedPackage = (
  packageLocator: string,
  lockHashes: Readonly<Record<string, string>>,
  workspacePatchedDependencies: Readonly<Record<string, string>>,
  rootPatchedDependencies: Readonly<Record<string, string>>,
  entriesByPath: ReadonlyMap<string, Uint8Array>,
) =>
  Effect.gen(function* () {
    const { patchPath, patchHash } = yield* previewWorkflowApiPatchIdentity(
      packageLocator,
      lockHashes,
      workspacePatchedDependencies,
      rootPatchedDependencies,
    );
    const patchBytes = yield* previewWorkflowApiPatchBytes(
      packageLocator,
      patchPath,
      patchHash,
      entriesByPath,
    );
    const files = yield* Effect.try({
      try: () => parsePreviewWorkflowApiUnifiedPatch(patchBytes),
      catch: () =>
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-patch-files:${packageLocator}`,
        }),
    });
    return { packageId: packageLocator, packageLocator, patchHash, patchPath, files };
  });

const previewWorkflowApiPatchedPackages = (
  lockfile: PreviewWorkflowApiPnpmLockfile,
  workspacePatchedDependencies: Readonly<Record<string, string>>,
  rootPatchedDependencies: Readonly<Record<string, string>>,
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  Effect.gen(function* () {
    const lockHashes = lockfile.patchedDependencies ?? {};
    const locators = new Set([
      ...Object.keys(lockHashes),
      ...Object.keys(workspacePatchedDependencies),
      ...Object.keys(rootPatchedDependencies),
    ]);
    const entriesByPath = previewWorkflowApiEntriesByPath(entries);
    const patched = new Map<string, PreviewWorkflowApiPatchedPackage>();
    for (const packageLocator of [...locators].sort())
      patched.set(
        packageLocator,
        yield* previewWorkflowApiLoadPatchedPackage(
          packageLocator,
          lockHashes,
          workspacePatchedDependencies,
          rootPatchedDependencies,
          entriesByPath,
        ),
      );
    return patched;
  });

type PreviewWorkflowApiFramedSha256 = {
  readonly update: (value: string) => void;
  readonly digest: () => string;
};

const previewWorkflowApiFramedSha256 = (domain: string): PreviewWorkflowApiFramedSha256 => {
  const hash = createHash("sha256");
  const update = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length).update(bytes);
  };
  update(domain);
  return { update, digest: () => `sha256:${hash.digest("hex")}` };
};

const previewWorkflowApiDependencyClosureDigest = (
  baseDigest: string,
  allowedPackageIds: ReadonlySet<string>,
  runtimePackageDigests: ReadonlyMap<string, string>,
) => {
  const digest = previewWorkflowApiFramedSha256("tiara-preview-verified-runtime-closure-v1");
  digest.update(baseDigest);
  for (const packageId of [...allowedPackageIds].sort()) {
    digest.update(packageId);
    digest.update(runtimePackageDigests.get(packageId) ?? "runtime-package-absent");
  }
  return digest.digest();
};

const previewWorkflowApiStoreIndexFileIsValid = (
  file: PreviewWorkflowApiPnpmStorePackageIndex["files"][string] | undefined,
): file is NonNullable<PreviewWorkflowApiPnpmStorePackageIndex["files"][string]> =>
  file !== undefined &&
  file.symlink === undefined &&
  /^[a-f0-9]{128}$/.test(file.digest) &&
  Number.isSafeInteger(file.size) &&
  file.size >= 0 &&
  Number.isInteger(file.mode);

const previewWorkflowApiStoreIndexPathIsSafe = (relativePath: string) => {
  const segments = relativePath.split("/");
  return (
    relativePath.length > 0 &&
    !path.posix.isAbsolute(relativePath) &&
    segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..") &&
    segments[0] !== "node_modules" &&
    segments[0] !== ".bin"
  );
};

const previewWorkflowApiAttestStoreIndexFile = (
  digest: PreviewWorkflowApiFramedSha256,
  packageId: string,
  relativePath: string,
  file: PreviewWorkflowApiPnpmStorePackageIndex["files"][string] | undefined,
) =>
  Effect.gen(function* () {
    if (
      !previewWorkflowApiStoreIndexFileIsValid(file) ||
      !previewWorkflowApiStoreIndexPathIsSafe(relativePath)
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-file-index:${packageId}`,
        }),
      );
    digest.update(relativePath);
    digest.update(file.digest);
    digest.update(String(file.size));
    digest.update(String(file.mode));
  });

const previewWorkflowApiAttestLockedPackage = (
  digest: PreviewWorkflowApiFramedSha256,
  packageReference: PreviewWorkflowApiPnpmStorePackageReference,
  indexes: PreviewWorkflowApiPnpmStorePackageIndexes,
  patchedPackages: ReadonlyMap<string, PreviewWorkflowApiPatchedPackage>,
) =>
  Effect.gen(function* () {
    digest.update(packageReference.packageId);
    digest.update(packageReference.packageInfo.name);
    digest.update(packageReference.packageInfo.version);
    digest.update(packageReference.integrity);
    const packageLocator = `${packageReference.packageInfo.name}@${packageReference.packageInfo.version}`;
    const patchedPackage = patchedPackages.get(packageLocator);
    const packageIdSuffix = packageReference.packageId.startsWith(packageLocator)
      ? packageReference.packageId.slice(packageLocator.length)
      : undefined;
    const patchHashFromPackageId = packageIdSuffix?.match(/^\(patch_hash=([a-f0-9]{64})\)/)?.[1];
    if (
      (patchedPackage === undefined) !== (patchHashFromPackageId === undefined) ||
      (patchedPackage !== undefined && patchedPackage.patchHash !== patchHashFromPackageId)
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-patch-resolution:${packageReference.packageId}`,
        }),
      );
    if (patchedPackage !== undefined) {
      digest.update(patchedPackage.patchPath);
      digest.update(patchedPackage.patchHash);
    }
    const index = indexes.get(packageReference.packageId);
    if (index === undefined) {
      digest.update("store-index-unavailable");
      return;
    }
    digest.update("store-index-present");
    for (const relativePath of Object.keys(index.files).sort())
      yield* previewWorkflowApiAttestStoreIndexFile(
        digest,
        packageReference.packageId,
        relativePath,
        index.files[relativePath],
      );
  });

const previewWorkflowApiDependencyClosureAttestation = (
  storeIndexPath: string,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  allowedPackageIds: ReadonlySet<string>,
  workspacePatchedDependencies: Readonly<Record<string, string>>,
  rootPatchedDependencies: Readonly<Record<string, string>>,
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  Effect.gen(function* () {
    const patchedPackages = yield* previewWorkflowApiPatchedPackages(
      lockfile,
      workspacePatchedDependencies,
      rootPatchedDependencies,
      entries,
    );
    const packages = yield* Effect.forEach(
      [...allowedPackageIds].sort(),
      (packageId) =>
        Effect.map(previewWorkflowApiLockedPackageIdentity(packageId, lockfile), (identity) => ({
          packageId,
          integrity: identity.integrity,
          packageInfo: identity.packageInfo,
        })),
      { concurrency: 1 },
    );
    const indexes = yield* readPreviewWorkflowApiPnpmStorePackageIndexes(storeIndexPath, packages);
    const digest = previewWorkflowApiFramedSha256("tiara-preview-pnpm-runtime-closure-v1");
    for (const packageReference of packages)
      yield* previewWorkflowApiAttestLockedPackage(
        digest,
        packageReference,
        indexes,
        patchedPackages,
      );
    return {
      baseDigest: digest.digest(),
      indexes,
      packages,
      patchedPackages,
    };
  });

const previewWorkflowApiPackageFilePaths = (
  fileSystem: FileSystem.FileSystem,
  packageRoot: string,
  packageId: string,
): Effect.Effect<ReadonlyArray<string>, PreviewWorkflowApiHostError> => {
  const visit = (
    directory: string,
    prefix: string,
  ): Effect.Effect<ReadonlyArray<string>, PreviewWorkflowApiHostError> =>
    Effect.gen(function* () {
      const children = yield* mapWorkflowApiSourceFileSystemError(
        fileSystem.readDirectory(directory),
        `dependency-package-files:${packageId}`,
      );
      const nested = yield* Effect.forEach([...children].sort(), (child) =>
        Effect.gen(function* () {
          if (prefix.length === 0 && (child === "node_modules" || child === ".bin")) return [];
          const absolute = path.join(directory, child);
          const link = yield* Effect.result(fileSystem.readLink(absolute));
          if (Result.isSuccess(link))
            return yield* Effect.fail(
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: `dependency-package-symlink:${packageId}`,
              }),
            );
          const info = yield* mapWorkflowApiSourceFileSystemError(
            fileSystem.stat(absolute),
            `dependency-package-files:${packageId}`,
          );
          const relative = prefix.length === 0 ? child : `${prefix}/${child}`;
          if (info.type === "Directory") return yield* visit(absolute, relative);
          if (info.type !== "File")
            return yield* Effect.fail(
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: `dependency-package-file-type:${packageId}`,
              }),
            );
          return [relative];
        }),
      );
      return nested.flat();
    });
  return visit(packageRoot, "");
};

const previewWorkflowApiIsGeneratedNativeModule = (relativePath: string) =>
  /^build\/(?:Release|Debug)\/[^/]+\.node$/.test(relativePath) ||
  /^prebuilds\/[A-Za-z0-9_.-]+\/[^/]+\.node$/.test(relativePath);

const previewWorkflowApiVerifiedPackagePaths = (
  fileSystem: FileSystem.FileSystem,
  packageRoot: string,
  packageId: string,
  index: PreviewWorkflowApiPnpmStorePackageIndex,
  patchedPackage: PreviewWorkflowApiPatchedPackage | undefined,
  binaryFiles: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const actualPaths = yield* previewWorkflowApiPackageFilePaths(
      fileSystem,
      packageRoot,
      packageId,
    );
    const indexedPaths = Object.keys(index.files);
    const generatedNativePaths = actualPaths.filter(
      (relativePath) => index.files[relativePath] === undefined,
    );
    const expectedPaths = [...indexedPaths, ...generatedNativePaths].sort();
    const actualPathSet = new Set(actualPaths);
    const patchedPaths = patchedPackage === undefined ? [] : [...patchedPackage.files.keys()];
    if (
      actualPathSet.size !== actualPaths.length ||
      actualPaths.length !== expectedPaths.length ||
      expectedPaths.some((relativePath) => !actualPathSet.has(relativePath)) ||
      generatedNativePaths.some(
        (relativePath) => !previewWorkflowApiIsGeneratedNativeModule(relativePath),
      ) ||
      patchedPaths.some((relativePath) => !expectedPaths.includes(relativePath)) ||
      [...binaryFiles].some((relativePath) => !expectedPaths.includes(relativePath))
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-files:${packageId}`,
        }),
      );
    return expectedPaths;
  });

const previewWorkflowApiReadContainedPackageFile = (
  fileSystem: FileSystem.FileSystem,
  packageRoot: string,
  packageId: string,
  relativePath: string,
) =>
  Effect.gen(function* () {
    if (!previewWorkflowApiStoreIndexPathIsSafe(relativePath))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-file-path:${packageId}`,
        }),
      );
    const absolute = path.resolve(packageRoot, ...relativePath.split("/"));
    if (!pathIsWithin(packageRoot, absolute))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-file-path:${packageId}`,
        }),
      );
    yield* assertSourcePathContained(
      fileSystem,
      packageRoot,
      absolute,
      `dependency-package-file-realpath:${packageId}`,
    );
    const bytes = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.readFile(absolute),
      `dependency-store-file:${packageId}`,
    );
    yield* assertSourcePathContained(
      fileSystem,
      packageRoot,
      absolute,
      `dependency-package-file-realpath:${packageId}`,
    );
    const info = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.stat(absolute),
      `dependency-store-file:${packageId}`,
    );
    return { bytes, info };
  });

// The CAS/index comparison detects install-store inconsistency; only the
// separately supplied runtime-owner attestation can establish trusted bytes.
const previewWorkflowApiPackageBytesFromVerifiedStoreIndex = (
  fileSystem: FileSystem.FileSystem,
  storeDirectory: string,
  packageId: string,
  relativePath: string,
  expected: PreviewWorkflowApiPnpmStorePackageIndex["files"][string] | undefined,
  filePatch: PreviewWorkflowApiUnifiedPatchFile | undefined,
) =>
  Effect.gen(function* () {
    if (expected === undefined) {
      if (filePatch === undefined) return undefined;
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-patch-unindexed-file:${packageId}:${relativePath}`,
        }),
      );
    }
    const contentAddressedPath = path.join(
      storeDirectory,
      "files",
      expected.digest.slice(0, 2),
      expected.digest.slice(2),
    );
    const contentAddressedRealPath = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(contentAddressedPath),
      `dependency-store-base-realpath:${packageId}`,
    );
    if (
      contentAddressedRealPath !== contentAddressedPath ||
      !pathIsWithin(storeDirectory, contentAddressedRealPath)
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-base-path:${packageId}`,
        }),
      );
    const baseBytes = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.readFile(contentAddressedRealPath),
      `dependency-store-base-file:${packageId}`,
    );
    if (
      baseBytes.byteLength !== expected.size ||
      createHash("sha512").update(baseBytes).digest("hex") !== expected.digest
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-base-content:${packageId}:${relativePath}`,
        }),
      );
    if (filePatch === undefined) return baseBytes;
    return yield* Effect.try({
      try: () => applyPreviewWorkflowApiUnifiedPatch(baseBytes, filePatch),
      catch: () =>
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-patch-application:${packageId}:${relativePath}`,
        }),
    });
  });

const previewWorkflowApiPackageFileModeMatches = (
  mode: "checkout" | "candidate",
  infoMode: number,
  runtimeMode: number,
  isIndexed: boolean,
) => {
  if (mode === "candidate") {
    if (!isIndexed) return (infoMode & 0o222) === 0;
    return (infoMode & 0o777) === (runtimeMode & 0o555);
  }
  if (!isIndexed) return true;
  return (infoMode & 0o555) === (runtimeMode & 0o555);
};

const previewWorkflowApiPackageFileContentMatches = (
  bytes: Uint8Array,
  actualDigest: string,
  expected: PreviewWorkflowApiPnpmStorePackageIndex["files"][string] | undefined,
  expectedBytes: Uint8Array | undefined,
) => {
  if (expectedBytes !== undefined) return Buffer.from(bytes).equals(Buffer.from(expectedBytes));
  if (expected === undefined) return true;
  return bytes.byteLength === expected.size && actualDigest === expected.digest;
};

const previewWorkflowApiPackageFileRuntimeMode = (
  expected: PreviewWorkflowApiPnpmStorePackageIndex["files"][string] | undefined,
  binaryFiles: ReadonlySet<string>,
  relativePath: string,
  actualMode: number,
) => {
  if (expected === undefined) return actualMode & 0o555;
  if (binaryFiles.has(relativePath)) return expected.mode | 0o111;
  return expected.mode;
};

const previewWorkflowApiPackageFileFailurePhase = (
  mode: "checkout" | "candidate",
  packageId: string,
  relativePath: string,
  patched: boolean,
) => {
  if (patched) return `dependency-patched-content:${packageId}:${relativePath}`;
  if (mode === "checkout") return `dependency-store-content:checkout:${packageId}:${relativePath}`;
  return `dependency-store-content:${packageId}:${relativePath}`;
};

const previewWorkflowApiVerifyOnePackageFile = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly packageRoot: string;
  readonly storeDirectory: string;
  readonly packageId: string;
  readonly index: PreviewWorkflowApiPnpmStorePackageIndex;
  readonly patchedPackage: PreviewWorkflowApiPatchedPackage | undefined;
  readonly binaryFiles: ReadonlySet<string>;
  readonly mode: "checkout" | "candidate";
  readonly digest: PreviewWorkflowApiFramedSha256;
  readonly relativePath: string;
}) =>
  Effect.gen(function* () {
    const expected = input.index.files[input.relativePath];
    if (expected !== undefined && !previewWorkflowApiStoreIndexFileIsValid(expected))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-file-index:${input.packageId}`,
        }),
      );
    const { bytes, info } = yield* previewWorkflowApiReadContainedPackageFile(
      input.fileSystem,
      input.packageRoot,
      input.packageId,
      input.relativePath,
    );
    if (info.type !== "File")
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-file-type:${input.packageId}:${input.relativePath}`,
        }),
      );
    const expectedBytes = yield* previewWorkflowApiPackageBytesFromVerifiedStoreIndex(
      input.fileSystem,
      input.storeDirectory,
      input.packageId,
      input.relativePath,
      expected,
      input.patchedPackage?.files.get(input.relativePath),
    );
    const runtimeMode = previewWorkflowApiPackageFileRuntimeMode(
      expected,
      input.binaryFiles,
      input.relativePath,
      info.mode,
    );
    if (
      !previewWorkflowApiPackageFileModeMatches(
        input.mode,
        info.mode,
        runtimeMode,
        expected !== undefined,
      )
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-store-mode:${input.mode}:${input.packageId}:${input.relativePath}`,
        }),
      );
    const actualDigest = createHash("sha512").update(bytes).digest("hex");
    if (!previewWorkflowApiPackageFileContentMatches(bytes, actualDigest, expected, expectedBytes))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: previewWorkflowApiPackageFileFailurePhase(
            input.mode,
            input.packageId,
            input.relativePath,
            input.patchedPackage?.files.has(input.relativePath) === true,
          ),
        }),
      );
    input.digest.update(input.relativePath);
    input.digest.update(actualDigest);
    input.digest.update(String(bytes.byteLength));
    input.digest.update(String(runtimeMode));
  });

const verifyPreviewWorkflowApiPnpmPackageFiles = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  packageRoot: string,
  storeDirectory: string,
  packageId: string,
  index: PreviewWorkflowApiPnpmStorePackageIndex,
  patchedPackage: PreviewWorkflowApiPatchedPackage | undefined,
  binaryFiles: ReadonlySet<string>,
  mode: "checkout" | "candidate",
): Effect.Effect<string, PreviewWorkflowApiHostError> =>
  Effect.gen(function* () {
    yield* assertPreviewWorkflowApiInstalledPackagePath(
      fileSystem,
      checkoutRoot,
      packageRoot,
      packageId,
    );
    const paths = yield* previewWorkflowApiVerifiedPackagePaths(
      fileSystem,
      packageRoot,
      packageId,
      index,
      patchedPackage,
      binaryFiles,
    );
    const digest = previewWorkflowApiFramedSha256("tiara-preview-package-runtime-files-v1");
    for (const relativePath of paths)
      yield* previewWorkflowApiVerifyOnePackageFile({
        fileSystem,
        packageRoot,
        storeDirectory,
        packageId,
        index,
        patchedPackage,
        binaryFiles,
        mode,
        digest,
        relativePath,
      });
    return digest.digest();
  });

const verifyPreviewWorkflowApiPnpmPackageClosure = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  storeDirectory: string,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  allowedPackageIds: ReadonlySet<string>,
  virtualStoreDirMaxLength: number,
  indexes: PreviewWorkflowApiPnpmStorePackageIndexes,
  patchedPackages: ReadonlyMap<string, PreviewWorkflowApiPatchedPackage>,
  mode: "checkout" | "candidate",
) =>
  Effect.gen(function* () {
    const packageDigests = new Map<string, string>();
    for (const packageId of [...allowedPackageIds].sort()) {
      const identity = yield* previewWorkflowApiLockedPackageIdentity(packageId, lockfile);
      const packagePath = path.join(
        checkoutRoot,
        "node_modules",
        ".pnpm",
        previewWorkflowApiPnpmStoreDirectory(packageId, virtualStoreDirMaxLength),
        "node_modules",
        ...identity.packageInfo.name.split("/"),
      );
      const exists = yield* mapWorkflowApiSourceFileSystemError(
        fileSystem.exists(packagePath),
        `dependency-package-exists:${packageId}`,
      );
      if (!exists) continue;
      const index = indexes.get(packageId);
      if (index === undefined)
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-store-index:${packageId}`,
          }),
        );
      const manifest = yield* readPreviewWorkflowApiInstalledPackageManifest(
        fileSystem,
        checkoutRoot,
        packagePath,
        packageId,
      );
      yield* assertPreviewWorkflowApiInstalledPackageManifestMatches(packageId, identity, manifest);
      const binaryFiles = yield* previewWorkflowApiPackageBinaryPaths(packageId, manifest);
      const packageLocator = `${identity.packageInfo.name}@${identity.packageInfo.version}`;
      const packageDigest = yield* verifyPreviewWorkflowApiPnpmPackageFiles(
        fileSystem,
        checkoutRoot,
        packagePath,
        storeDirectory,
        packageId,
        index,
        patchedPackages.get(packageLocator),
        binaryFiles,
        mode,
      );
      packageDigests.set(packageId, packageDigest);
    }
    return packageDigests;
  });

const validatePreviewWorkflowApiLockedPackage = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  packagePath: string,
  packageId: string,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  allowedPackageIds?: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    yield* assertPreviewWorkflowApiPackageAllowed(packageId, allowedPackageIds);
    const lockIdentity = yield* previewWorkflowApiLockedPackageIdentity(packageId, lockfile);
    const manifest = yield* readPreviewWorkflowApiInstalledPackageManifest(
      fileSystem,
      checkoutRoot,
      packagePath,
      packageId,
    );
    yield* assertPreviewWorkflowApiInstalledPackageManifestMatches(
      packageId,
      lockIdentity,
      manifest,
    );
    yield* assertPreviewWorkflowApiInstalledPackagePath(
      fileSystem,
      checkoutRoot,
      packagePath,
      packageId,
    );
  });

type PreviewWorkflowApiModuleVisitor = (
  directory: string,
  prefix: string,
) => Effect.Effect<void, PreviewWorkflowApiHostError>;

const previewWorkflowApiIgnoredModuleEntries = new Set([
  ".pnpm",
  ".bin",
  ".modules.yaml",
  ".pnpm-workspace-state-v1.json",
  ".vite",
  ".vite-temp",
]);

const previewWorkflowApiVisitInstalledModuleChild = (
  fileSystem: FileSystem.FileSystem,
  directory: string,
  prefix: string,
  child: string,
  names: Array<string>,
  visit: PreviewWorkflowApiModuleVisitor,
) =>
  Effect.gen(function* () {
    if (previewWorkflowApiIgnoredModuleEntries.has(child)) return;
    const absolute = path.join(directory, child);
    const name = prefix.length === 0 ? child : `${prefix}/${child}`;
    const link = yield* Effect.result(fileSystem.readLink(absolute));
    if (Result.isSuccess(link)) {
      names.push(name);
      return;
    }
    const info = yield* mapWorkflowApiSourceFileSystemError(fileSystem.stat(absolute));
    if (info.type === "Directory" && child.startsWith("@")) {
      yield* visit(absolute, name);
      return;
    }
    return yield* Effect.fail(
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: `dependency-entry-not-link:${name}`,
      }),
    );
  });

const previewWorkflowApiVisitInstalledModuleDirectory = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  names: Array<string>,
  directory: string,
  prefix: string,
  visit: PreviewWorkflowApiModuleVisitor,
) =>
  Effect.gen(function* () {
    const realDirectory = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(directory),
      "dependency-scope-directory-realpath",
    );
    if (realDirectory !== directory || !pathIsWithin(checkoutRoot, realDirectory))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-scope-directory-outside-checkout",
        }),
      );
    const children = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.readDirectory(directory),
    );
    yield* Effect.forEach(children, (child) =>
      previewWorkflowApiVisitInstalledModuleChild(
        fileSystem,
        directory,
        prefix,
        child,
        names,
        visit,
      ),
    );
  });

const previewWorkflowApiInstalledModuleNames = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  moduleRoot: string,
): Effect.Effect<ReadonlyArray<string>, PreviewWorkflowApiHostError> =>
  Effect.gen(function* () {
    const exists = yield* mapWorkflowApiSourceFileSystemError(fileSystem.exists(moduleRoot));
    if (!exists) return [];
    const moduleRootRealPath = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(moduleRoot),
      "dependency-node-modules-realpath",
    );
    if (moduleRootRealPath !== moduleRoot || !pathIsWithin(checkoutRoot, moduleRootRealPath))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-node-modules-outside-checkout",
        }),
      );
    const names: string[] = [];
    const visit: PreviewWorkflowApiModuleVisitor = (directory, prefix) =>
      previewWorkflowApiVisitInstalledModuleDirectory(
        fileSystem,
        checkoutRoot,
        names,
        directory,
        prefix,
        visit,
      );
    yield* visit(moduleRoot, "");
    return names.sort();
  });

const previewWorkflowApiValidateInstalledPackageLink = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  moduleRoot: string,
  importerName: string,
  dependencyName: string,
  resolution: Schema.Schema.Type<typeof previewWorkflowApiLockDependencySchema>,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  virtualStoreDirMaxLength: number,
  allowedPackageIds?: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const linkPath = path.join(moduleRoot, ...dependencyName.split("/"));
    const link = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.readLink(linkPath),
      `dependency-link:${importerName}:${dependencyName}`,
    );
    const resolved = path.resolve(path.dirname(linkPath), link);
    const realTarget = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(resolved),
      `dependency-link-realpath:${importerName}:${dependencyName}`,
    );
    if (!pathIsWithin(checkoutRoot, resolved) || realTarget !== resolved)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-link-outside-checkout",
        }),
      );

    if (resolution.version.startsWith("link:")) {
      yield* validatePreviewWorkflowApiWorkspacePackageTarget(
        checkoutRoot,
        importerName,
        dependencyName,
        resolution.version,
        realTarget,
      );
      return;
    }

    yield* validatePreviewWorkflowApiExternalPackageTarget(
      fileSystem,
      checkoutRoot,
      importerName,
      dependencyName,
      realTarget,
      resolution.version,
      lockfile,
      virtualStoreDirMaxLength,
      allowedPackageIds,
    );
  });

const validatePreviewWorkflowApiWorkspacePackageTarget = (
  checkoutRoot: string,
  importerName: string,
  dependencyName: string,
  version: string,
  realTarget: string,
) =>
  Effect.gen(function* () {
    const expected = path.resolve(
      checkoutRoot,
      importerName === "." ? "." : importerName,
      version.slice("link:".length),
    );
    if (realTarget !== expected || !previewWorkflowApiSourcePackages.has(path.basename(expected)))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `workspace-dependency-lock-target:${importerName}:${dependencyName}`,
        }),
      );
  });

const validatePreviewWorkflowApiExternalPackageTarget = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  importerName: string,
  dependencyName: string,
  realTarget: string,
  version: string,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  virtualStoreDirMaxLength: number,
  allowedPackageIds?: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const packageId = previewWorkflowApiLockPackageId(dependencyName, version);
    const packageKey = previewWorkflowApiPackageLockKey(packageId, lockfile);
    const packageInfo =
      packageKey === undefined ? undefined : previewWorkflowApiPackageNameAndVersion(packageKey);
    const expected =
      packageInfo === undefined
        ? undefined
        : path.join(
            checkoutRoot,
            "node_modules",
            ".pnpm",
            previewWorkflowApiPnpmStoreDirectory(packageId, virtualStoreDirMaxLength),
            "node_modules",
            ...packageInfo.name.split("/"),
          );
    if (expected === undefined || realTarget !== expected)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-lock-target:${importerName}:${dependencyName}`,
        }),
      );
    yield* validatePreviewWorkflowApiLockedPackage(
      fileSystem,
      checkoutRoot,
      realTarget,
      packageId,
      lockfile,
      allowedPackageIds,
    );
  });

const validatePreviewWorkflowApiInstalledLockfile = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  expectedLockBytes: Uint8Array,
) =>
  Effect.gen(function* () {
    const installedLockPath = path.join(checkoutRoot, "node_modules", ".pnpm", "lock.yaml");
    const installedLockRealPath = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(installedLockPath),
      "installed-dependency-lockfile-realpath",
    );
    if (
      installedLockRealPath !== installedLockPath ||
      !pathIsWithin(checkoutRoot, installedLockRealPath)
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "installed-dependency-lockfile-outside-root",
        }),
      );
    const installedLockBytes = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.readFile(installedLockPath),
      "installed-dependency-lockfile",
    );
    if (!Buffer.from(installedLockBytes).equals(Buffer.from(expectedLockBytes)))
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "installed-dependency-lockfile-mismatch",
        }),
      );
  });

type PreviewWorkflowApiInstalledLinkRoot = {
  readonly importerName: string;
  readonly moduleRoot: string;
  readonly manifest: PreviewWorkflowApiPackageManifest | undefined;
};

const validatePreviewWorkflowApiUnexpectedInstalledNames = (
  importerName: string,
  actualNames: ReadonlyArray<string>,
  expectedNames: ReadonlySet<string>,
  allDeclaredNames: ReadonlySet<string>,
  mode: "checkout" | "candidate",
) =>
  Effect.gen(function* () {
    for (const name of actualNames) {
      if (expectedNames.has(name)) continue;
      if (mode === "checkout" && allDeclaredNames.has(name)) continue;
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-not-in-lock-importer:${importerName}:${name}`,
        }),
      );
    }
  });

const validatePreviewWorkflowApiExpectedInstalledLink = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  root: PreviewWorkflowApiInstalledLinkRoot,
  name: string,
  resolution: Schema.Schema.Type<typeof previewWorkflowApiLockDependencySchema> | undefined,
  actualNames: ReadonlySet<string>,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  allowedPackageIds: ReadonlySet<string>,
  virtualStoreDirMaxLength: number,
  mode: "checkout" | "candidate",
) =>
  Effect.gen(function* () {
    if (resolution === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-lock-resolution:${root.importerName}:${name}`,
        }),
      );
    const optional = root.manifest?.optionalDependencies[name] !== undefined;
    if (!actualNames.has(name) && !optional)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-link-missing:${root.importerName}:${name}`,
        }),
      );
    if (actualNames.has(name))
      yield* previewWorkflowApiValidateInstalledPackageLink(
        fileSystem,
        checkoutRoot,
        root.moduleRoot,
        root.importerName,
        name,
        resolution,
        lockfile,
        virtualStoreDirMaxLength,
        mode === "candidate" ? allowedPackageIds : undefined,
      );
  });

const validatePreviewWorkflowApiInstalledLinkRoot = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  root: PreviewWorkflowApiInstalledLinkRoot,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  allowedPackageIds: ReadonlySet<string>,
  virtualStoreDirMaxLength: number,
  mode: "checkout" | "candidate",
) =>
  Effect.gen(function* () {
    const importer = lockfile.importers[root.importerName];
    if (importer === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-lock-importer:${root.importerName}`,
        }),
      );
    if (root.manifest === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: `dependency-package-manifest:${root.importerName}`,
        }),
      );
    const resolutions = previewWorkflowApiLockImporterDependencies(importer);
    const expectedNames =
      root.importerName === "."
        ? new Set(["tsx"])
        : new Set([
            ...Object.keys(root.manifest.dependencies),
            ...Object.keys(root.manifest.optionalDependencies),
            ...Object.keys(root.manifest.peerDependencies),
          ]);
    const allDeclaredNames = new Set(
      Object.keys(previewWorkflowApiManifestDependencies(root.manifest)),
    );
    const actual = yield* previewWorkflowApiInstalledModuleNames(
      fileSystem,
      checkoutRoot,
      root.moduleRoot,
    );
    const actualNames = new Set(actual);
    yield* validatePreviewWorkflowApiUnexpectedInstalledNames(
      root.importerName,
      actual,
      expectedNames,
      allDeclaredNames,
      mode,
    );
    yield* Effect.forEach(expectedNames, (name) =>
      validatePreviewWorkflowApiExpectedInstalledLink(
        fileSystem,
        checkoutRoot,
        root,
        name,
        resolutions[name],
        actualNames,
        lockfile,
        allowedPackageIds,
        virtualStoreDirMaxLength,
        mode,
      ),
    );
  });

const validatePreviewWorkflowApiInstalledLinks = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  rootManifest: PreviewWorkflowApiPackageManifest,
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
  workspacePackageNames: ReadonlySet<string>,
  allowedPackageIds: ReadonlySet<string>,
  virtualStoreDirMaxLength: number,
  mode: "checkout" | "candidate",
) =>
  Effect.gen(function* () {
    const roots: Array<PreviewWorkflowApiInstalledLinkRoot> = [".", ...workspacePackageNames].map(
      (name) => ({
        importerName: name === "." ? "." : `packages/${name}`,
        moduleRoot:
          name === "."
            ? path.join(checkoutRoot, "node_modules")
            : path.join(checkoutRoot, "packages", name, "node_modules"),
        manifest: name === "." ? rootManifest : manifests.get(name),
      }),
    );
    yield* Effect.forEach(roots, (root) =>
      validatePreviewWorkflowApiInstalledLinkRoot(
        fileSystem,
        checkoutRoot,
        root,
        lockfile,
        allowedPackageIds,
        virtualStoreDirMaxLength,
        mode,
      ),
    );
  });

const validatePreviewWorkflowApiWorkspaceLinks = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  dependencies: ReadonlyArray<PreviewWorkflowApiWorkspaceDependency>,
) =>
  Effect.forEach(
    dependencies,
    ({ packageName, dependencyName }) =>
      Effect.gen(function* () {
        const dependencyLink = path.join(
          checkoutRoot,
          "packages",
          packageName,
          "node_modules",
          dependencyName,
        );
        const expectedTarget = path.join(checkoutRoot, "packages", dependencyName);
        const [actual, expected] = yield* Effect.all(
          [fileSystem.realPath(dependencyLink), fileSystem.realPath(expectedTarget)],
          { concurrency: 1 },
        ).pipe(
          Effect.mapError(
            () =>
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: `workspace-dependency-link:${packageName}:${dependencyName}`,
              }),
          ),
        );
        if (actual !== expected)
          return yield* Effect.fail(
            new PreviewWorkflowApiHostError({
              reason: "workflow-source-unavailable",
              phase: `workspace-dependency-link:${packageName}:${dependencyName}`,
            }),
          );
      }),
    { concurrency: 1 },
  );

type PreviewWorkflowApiRuntimeInputs = {
  readonly packageManifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>;
  readonly workspaceDependencies: ReadonlyArray<PreviewWorkflowApiWorkspaceDependency>;
  readonly lockInputs: {
    readonly lockfile: PreviewWorkflowApiPnpmLockfile;
    readonly lockBytes: Uint8Array;
    readonly rootManifest: PreviewWorkflowApiPackageManifest;
    readonly workspacePatchedDependencies: Readonly<Record<string, string>>;
    readonly rootPatchedDependencies: Readonly<Record<string, string>>;
  };
  readonly workspacePackageNames: ReadonlySet<string>;
  readonly allowedPackageIds: ReadonlySet<string>;
  readonly modulesMetadata: PreviewWorkflowApiPnpmModulesMetadata;
  readonly dependencyClosure: PreviewWorkflowApiDependencyClosure;
  readonly dependencyClosureDigest: string;
  readonly runtimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations;
};

const previewWorkflowApiRuntimeInputs = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
  trustedRuntimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations | undefined,
): Effect.Effect<PreviewWorkflowApiRuntimeInputs, PreviewWorkflowApiHostError> =>
  Effect.gen(function* () {
    const packageManifests = yield* previewWorkflowApiPackageManifests(entries);
    const workspaceDependencies =
      yield* validatePreviewWorkflowApiWorkspaceClosure(packageManifests);
    yield* validatePreviewWorkflowApiWorkspaceLinks(
      fileSystem,
      checkoutRoot,
      workspaceDependencies,
    );
    const lockInputs = yield* decodePreviewWorkflowApiPnpmLockfile(entries);
    const workspacePackageNames = new Set([
      "sheet-workflows",
      ...workspaceDependencies.map(({ dependencyName }) => dependencyName),
    ]);
    yield* validatePreviewWorkflowApiManifestLockImporter(
      ".",
      lockInputs.rootManifest,
      lockInputs.lockfile,
      lockInputs,
    );
    for (const packageName of workspacePackageNames) {
      const manifest = yield* workspacePackageManifest(packageName, packageManifests);
      yield* validatePreviewWorkflowApiManifestLockImporter(
        `packages/${packageName}`,
        manifest,
        lockInputs.lockfile,
        lockInputs,
      );
    }
    const allowedPackageIds = yield* previewWorkflowApiPackageIdsForRuntime(
      lockInputs.lockfile,
      packageManifests,
      workspacePackageNames,
    );
    const runtimeArtifactAttestations =
      yield* previewWorkflowApiResolveTrustedRuntimeArtifactAttestations(
        entries,
        lockInputs.lockfile,
        allowedPackageIds,
        trustedRuntimeArtifactAttestations,
      );
    const modulesMetadata = yield* previewWorkflowApiPnpmModulesMetadata(fileSystem, checkoutRoot);
    yield* validatePreviewWorkflowApiInstalledLockfile(
      fileSystem,
      checkoutRoot,
      lockInputs.lockBytes,
    );
    yield* validatePreviewWorkflowApiInstalledLinks(
      fileSystem,
      checkoutRoot,
      lockInputs.lockfile,
      lockInputs.rootManifest,
      packageManifests,
      workspacePackageNames,
      allowedPackageIds,
      modulesMetadata.virtualStoreDirMaxLength,
      "checkout",
    );
    const dependencyClosure = yield* previewWorkflowApiDependencyClosureAttestation(
      modulesMetadata.storeIndexPath,
      lockInputs.lockfile,
      allowedPackageIds,
      lockInputs.workspacePatchedDependencies,
      lockInputs.rootPatchedDependencies,
      entries,
    );
    const runtimePackageDigests = yield* verifyPreviewWorkflowApiPnpmPackageClosure(
      fileSystem,
      checkoutRoot,
      modulesMetadata.storeDir,
      lockInputs.lockfile,
      allowedPackageIds,
      modulesMetadata.virtualStoreDirMaxLength,
      dependencyClosure.indexes,
      dependencyClosure.patchedPackages,
      "checkout",
    );
    yield* previewWorkflowApiVerifyRuntimeArtifactAttestations(
      runtimeArtifactAttestations,
      allowedPackageIds,
      runtimePackageDigests,
    );
    const dependencyClosureDigest = previewWorkflowApiDependencyClosureDigest(
      dependencyClosure.baseDigest,
      allowedPackageIds,
      runtimePackageDigests,
    );
    return {
      packageManifests,
      workspaceDependencies,
      lockInputs,
      workspacePackageNames,
      allowedPackageIds,
      modulesMetadata,
      dependencyClosure: {
        baseDigest: dependencyClosure.baseDigest,
        digest: dependencyClosureDigest,
        indexes: dependencyClosure.indexes,
        patchedPackages: dependencyClosure.patchedPackages,
        runtimePackageDigests,
      },
      dependencyClosureDigest,
      runtimeArtifactAttestations,
    };
  });

const previewWorkflowApiDependencyGraphRevision = (
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  previewWorkflowApiSourceRevisionFromFiles(
    entries.filter(
      ({ relativePath }) =>
        relativePath === "package.json" ||
        relativePath === "pnpm-lock.yaml" ||
        relativePath === "pnpm-workspace.yaml" ||
        relativePath === previewWorkflowApiRuntimeArtifactAttestationsPath ||
        /^packages\/[^/]+\/package\.json$/.test(relativePath),
    ),
  );

const previewWorkflowApiSourceSnapshotFromEntries = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
  trustedRuntimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations | undefined,
) =>
  Effect.gen(function* () {
    const schemaArtifactDigest = yield* migrationArtifactDigestFromFiles(entries);
    const runtimeInputs = yield* previewWorkflowApiRuntimeInputs(
      fileSystem,
      checkoutRoot,
      entries,
      trustedRuntimeArtifactAttestations,
    );
    return {
      revision: previewWorkflowApiSourceRevisionFromFiles(
        entries,
        runtimeInputs.dependencyClosureDigest,
      ),
      schemaArtifactDigest,
      dependencyClosureDigest: runtimeInputs.dependencyClosureDigest,
      dependencyGraphRevision: previewWorkflowApiDependencyGraphRevision(entries),
    };
  });

const writePreviewWorkflowApiSourceTree = (
  fileSystem: FileSystem.FileSystem,
  snapshotRoot: string,
  entries: ReadonlyArray<{ readonly relativePath: string; readonly contents: Uint8Array }>,
) =>
  Effect.gen(function* () {
    const sourceDirectories = previewWorkflowApiSourceRoots.filter(
      (sourceRoot) => path.extname(sourceRoot).length === 0,
    );
    yield* Effect.forEach(sourceDirectories, (sourceRoot) =>
      mapWorkflowApiSourceFileSystemError(
        fileSystem.makeDirectory(path.resolve(snapshotRoot, sourceRoot), { recursive: true }),
        "source-root-directory",
      ),
    );
    yield* Effect.forEach(entries, (entry) => {
      const target = path.resolve(snapshotRoot, entry.relativePath);
      return fileSystem.makeDirectory(path.dirname(target), { recursive: true }).pipe(
        Effect.andThen(fileSystem.writeFile(target, entry.contents)),
        Effect.mapError((error) => workflowApiStageError(error, "source-files")),
      );
    });
    yield* Effect.forEach(entries, ({ relativePath }) =>
      mapWorkflowApiSourceFileSystemError(
        fileSystem.chmod(path.resolve(snapshotRoot, relativePath), 0o444),
        "read-only-source",
      ),
    );
  });

const copyPreviewWorkflowApiDependencyLinks = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  snapshotRoot: string,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
  workspacePackageNames: ReadonlySet<string>,
  allowedPackageIds: ReadonlySet<string>,
  virtualStoreDirMaxLength: number,
) =>
  Effect.gen(function* () {
    const packageIdsByStoreDirectory = new Map<string, string>();
    for (const packageId of Object.keys(lockfile.snapshots)) {
      const storeDirectory = previewWorkflowApiPnpmStoreDirectory(
        packageId,
        virtualStoreDirMaxLength,
      );
      const previous = packageIdsByStoreDirectory.get(storeDirectory);
      if (previous !== undefined && previous !== packageId)
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-lock-store-collision:${storeDirectory}`,
          }),
        );
      packageIdsByStoreDirectory.set(storeDirectory, packageId);
    }
    const state: NodeModulesCopyState = {
      copiedPnpmEntryRoots: new Set(),
      lockfile,
      allowedPackageIds,
      packageIdsByStoreDirectory,
    };
    const rootNodeModules = path.join(checkoutRoot, "node_modules");
    const candidateNodeModules = path.join(snapshotRoot, "node_modules");
    const candidatePnpm = path.join(candidateNodeModules, ".pnpm");
    yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.makeDirectory(candidatePnpm, { recursive: true }),
      "candidate-pnpm-store",
    );
    yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.copyFile(
        path.join(rootNodeModules, ".pnpm", "lock.yaml"),
        path.join(candidatePnpm, "lock.yaml"),
      ),
      "candidate-pnpm-lockfile",
    );

    const rootTsx =
      lockfile.importers["."]?.devDependencies?.tsx ?? lockfile.importers["."]?.dependencies?.tsx;
    if (rootTsx === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "candidate-runner-lock-resolution",
        }),
      );
    const rootTsxSource = path.join(rootNodeModules, "tsx");
    const rootTsxTarget = path.join(candidateNodeModules, "tsx");
    yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.makeDirectory(candidateNodeModules, { recursive: true }),
      "candidate-root-node-modules",
    );
    yield* copyNodeModulesEntry(
      fileSystem,
      checkoutRoot,
      snapshotRoot,
      rootTsxSource,
      rootTsxTarget,
      state,
    );

    yield* Effect.forEach([...workspacePackageNames].sort(), (packageName) =>
      Effect.gen(function* () {
        const manifest = manifests.get(packageName);
        const importer = lockfile.importers[`packages/${packageName}`];
        if (manifest === undefined || importer === undefined)
          return yield* Effect.fail(
            new PreviewWorkflowApiHostError({
              reason: "workflow-source-unavailable",
              phase: `dependency-lock-importer:packages/${packageName}`,
            }),
          );
        const resolutions = previewWorkflowApiLockImporterDependencies(importer);
        const runtimeNames = new Set([
          ...Object.keys(manifest.dependencies),
          ...Object.keys(manifest.optionalDependencies),
          ...Object.keys(manifest.peerDependencies),
        ]);
        for (const dependencyName of runtimeNames) {
          const resolution = resolutions[dependencyName];
          if (resolution === undefined)
            return yield* Effect.fail(
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: `dependency-lock-resolution:packages/${packageName}:${dependencyName}`,
              }),
            );
          const source = path.join(
            checkoutRoot,
            "packages",
            packageName,
            "node_modules",
            ...dependencyName.split("/"),
          );
          const exists = yield* mapWorkflowApiSourceFileSystemError(
            fileSystem.exists(source),
            `dependency-source:${packageName}:${dependencyName}`,
          );
          if (!exists && manifest.optionalDependencies[dependencyName] !== undefined) continue;
          const target = path.join(
            snapshotRoot,
            "packages",
            packageName,
            "node_modules",
            ...dependencyName.split("/"),
          );
          if (!exists)
            return yield* Effect.fail(
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: `dependency-link-missing:packages/${packageName}:${dependencyName}`,
              }),
            );
          yield* mapWorkflowApiSourceFileSystemError(
            fileSystem.makeDirectory(path.dirname(target), { recursive: true }),
            "candidate-package-node-modules",
          );
          yield* copyNodeModulesEntry(
            fileSystem,
            checkoutRoot,
            snapshotRoot,
            source,
            target,
            state,
          );
        }
      }),
    );
  });

const verifyPreviewWorkflowApiCandidate = (
  fileSystem: FileSystem.FileSystem,
  snapshotRoot: string,
  expectedRevision: string,
  expectedDependencyClosure: PreviewWorkflowApiDependencyClosure,
  expectedSchemaArtifactDigest: string,
  workspaceDependencies: ReadonlyArray<PreviewWorkflowApiWorkspaceDependency>,
  lockfile: PreviewWorkflowApiPnpmLockfile,
  rootManifest: PreviewWorkflowApiPackageManifest,
  workspacePatchedDependencies: Readonly<Record<string, string>>,
  rootPatchedDependencies: Readonly<Record<string, string>>,
  expectedLockBytes: Uint8Array,
  manifests: ReadonlyMap<string, PreviewWorkflowApiPackageManifest>,
  workspacePackageNames: ReadonlySet<string>,
  allowedPackageIds: ReadonlySet<string>,
  virtualStoreDirMaxLength: number,
  storeIndexPath: string,
  trustedRuntimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations | undefined,
) =>
  Effect.gen(function* () {
    yield* validatePreviewWorkflowApiWorkspaceLinks(
      fileSystem,
      snapshotRoot,
      workspaceDependencies,
    ).pipe(Effect.mapError((error) => workflowApiStageError(error, "staged-workspace-links")));
    const stagedEntries = yield* previewWorkflowApiSourceEntries(fileSystem, snapshotRoot).pipe(
      Effect.mapError((error) => workflowApiStageError(error, "staged-source-entries")),
    );
    const stagedRuntimeArtifactAttestations =
      yield* previewWorkflowApiResolveTrustedRuntimeArtifactAttestations(
        stagedEntries.entries,
        lockfile,
        allowedPackageIds,
        trustedRuntimeArtifactAttestations,
      );
    const dependencyClosure = yield* previewWorkflowApiDependencyClosureAttestation(
      storeIndexPath,
      lockfile,
      allowedPackageIds,
      workspacePatchedDependencies,
      rootPatchedDependencies,
      stagedEntries.entries,
    );
    if (dependencyClosure.baseDigest !== expectedDependencyClosure.baseDigest)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "staged-dependency-identity",
        }),
      );
    const runtimePackageDigests = yield* verifyPreviewWorkflowApiPnpmPackageClosure(
      fileSystem,
      snapshotRoot,
      path.dirname(storeIndexPath),
      lockfile,
      allowedPackageIds,
      virtualStoreDirMaxLength,
      dependencyClosure.indexes,
      dependencyClosure.patchedPackages,
      "candidate",
    );
    yield* previewWorkflowApiVerifyRuntimeArtifactAttestations(
      stagedRuntimeArtifactAttestations,
      allowedPackageIds,
      runtimePackageDigests,
    );
    for (const packageId of allowedPackageIds) {
      if (
        runtimePackageDigests.get(packageId) !==
        expectedDependencyClosure.runtimePackageDigests.get(packageId)
      )
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `staged-dependency-content:${packageId}`,
          }),
        );
    }
    const dependencyClosureDigest = previewWorkflowApiDependencyClosureDigest(
      dependencyClosure.baseDigest,
      allowedPackageIds,
      runtimePackageDigests,
    );
    if (dependencyClosureDigest !== expectedDependencyClosure.digest)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "staged-dependency-identity",
        }),
      );
    const revision = previewWorkflowApiSourceRevisionFromFiles(
      stagedEntries.entries,
      dependencyClosureDigest,
    );
    if (revision !== expectedRevision)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "staged-source-bytes",
        }),
      );
    const schemaArtifactDigest = yield* migrationArtifactDigestFromFiles(
      stagedEntries.entries,
    ).pipe(Effect.mapError((error) => workflowApiStageError(error, "staged-migration-identity")));
    if (schemaArtifactDigest !== expectedSchemaArtifactDigest)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "staged-schema-digest",
        }),
      );
    const stagedLockBytes = previewWorkflowApiEntriesByPath(stagedEntries.entries).get(
      "pnpm-lock.yaml",
    );
    if (
      stagedLockBytes === undefined ||
      !Buffer.from(stagedLockBytes).equals(Buffer.from(expectedLockBytes))
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "staged-dependency-lockfile",
        }),
      );
    yield* validatePreviewWorkflowApiInstalledLockfile(fileSystem, snapshotRoot, stagedLockBytes);
    yield* validatePreviewWorkflowApiInstalledLinks(
      fileSystem,
      snapshotRoot,
      lockfile,
      rootManifest,
      manifests,
      workspacePackageNames,
      allowedPackageIds,
      virtualStoreDirMaxLength,
      "candidate",
    );
    return {
      revision,
      schemaArtifactDigest,
      dependencyClosureDigest,
    };
  });

export const previewWorkflowApiSourceSnapshot = (
  fileSystem: FileSystem.FileSystem,
  checkout: string,
  trustedRuntimeArtifactAttestations?: PreviewWorkflowApiRuntimeArtifactAttestations,
) =>
  Effect.gen(function* () {
    const trustedAttestations = yield* previewWorkflowApiCopyTrustedRuntimeArtifactAttestations(
      trustedRuntimeArtifactAttestations,
    );
    const { root, entries } = yield* previewWorkflowApiSourceEntries(fileSystem, checkout);
    return yield* previewWorkflowApiSourceSnapshotFromEntries(
      fileSystem,
      root,
      entries,
      trustedAttestations,
    );
  });

const mapWorkflowApiSourceFileSystemError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  phase?: string,
) =>
  effect.pipe(
    Effect.mapError(
      () =>
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          ...(phase === undefined ? {} : { phase }),
        }),
    ),
  );

type NodeModulesCopyState = {
  readonly copiedPnpmEntryRoots: Set<string>;
  readonly lockfile: PreviewWorkflowApiPnpmLockfile;
  readonly allowedPackageIds: ReadonlySet<string>;
  readonly packageIdsByStoreDirectory: ReadonlyMap<string, string>;
};

const validatePreviewWorkflowApiPnpmDependencyLink = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  source: string,
  resolved: string,
  state: NodeModulesCopyState,
) =>
  Effect.gen(function* () {
    const relativeSource = path.relative(checkoutRoot, source).split(path.sep);
    const pnpmSourceIndex = relativeSource.indexOf(".pnpm");
    const parentStoreDirectory = relativeSource[pnpmSourceIndex + 1];
    const parentPackageId =
      parentStoreDirectory === undefined
        ? undefined
        : state.packageIdsByStoreDirectory.get(parentStoreDirectory);
    const relativeTarget = path.relative(checkoutRoot, resolved).split(path.sep);
    const pnpmTargetIndex = relativeTarget.indexOf(".pnpm");
    const targetStoreDirectory =
      pnpmTargetIndex < 0 ? undefined : relativeTarget[pnpmTargetIndex + 1];
    const packageId =
      targetStoreDirectory === undefined
        ? undefined
        : state.packageIdsByStoreDirectory.get(targetStoreDirectory);
    if (parentPackageId === undefined || packageId === undefined)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-lock-store-mapping",
        }),
      );
    yield* validatePreviewWorkflowApiNestedPnpmDependencyLink(
      relativeSource,
      pnpmSourceIndex,
      parentPackageId,
      packageId,
      resolved,
      state,
      fileSystem,
      checkoutRoot,
    );
  });

const validatePreviewWorkflowApiNestedPnpmDependencyLink = (
  relativeSource: ReadonlyArray<string>,
  pnpmSourceIndex: number,
  parentPackageId: string,
  packageId: string,
  resolved: string,
  state: NodeModulesCopyState,
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
) =>
  Effect.gen(function* () {
    const lastNodeModulesIndex = relativeSource.lastIndexOf(
      "node_modules",
      relativeSource.length - 2,
    );
    if (lastNodeModulesIndex > pnpmSourceIndex + 2) {
      const dependencyName = relativeSource.slice(lastNodeModulesIndex + 1).join("/");
      const parentSnapshot = state.lockfile.snapshots[parentPackageId];
      const expectedVersion = {
        ...parentSnapshot?.dependencies,
        ...parentSnapshot?.optionalDependencies,
      }[dependencyName];
      if (
        expectedVersion === undefined ||
        previewWorkflowApiLockPackageId(dependencyName, expectedVersion) !== packageId
      )
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: `dependency-lock-edge:${parentPackageId}:${dependencyName}`,
          }),
        );
    }
    yield* validatePreviewWorkflowApiLockedPackage(
      fileSystem,
      checkoutRoot,
      resolved,
      packageId,
      state.lockfile,
      state.allowedPackageIds,
    );
  });

const validatePreviewWorkflowApiWorkspaceDependencyLink = (
  checkoutRoot: string,
  resolved: string,
) =>
  Effect.gen(function* () {
    const resolvedSegments = path.relative(checkoutRoot, resolved).split(path.sep);
    const isLockedVirtualStorePath =
      resolvedSegments[0] === "node_modules" && resolvedSegments[1] === ".pnpm";
    const packageName = resolvedSegments[0] === "packages" ? resolvedSegments[1] : undefined;
    if (
      !isLockedVirtualStorePath &&
      (packageName === undefined || !previewWorkflowApiSourcePackages.has(packageName))
    )
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "workspace-dependency-outside-source-roots",
        }),
      );
  });

const validatePreviewWorkflowApiNodeModulesLinkTarget = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  source: string,
  resolved: string,
  state: NodeModulesCopyState,
) =>
  Effect.gen(function* () {
    const sourceSegments = path.relative(checkoutRoot, source).split(path.sep);
    const pnpmSourceIndex = sourceSegments.indexOf(".pnpm");
    if (pnpmSourceIndex >= 0) {
      yield* validatePreviewWorkflowApiPnpmDependencyLink(
        fileSystem,
        checkoutRoot,
        source,
        resolved,
        state,
      );
      return;
    }
    if (pathIsWithin(checkoutRoot, resolved))
      yield* validatePreviewWorkflowApiWorkspaceDependencyLink(checkoutRoot, resolved);
  });

const stagePreviewWorkflowApiPnpmEntryRoot = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  snapshotRoot: string,
  resolved: string,
  state: NodeModulesCopyState,
) =>
  Effect.gen(function* () {
    const relative = path.relative(checkoutRoot, resolved);
    const segments = relative.split(path.sep);
    const pnpmIndex = segments.indexOf(".pnpm");
    const storeDirectory = pnpmIndex < 0 ? undefined : segments[pnpmIndex + 1];
    if (storeDirectory !== undefined) {
      const entryRoot = path.resolve(checkoutRoot, ...segments.slice(0, pnpmIndex + 2));
      const stagedEntryRoot = path.resolve(snapshotRoot, path.relative(checkoutRoot, entryRoot));
      if (!state.copiedPnpmEntryRoots.has(entryRoot)) {
        state.copiedPnpmEntryRoots.add(entryRoot);
        yield* copyNodeModulesEntry(
          fileSystem,
          checkoutRoot,
          snapshotRoot,
          entryRoot,
          stagedEntryRoot,
          state,
        );
      }
    }
  });

const copyPreviewWorkflowApiNodeModulesSymlink = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  snapshotRoot: string,
  source: string,
  target: string,
  link: string,
  state: NodeModulesCopyState,
) =>
  Effect.gen(function* () {
    const resolved = path.resolve(path.dirname(source), link);
    const canonicalTarget = yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.realPath(resolved),
      "dependency-link-realpath",
    );
    if (!pathIsWithin(checkoutRoot, resolved) || canonicalTarget !== resolved)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "dependency-link-outside-checkout",
        }),
      );
    yield* validatePreviewWorkflowApiNodeModulesLinkTarget(
      fileSystem,
      checkoutRoot,
      source,
      resolved,
      state,
    );
    yield* stagePreviewWorkflowApiPnpmEntryRoot(
      fileSystem,
      checkoutRoot,
      snapshotRoot,
      resolved,
      state,
    );
    const stagedTarget = path.resolve(snapshotRoot, path.relative(checkoutRoot, resolved));
    const rewritten = path.relative(path.dirname(target), stagedTarget);
    yield* mapWorkflowApiSourceFileSystemError(fileSystem.symlink(rewritten, target));
  });

const copyPreviewWorkflowApiNodeModulesDirectory = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  snapshotRoot: string,
  source: string,
  target: string,
  state: NodeModulesCopyState,
) =>
  Effect.gen(function* () {
    yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.makeDirectory(target, { recursive: true }),
    );
    const entries = yield* mapWorkflowApiSourceFileSystemError(fileSystem.readDirectory(source));
    yield* Effect.forEach(entries, (entry) =>
      copyNodeModulesEntry(
        fileSystem,
        checkoutRoot,
        snapshotRoot,
        path.join(source, entry),
        path.join(target, entry),
        state,
      ),
    );
  });

const copyPreviewWorkflowApiNodeModulesFile = (
  fileSystem: FileSystem.FileSystem,
  source: string,
  target: string,
  mode: number,
) =>
  Effect.gen(function* () {
    yield* mapWorkflowApiSourceFileSystemError(fileSystem.copyFile(source, target));
    yield* mapWorkflowApiSourceFileSystemError(
      fileSystem.chmod(target, mode & 0o555),
      "read-only-dependency-file",
    );
  });

const copyPreviewWorkflowApiNodeModulesEntry = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  snapshotRoot: string,
  source: string,
  target: string,
  state: NodeModulesCopyState,
) =>
  Effect.gen(function* () {
    const info = yield* mapWorkflowApiSourceFileSystemError(fileSystem.stat(source));
    if (info.type === "Directory")
      return yield* copyPreviewWorkflowApiNodeModulesDirectory(
        fileSystem,
        checkoutRoot,
        snapshotRoot,
        source,
        target,
        state,
      );
    yield* copyPreviewWorkflowApiNodeModulesFile(fileSystem, source, target, info.mode);
  });

const copyNodeModulesEntry = (
  fileSystem: FileSystem.FileSystem,
  checkoutRoot: string,
  snapshotRoot: string,
  source: string,
  target: string,
  state: NodeModulesCopyState,
): Effect.Effect<void, PreviewWorkflowApiHostError> =>
  Effect.gen(function* () {
    if (path.basename(source) === ".bin") return;
    const link = yield* Effect.result(fileSystem.readLink(source));
    if (Result.isSuccess(link))
      return yield* copyPreviewWorkflowApiNodeModulesSymlink(
        fileSystem,
        checkoutRoot,
        snapshotRoot,
        source,
        target,
        link.success,
        state,
      );
    yield* copyPreviewWorkflowApiNodeModulesEntry(
      fileSystem,
      checkoutRoot,
      snapshotRoot,
      source,
      target,
      state,
    );
  });

/**
 * Stages source and resolved dependencies into a private candidate tree.
 * Workspace links are rewritten; external pnpm packages are copied into the
 * candidate's private virtual store. The checkout's `.env` is not copied.
 */
const previewWorkflowApiCandidatePrefix = "tiara-workflow-api-candidate-";
const previewWorkflowApiCandidateOwnerSuffix = ".owner.json";

const PreviewWorkflowApiCandidateOwnerRecordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  checkoutRoot: Schema.String,
  candidateCheckout: Schema.String,
  sessionId: Schema.String,
  generation: Schema.Int,
  revision: Schema.String,
  token: Schema.String,
  cleanupState: Schema.Literals(["staging", "cleanup-pending", "owner-record-cleanup-pending"]),
});
type PreviewWorkflowApiCandidateOwnerRecord =
  typeof PreviewWorkflowApiCandidateOwnerRecordSchema.Type;

const previewWorkflowApiCandidateOwnerRecordPath = (candidateCheckout: string) =>
  `${candidateCheckout}${previewWorkflowApiCandidateOwnerSuffix}`;

const previewWorkflowApiCandidateParentForCheckout = (checkoutRoot: string) =>
  path.join(
    path.dirname(checkoutRoot),
    ".tiara-workflow-api-candidates",
    path.basename(checkoutRoot),
  );

const previewWorkflowApiCandidateRecordIsBoundToParent = (
  candidate: PreviewWorkflowApiCandidateOwnerRecord,
  candidateParent: string,
  ownerRecordPath: string,
) =>
  path.resolve(candidate.candidateCheckout) === candidate.candidateCheckout &&
  path.dirname(candidate.candidateCheckout) === candidateParent &&
  path.basename(candidate.candidateCheckout).startsWith(previewWorkflowApiCandidatePrefix) &&
  candidateParent === previewWorkflowApiCandidateParentForCheckout(candidate.checkoutRoot) &&
  ownerRecordPath === previewWorkflowApiCandidateOwnerRecordPath(candidate.candidateCheckout);

const previewWorkflowApiCandidateOwnerIdentityMatches = (
  current: PreviewWorkflowApiCandidateOwnerRecord,
  expected: PreviewWorkflowApiCandidateOwnerRecord,
) =>
  current.schemaVersion === expected.schemaVersion &&
  current.checkoutRoot === expected.checkoutRoot &&
  current.candidateCheckout === expected.candidateCheckout &&
  current.sessionId === expected.sessionId &&
  current.generation === expected.generation &&
  current.revision === expected.revision &&
  current.token === expected.token;

const previewWorkflowApiCandidateCleanupError = (
  candidate: PreviewWorkflowApiCandidateOwnerRecord,
  sourceStage = "candidate-cleanup-unconfirmed",
) =>
  new PreviewWorkflowApiSupervisorError({
    reason: "workflow-source-unavailable",
    sessionId: candidate.sessionId,
    generation: candidate.generation,
    requestedRevision: candidate.revision,
    sourceStage,
  });

const inspectPreviewWorkflowApiCandidateForCleanup = (
  fileSystem: FileSystem.FileSystem,
  candidateCheckout: string,
  record: PreviewWorkflowApiCandidateOwnerRecord,
) =>
  Effect.gen(function* () {
    const exists = yield* fileSystem
      .exists(candidateCheckout)
      .pipe(
        Effect.mapError(() =>
          previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-inspection"),
        ),
      );
    const candidateParent = path.dirname(candidateCheckout);
    const candidateName = path.basename(candidateCheckout);
    const entries = yield* fileSystem
      .readDirectory(candidateParent)
      .pipe(
        Effect.mapError(() =>
          previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-inspection"),
        ),
      );
    const hasCandidateEntry = entries.includes(candidateName);
    if (!hasCandidateEntry && !exists) return false;
    if (!hasCandidateEntry || !exists)
      return yield* Effect.fail(
        previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-staging-ambiguous"),
      );
    const actualPath = yield* fileSystem
      .realPath(candidateCheckout)
      .pipe(
        Effect.mapError(() =>
          previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-inspection"),
        ),
      );
    const candidateInfo = yield* fileSystem
      .stat(candidateCheckout)
      .pipe(
        Effect.mapError(() =>
          previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-inspection"),
        ),
      );
    if (actualPath !== candidateCheckout)
      return yield* Effect.fail(
        previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-path-mismatch"),
      );
    if (candidateInfo.type !== "Directory")
      return yield* Effect.fail(
        previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-type-mismatch"),
      );
    return true;
  });

const decodePreviewWorkflowApiCandidateOwnerRecord = (value: string) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(PreviewWorkflowApiCandidateOwnerRecordSchema)(JSON.parse(value)),
    catch: () =>
      new PreviewWorkflowApiHostError({
        reason: "workflow-source-unavailable",
        phase: "candidate-cleanup-record-invalid",
      }),
  });

const writePreviewWorkflowApiCandidateOwnerRecord = (
  fileSystem: FileSystem.FileSystem,
  record: PreviewWorkflowApiCandidateOwnerRecord,
) =>
  Effect.gen(function* () {
    const recordPath = previewWorkflowApiCandidateOwnerRecordPath(record.candidateCheckout);
    const temporaryPath = `${recordPath}.${randomUUID()}.tmp`;
    const exists = yield* fileSystem.exists(recordPath).pipe(
      Effect.mapError(
        () =>
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: "candidate-cleanup-record-write",
          }),
      ),
    );
    if (exists) {
      const current = yield* fileSystem.readFileString(recordPath).pipe(
        Effect.mapError(
          () =>
            new PreviewWorkflowApiHostError({
              reason: "workflow-source-unavailable",
              phase: "candidate-cleanup-record-read",
            }),
        ),
      );
      const decoded = yield* decodePreviewWorkflowApiCandidateOwnerRecord(current);
      if (!previewWorkflowApiCandidateOwnerIdentityMatches(decoded, record))
        return yield* Effect.fail(
          new PreviewWorkflowApiHostError({
            reason: "workflow-source-unavailable",
            phase: "candidate-cleanup-record-conflict",
          }),
        );
    }
    yield* fileSystem
      .writeFileString(temporaryPath, `${JSON.stringify(record)}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      .pipe(
        Effect.mapError(
          () =>
            new PreviewWorkflowApiHostError({
              reason: "workflow-source-unavailable",
              phase: "candidate-cleanup-record-write",
            }),
        ),
      );
    const renamed = yield* Effect.exit(fileSystem.rename(temporaryPath, recordPath));
    if (Exit.isFailure(renamed)) {
      yield* fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.result);
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({
          reason: "workflow-source-unavailable",
          phase: "candidate-cleanup-record-write",
        }),
      );
    }
  });

const removePreviewWorkflowApiCandidateOwnerRecords = (
  fileSystem: FileSystem.FileSystem,
  record: PreviewWorkflowApiCandidateOwnerRecord,
) =>
  Effect.gen(function* () {
    const recordPath = previewWorkflowApiCandidateOwnerRecordPath(record.candidateCheckout);
    const exists = yield* fileSystem
      .exists(recordPath)
      .pipe(
        Effect.mapError(() =>
          previewWorkflowApiCandidateCleanupError(record, "candidate-owner-record-inspection"),
        ),
      );
    if (!exists) return;
    const serialized = yield* fileSystem
      .readFileString(recordPath)
      .pipe(
        Effect.mapError(() =>
          previewWorkflowApiCandidateCleanupError(record, "candidate-owner-record-read"),
        ),
      );
    const current = yield* decodePreviewWorkflowApiCandidateOwnerRecord(serialized).pipe(
      Effect.mapError(() =>
        previewWorkflowApiCandidateCleanupError(record, "candidate-owner-record-invalid"),
      ),
    );
    if (!previewWorkflowApiCandidateOwnerIdentityMatches(current, record))
      return yield* Effect.fail(
        previewWorkflowApiCandidateCleanupError(record, "candidate-owner-record-conflict"),
      );
    yield* fileSystem
      .remove(recordPath, { force: true })
      .pipe(
        Effect.mapError(() =>
          previewWorkflowApiCandidateCleanupError(record, "candidate-owner-record-remove"),
        ),
      );
  });

const readPreviewWorkflowApiCandidateOwnerRecord = (
  fileSystem: FileSystem.FileSystem,
  ownerRecordPath: string,
  candidateParent: string,
  sessionId: string,
  checkoutRoot: string,
  generation: number,
) =>
  Effect.gen(function* () {
    const serialized = yield* fileSystem.readFileString(ownerRecordPath).pipe(
      Effect.mapError(
        () =>
          new PreviewWorkflowApiSupervisorError({
            reason: "workflow-source-unavailable",
            sessionId,
            generation,
            sourceStage: "candidate-cleanup-record-read",
          }),
      ),
    );
    const record = yield* decodePreviewWorkflowApiCandidateOwnerRecord(serialized).pipe(
      Effect.mapError(
        () =>
          new PreviewWorkflowApiSupervisorError({
            reason: "workflow-source-unavailable",
            sessionId,
            generation,
            sourceStage: "candidate-cleanup-record-invalid",
          }),
      ),
    );
    if (
      record.sessionId !== sessionId ||
      record.checkoutRoot !== checkoutRoot ||
      record.generation > generation
    )
      return undefined;
    if (!previewWorkflowApiCandidateRecordIsBoundToParent(record, candidateParent, ownerRecordPath))
      return yield* Effect.fail(previewWorkflowApiCandidateCleanupError(record));
    return record;
  });

type PreviewWorkflowApiCandidateLifecycle = {
  readonly created: (
    candidateCheckout: string,
    checkoutRoot: string,
  ) => Effect.Effect<void, PreviewWorkflowApiHostError>;
  readonly cleanupConfirmed: (
    candidateCheckout: string,
  ) => Effect.Effect<void, PreviewWorkflowApiHostError>;
  readonly cleanupUnconfirmed: (
    candidateCheckout: string,
  ) => Effect.Effect<void, PreviewWorkflowApiHostError>;
};

const cleanupPreviewWorkflowApiCandidateAfterStageFailure = (
  fileSystem: FileSystem.FileSystem,
  candidateCheckout: string,
  candidateLifecycle: PreviewWorkflowApiCandidateLifecycle | undefined,
  stagedCause: Cause.Cause<PreviewWorkflowApiHostError>,
) =>
  Effect.gen(function* () {
    const cleanup = yield* Effect.exit(
      Effect.uninterruptible(
        fileSystem.remove(candidateCheckout, { recursive: true }).pipe(
          Effect.mapError(
            () =>
              new PreviewWorkflowApiHostError({
                reason: "workflow-source-unavailable",
                phase: "candidate-cleanup-unconfirmed",
              }),
          ),
        ),
      ),
    );
    if (Exit.isFailure(cleanup)) {
      const retainCleanup =
        candidateLifecycle === undefined
          ? Effect.void
          : candidateLifecycle.cleanupUnconfirmed(candidateCheckout);
      const retained = yield* Effect.exit(retainCleanup);
      if (Exit.isFailure(retained))
        return yield* Effect.failCause(
          Cause.combine(Cause.combine(cleanup.cause, stagedCause), retained.cause),
        );
      return yield* Effect.failCause(Cause.combine(cleanup.cause, stagedCause));
    }
    if (candidateLifecycle !== undefined) {
      const ownerRecordCleanup = yield* Effect.exit(
        candidateLifecycle.cleanupConfirmed(candidateCheckout),
      );
      if (Exit.isFailure(ownerRecordCleanup))
        return yield* Effect.failCause(Cause.combine(stagedCause, ownerRecordCleanup.cause));
    }
    return yield* Effect.failCause(stagedCause);
  });

export const stagePreviewWorkflowApiCandidate = (
  fileSystem: FileSystem.FileSystem,
  checkout: string,
  expectedRevision: string,
  expectedSchemaArtifactDigest: string,
  trustedRuntimeArtifactAttestations?: PreviewWorkflowApiRuntimeArtifactAttestations,
  candidateLifecycle?: PreviewWorkflowApiCandidateLifecycle,
) =>
  Effect.gen(function* () {
    const trustedAttestations = yield* previewWorkflowApiCopyTrustedRuntimeArtifactAttestations(
      trustedRuntimeArtifactAttestations,
    );
    const { root, entries } = yield* previewWorkflowApiSourceEntries(fileSystem, checkout);
    const schemaArtifactDigest = yield* migrationArtifactDigestFromFiles(entries);
    const runtimeInputs = yield* previewWorkflowApiRuntimeInputs(
      fileSystem,
      root,
      entries,
      trustedAttestations,
    );
    const revision = previewWorkflowApiSourceRevisionFromFiles(
      entries,
      runtimeInputs.dependencyClosureDigest,
    );
    if (revision !== expectedRevision || schemaArtifactDigest !== expectedSchemaArtifactDigest)
      return yield* Effect.fail(
        new PreviewWorkflowApiHostError({ reason: "workflow-source-unavailable" }),
      );
    const {
      packageManifests,
      workspaceDependencies,
      lockInputs,
      workspacePackageNames,
      allowedPackageIds,
      modulesMetadata,
    } = runtimeInputs;
    const virtualStoreDirMaxLength = modulesMetadata.virtualStoreDirMaxLength;

    const candidateParent = yield* previewWorkflowApiCandidateParent(fileSystem, root);
    const snapshotRoot = yield* fileSystem
      .makeTempDirectory({
        directory: candidateParent,
        prefix: "tiara-workflow-api-candidate-",
      })
      .pipe(
        Effect.mapError(
          () => new PreviewWorkflowApiHostError({ reason: "workflow-checkout-unavailable" }),
        ),
      );
    const stage = Effect.gen(function* () {
      if (candidateLifecycle !== undefined) yield* candidateLifecycle.created(snapshotRoot, root);
      yield* writePreviewWorkflowApiSourceTree(fileSystem, snapshotRoot, entries);
      yield* copyPreviewWorkflowApiDependencyLinks(
        fileSystem,
        root,
        snapshotRoot,
        lockInputs.lockfile,
        packageManifests,
        workspacePackageNames,
        allowedPackageIds,
        virtualStoreDirMaxLength,
      );
      const stagedIdentity = yield* verifyPreviewWorkflowApiCandidate(
        fileSystem,
        snapshotRoot,
        expectedRevision,
        runtimeInputs.dependencyClosure,
        expectedSchemaArtifactDigest,
        workspaceDependencies,
        lockInputs.lockfile,
        lockInputs.rootManifest,
        lockInputs.workspacePatchedDependencies,
        lockInputs.rootPatchedDependencies,
        lockInputs.lockBytes,
        packageManifests,
        workspacePackageNames,
        allowedPackageIds,
        virtualStoreDirMaxLength,
        modulesMetadata.storeIndexPath,
        runtimeInputs.runtimeArtifactAttestations,
      );
      return {
        checkout: snapshotRoot,
        revision: stagedIdentity.revision,
        schemaArtifactDigest: stagedIdentity.schemaArtifactDigest,
        dependencyClosureDigest: stagedIdentity.dependencyClosureDigest,
      };
    }).pipe(Effect.mapError((error) => workflowApiStageError(error, "candidate-copy")));
    const staged = yield* Effect.exit(stage);
    if (Exit.isFailure(staged))
      return yield* cleanupPreviewWorkflowApiCandidateAfterStageFailure(
        fileSystem,
        snapshotRoot,
        candidateLifecycle,
        staged.cause,
      );
    return staged.value;
  });

const header = (headers: Readonly<Record<string, string>>, name: string) => headers[name];
const booleanHeader = (headers: Readonly<Record<string, string>>, name: string) =>
  header(headers, name) === "true";
const readinessFromHeaders = (headers: Readonly<Record<string, string>>) => ({
  sessionId: header(headers, "x-tiara-preview-session"),
  generation: Number(header(headers, "x-tiara-preview-generation")),
  revision: header(headers, "x-tiara-workflows-source-revision"),
  endpoint: header(headers, "x-tiara-preview-api-endpoint"),
  workflowGroupTarget: header(headers, "x-tiara-preview-workflow-group"),
  apiArtifactDigest: header(headers, "x-tiara-preview-api-artifact"),
  deployedManifestDigest: header(headers, "x-tiara-preview-deployed-manifest"),
  schemaArtifactDigest: header(headers, "x-tiara-preview-schema-artifact"),
  workflowContractCatalogDigest: header(headers, "x-tiara-preview-workflow-catalog"),
  role: header(headers, "x-tiara-workflows-role"),
  producerOnly: booleanHeader(headers, "x-tiara-workflows-producer-only"),
  workflowRunner: booleanHeader(headers, "x-tiara-workflows-runner"),
  reconciliationConsumer: booleanHeader(headers, "x-tiara-workflows-reconciliation-consumer"),
  autonomousTriggers: (header(headers, "x-tiara-workflows-autonomous-triggers") ?? "")
    .split(",")
    .filter(Boolean),
  smokeEnqueue: booleanHeader(headers, "x-tiara-workflows-smoke-enqueue"),
});

/** Builds the real loopback API process adapter; credentials and route ownership stay injected. */
type PreviewWorkflowApiStartInput = Parameters<
  PreviewWorkflowApiSupervisorAdapters["startProcess"]
>[0];
type PreviewWorkflowApiListener = NonNullable<ConnectedPreviewConfig["hostListeners"]>[number];

const workflowApiListener = (
  input: PreviewWorkflowApiStartInput,
): Effect.Effect<PreviewWorkflowApiListener, PreviewWorkflowApiSupervisorError> => {
  const listener = input.config.hostListeners?.find(
    (candidate) => candidate.role === "sheet-workflows-api",
  );
  return listener === undefined
    ? Effect.fail(
        makePreviewWorkflowApiSupervisorError(
          "workflow-api-listener-unavailable",
          input.session,
          input.revision,
        ),
      )
    : Effect.succeed(listener);
};

const verifyWorkflowApiSourceSnapshot = (
  fileSystem: FileSystem.FileSystem,
  input: PreviewWorkflowApiStartInput,
  trustedRuntimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations | undefined,
) =>
  previewWorkflowApiSourceSnapshot(
    fileSystem,
    input.checkout,
    trustedRuntimeArtifactAttestations,
  ).pipe(
    Effect.mapError(() =>
      makePreviewWorkflowApiSupervisorError(
        "workflow-source-unavailable",
        input.session,
        input.revision,
      ),
    ),
    Effect.flatMap((snapshot) => {
      if (snapshot.schemaArtifactDigest !== input.group.schemaArtifactDigest)
        return Effect.fail(
          makePreviewWorkflowApiSupervisorError(
            "workflow-schema-artifact-incompatible",
            input.session,
            input.revision,
          ),
        );
      if (snapshot.revision !== input.revision)
        return Effect.fail(
          makePreviewWorkflowApiSupervisorError("revision-failed", input.session, input.revision),
        );
      return Effect.succeed(snapshot);
    }),
  );

const verifyPreviewWorkflowApiCandidateSourceBeforeAdmission = (
  fileSystem: FileSystem.FileSystem,
  input: PreviewWorkflowApiStartInput,
  trustedRuntimeArtifactAttestations: PreviewWorkflowApiRuntimeArtifactAttestations | undefined,
) =>
  verifyWorkflowApiSourceSnapshot(fileSystem, input, trustedRuntimeArtifactAttestations).pipe(
    Effect.mapError(
      (error) =>
        new PreviewWorkflowApiSupervisorError({
          reason: error.reason,
          sessionId: input.session.id,
          generation: input.session.generation,
          requestedRevision: input.revision,
          sourceStage: "candidate-source-revalidation",
        }),
    ),
  );

const sha256Identity = (value: string) => /^sha256:[a-f0-9]{64}$/.test(value);

const databaseTargetMatchesWorkflowGroup = (
  target: PreviewWorkflowApiDatabaseTarget,
  group: PreviewSharedWorkflowGroup,
) =>
  target.stateIdentity === group.stateIdentity &&
  target.deployedManifestDigest === group.deployedManifestDigest &&
  target.schemaArtifactDigest === group.schemaArtifactDigest &&
  target.workflowContractCatalogDigest === group.workflowContractCatalogDigest &&
  previewWorkflowApiDatabaseEndpointIdentity(target.endpoint) === group.databaseEndpointIdentity;

const workflowGroupMatchesDeclaredIdentity = (
  group: PreviewSharedWorkflowGroup,
  config: ConnectedPreviewConfig,
) =>
  group.deployedManifestDigest === config.identities.deployedManifestDigest &&
  group.schemaArtifactDigest === config.identities.schemaArtifactDigest &&
  group.workflowContractCatalogDigest === config.identities.workflowContractCatalogDigest;

const databaseTargetHasTrustedDigestShapes = (target: PreviewWorkflowApiDatabaseTarget) =>
  [
    target.deployedManifestDigest,
    target.schemaArtifactDigest,
    target.workflowContractCatalogDigest,
  ].every(sha256Identity);

const trustedDatabaseTargetMatchesGroup = (
  target: PreviewWorkflowApiDatabaseTarget,
  input: PreviewWorkflowApiStartInput,
) => {
  return (
    databaseTargetMatchesWorkflowGroup(target, input.group) &&
    workflowGroupMatchesDeclaredIdentity(input.group, input.config) &&
    input.group.workflowContractCatalogDigest === sheetWorkflowContractCatalogDigest &&
    databaseTargetHasTrustedDigestShapes(target)
  );
};

const trustedDatabaseTargetMismatchReason = (
  target: PreviewWorkflowApiDatabaseTarget,
  input: PreviewWorkflowApiStartInput,
) => {
  if (
    previewWorkflowApiDatabaseEndpointIdentity(target.endpoint) !==
    input.group.databaseEndpointIdentity
  )
    return "workflow-database-target-incompatible" as const;
  if (
    target.workflowContractCatalogDigest !== input.group.workflowContractCatalogDigest ||
    input.group.workflowContractCatalogDigest !== sheetWorkflowContractCatalogDigest ||
    input.config.identities.workflowContractCatalogDigest !== sheetWorkflowContractCatalogDigest
  )
    return "workflow-catalog-incompatible" as const;
  return "workflow-schema-artifact-incompatible" as const;
};

const assertWorkflowApiCredentialAuthorityCurrent = (
  provider: PreviewWorkflowApiCredentialProviderApi,
  session: PreviewSession,
  revision: string,
) =>
  provider.assertCurrent === undefined
    ? Effect.void
    : provider
        .assertCurrent()
        .pipe(
          Effect.mapError(() =>
            makePreviewWorkflowApiSupervisorError(
              "workflow-api-credentials-unavailable",
              session,
              revision,
            ),
          ),
        );

const resolveTrustedWorkflowApiDatabaseTarget = (
  options: {
    readonly credentialProvider: PreviewWorkflowApiCredentialProviderApi;
  },
  input: PreviewWorkflowApiStartInput,
) =>
  Effect.gen(function* () {
    yield* assertWorkflowApiCredentialAuthorityCurrent(
      options.credentialProvider,
      input.session,
      input.revision,
    );
    const databaseTarget = yield* options.credentialProvider
      .resolveDatabaseTarget({
        session: input.session,
        config: input.config,
        group: input.group,
      })
      .pipe(
        Effect.mapError(() =>
          makePreviewWorkflowApiSupervisorError(
            "workflow-api-credentials-unavailable",
            input.session,
            input.revision,
          ),
        ),
      );
    yield* assertWorkflowApiCredentialAuthorityCurrent(
      options.credentialProvider,
      input.session,
      input.revision,
    );
    if (!trustedDatabaseTargetMatchesGroup(databaseTarget, input))
      return yield* Effect.fail(
        makePreviewWorkflowApiSupervisorError(
          trustedDatabaseTargetMismatchReason(databaseTarget, input),
          input.session,
          input.revision,
        ),
      );
    if (!isApprovedDevelopmentPostgresEndpoint(databaseTarget.endpoint))
      return yield* Effect.fail(
        makePreviewWorkflowApiSupervisorError(
          "workflow-database-target-incompatible",
          input.session,
          input.revision,
        ),
      );
    return databaseTarget;
  });

const prepareWorkflowApiProcessRequest = (
  options: {
    readonly credentialProvider: PreviewWorkflowApiCredentialProviderApi;
    readonly route: PreviewWorkflowApiApplicationRouteApi;
  },
  input: PreviewWorkflowApiStartInput,
  listener: PreviewWorkflowApiListener,
  databaseTarget: PreviewWorkflowApiDatabaseTarget,
  candidateCheckout: string,
) =>
  Effect.gen(function* () {
    yield* assertWorkflowApiCredentialAuthorityCurrent(
      options.credentialProvider,
      input.session,
      input.revision,
    );
    const references = input.config.credentialReferences["sheet-workflows-api"];
    if (references === undefined)
      return yield* Effect.fail(
        makePreviewWorkflowApiSupervisorError(
          "workflow-api-credentials-unavailable",
          input.session,
          input.revision,
        ),
      );
    const credentials = yield* options.credentialProvider
      .resolve({ session: input.session, config: input.config, references, databaseTarget })
      .pipe(
        Effect.mapError(() =>
          makePreviewWorkflowApiSupervisorError(
            "workflow-api-credentials-unavailable",
            input.session,
            input.revision,
          ),
        ),
      );
    yield* assertWorkflowApiCredentialAuthorityCurrent(
      options.credentialProvider,
      input.session,
      input.revision,
    );
    const oauthClientId = credentials.environment.SHEET_AUTH_OAUTH_CLIENT_ID;
    if (oauthClientId === undefined || oauthClientId.length === 0)
      return yield* Effect.fail(
        makePreviewWorkflowApiSupervisorError(
          "workflow-api-credentials-unavailable",
          input.session,
          input.revision,
        ),
      );
    const origin = yield* options.route
      .applicationOrigin({ sessionId: input.session.id, role: "sheet-workflows-api" })
      .pipe(
        Effect.mapError(() =>
          makePreviewWorkflowApiSupervisorError(
            "workflow-api-route-unavailable",
            input.session,
            input.revision,
          ),
        ),
      );
    yield* assertWorkflowApiCredentialAuthorityCurrent(
      options.credentialProvider,
      input.session,
      input.revision,
    );
    const request = yield* previewWorkflowApiProcessRequest({
      checkout: candidateCheckout,
      session: input.session,
      config: input.config,
      group: input.group,
      listener,
      authIssuer: credentials.authIssuer,
      applicationOrigin: origin,
      revision: input.revision,
      credentialEnvironment: credentials.environment,
      databaseTarget,
    });
    yield* assertWorkflowApiCredentialAuthorityCurrent(
      options.credentialProvider,
      input.session,
      input.revision,
    );
    return { oauthClientId, origin, request };
  });

export const makePreviewWorkflowApiSupervisorAdapters = (options: {
  readonly credentialProvider: PreviewWorkflowApiCredentialProviderApi;
  readonly route: PreviewWorkflowApiApplicationRouteApi;
  readonly processStarter?: ProcessStarter;
  /**
   * Independently verified package provenance supplied by the runtime owner.
   * The checkout policy file is only an empty placeholder and is never trusted.
   */
  readonly trustedRuntimeArtifactAttestations?: PreviewWorkflowApiRuntimeArtifactAttestations;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;
    const trustedRuntimeArtifactAttestations =
      yield* previewWorkflowApiCopyTrustedRuntimeArtifactAttestations(
        options.trustedRuntimeArtifactAttestations,
      );
    const processes = new Map<string, ProcessInfo>();
    const dependencyClosureByCheckout = new Map<
      string,
      { readonly graphRevision: string; readonly digest: string }
    >();
    type UnlaunchedCandidate = {
      readonly record: PreviewWorkflowApiCandidateOwnerRecord;
      readonly state: "staging" | "cleanup-pending" | "owner-record-cleanup-pending";
    };
    const unlaunchedCandidates = new Map<string, UnlaunchedCandidate>();
    const fail = (reason: PreviewWorkflowApiSupervisorError["reason"]) =>
      new PreviewWorkflowApiSupervisorError({ reason });
    const forgetCandidateCleanupRecord = (
      candidateCheckout: string,
      record: PreviewWorkflowApiCandidateOwnerRecord,
    ) =>
      Effect.gen(function* () {
        const removed = yield* Effect.exit(
          removePreviewWorkflowApiCandidateOwnerRecords(fileSystem, record),
        );
        if (Exit.isSuccess(removed)) {
          unlaunchedCandidates.delete(candidateCheckout);
          return;
        }

        const retained = yield* Effect.exit(
          Effect.gen(function* () {
            const pendingRecord = {
              ...record,
              cleanupState: "owner-record-cleanup-pending" as const,
            };
            unlaunchedCandidates.set(candidateCheckout, {
              record: pendingRecord,
              state: "owner-record-cleanup-pending",
            });
            yield* writePreviewWorkflowApiCandidateOwnerRecord(fileSystem, pendingRecord).pipe(
              Effect.mapError((error) =>
                previewWorkflowApiCandidateCleanupError(
                  record,
                  error.phase ?? "candidate-owner-record-retain",
                ),
              ),
            );
          }),
        );
        const error = previewWorkflowApiCandidateCleanupError(
          record,
          "candidate-owner-record-remove",
        );
        if (Exit.isFailure(retained))
          return yield* Effect.failCause(
            Cause.combine(Cause.fail(error), Cause.combine(removed.cause, retained.cause)),
          );
        return yield* Effect.failCause(Cause.combine(Cause.fail(error), removed.cause));
      });
    const removeOwnerRecordAfterCandidateAbsence = (
      candidateCheckout: string,
      candidate: UnlaunchedCandidate,
      sessionId: string,
      checkoutRoot: string,
      generation: number,
    ) =>
      Effect.gen(function* () {
        const record = candidate.record;
        const candidateParent = previewWorkflowApiCandidateParentForCheckout(checkoutRoot);
        if (
          record.candidateCheckout !== candidateCheckout ||
          record.sessionId !== sessionId ||
          record.checkoutRoot !== checkoutRoot ||
          record.generation > generation ||
          !previewWorkflowApiCandidateRecordIsBoundToParent(
            record,
            candidateParent,
            previewWorkflowApiCandidateOwnerRecordPath(candidateCheckout),
          )
        )
          return yield* Effect.fail(previewWorkflowApiCandidateCleanupError(record));

        const exists = yield* inspectPreviewWorkflowApiCandidateForCleanup(
          fileSystem,
          candidateCheckout,
          record,
        );
        if (exists)
          return yield* Effect.fail(
            previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-staging-ambiguous"),
          );

        yield* forgetCandidateCleanupRecord(candidateCheckout, record);
      });
    const markCandidateCleanupPending = (record: PreviewWorkflowApiCandidateOwnerRecord) =>
      Effect.gen(function* () {
        const cleanupPendingRecord = { ...record, cleanupState: "cleanup-pending" as const };
        unlaunchedCandidates.set(record.candidateCheckout, {
          record: cleanupPendingRecord,
          state: "cleanup-pending",
        });
        yield* writePreviewWorkflowApiCandidateOwnerRecord(fileSystem, cleanupPendingRecord);
      });
    const removeOwnedCandidate = (candidateCheckout: string, candidate: UnlaunchedCandidate) =>
      Effect.gen(function* () {
        const record = candidate.record;
        const candidateParent = path.dirname(candidateCheckout);
        if (
          record.candidateCheckout !== candidateCheckout ||
          !previewWorkflowApiCandidateRecordIsBoundToParent(
            record,
            candidateParent,
            previewWorkflowApiCandidateOwnerRecordPath(candidateCheckout),
          )
        )
          return yield* Effect.fail(previewWorkflowApiCandidateCleanupError(record));

        if (candidate.state === "owner-record-cleanup-pending")
          return yield* removeOwnerRecordAfterCandidateAbsence(
            candidateCheckout,
            candidate,
            record.sessionId,
            record.checkoutRoot,
            record.generation,
          );

        const inspected = yield* Effect.exit(
          inspectPreviewWorkflowApiCandidateForCleanup(fileSystem, candidateCheckout, record),
        );
        if (Exit.isFailure(inspected)) {
          const pending = yield* Effect.exit(
            markCandidateCleanupPending(record).pipe(
              Effect.mapError((error) =>
                previewWorkflowApiCandidateCleanupError(
                  record,
                  error.phase ?? "candidate-cleanup-record-write",
                ),
              ),
            ),
          );
          if (Exit.isFailure(pending))
            return yield* Effect.failCause(
              Cause.combine(
                Cause.fail(previewWorkflowApiCandidateCleanupError(record)),
                Cause.combine(inspected.cause, pending.cause),
              ),
            );
          return yield* Effect.failCause(inspected.cause);
        }
        if (!inspected.value) {
          yield* forgetCandidateCleanupRecord(candidateCheckout, record);
          return;
        }
        const removed = yield* Effect.exit(
          Effect.uninterruptible(
            fileSystem
              .remove(candidateCheckout, { recursive: true })
              .pipe(
                Effect.mapError(() =>
                  previewWorkflowApiCandidateCleanupError(record, "candidate-cleanup-remove"),
                ),
              ),
          ),
        );
        if (Exit.isSuccess(removed)) {
          yield* forgetCandidateCleanupRecord(candidateCheckout, record);
          return;
        }
        const pending = yield* Effect.exit(
          markCandidateCleanupPending(record).pipe(
            Effect.mapError((error) =>
              previewWorkflowApiCandidateCleanupError(
                record,
                error.phase ?? "candidate-cleanup-record-write",
              ),
            ),
          ),
        );
        if (Exit.isFailure(pending))
          return yield* Effect.failCause(
            Cause.combine(
              Cause.fail(previewWorkflowApiCandidateCleanupError(record)),
              Cause.combine(removed.cause, pending.cause),
            ),
          );
        return yield* Effect.failCause(
          Cause.combine(Cause.fail(previewWorkflowApiCandidateCleanupError(record)), removed.cause),
        );
      }).pipe(Effect.uninterruptible);
    const retryUnlaunchedCandidates = (
      sessionId: string,
      checkoutRoot: string,
      generation: number,
    ) =>
      Effect.gen(function* () {
        const candidateParent = yield* previewWorkflowApiCandidateParent(
          fileSystem,
          checkoutRoot,
        ).pipe(
          Effect.mapError(
            () =>
              new PreviewWorkflowApiSupervisorError({
                reason: "workflow-source-unavailable",
                sessionId,
                generation,
                sourceStage: "candidate-cleanup-record-read",
              }),
          ),
        );
        const directoryEntries = yield* fileSystem.readDirectory(candidateParent).pipe(
          Effect.mapError(
            () =>
              new PreviewWorkflowApiSupervisorError({
                reason: "workflow-source-unavailable",
                sessionId,
                generation,
                sourceStage: "candidate-cleanup-record-read",
              }),
          ),
        );
        const ownerRecordPaths = directoryEntries
          .filter(
            (entry) =>
              entry.startsWith(previewWorkflowApiCandidatePrefix) &&
              entry.endsWith(previewWorkflowApiCandidateOwnerSuffix),
          )
          .map((entry) => path.join(candidateParent, entry));
        const persistedRecords = yield* Effect.forEach(
          ownerRecordPaths,
          (ownerRecordPath) =>
            readPreviewWorkflowApiCandidateOwnerRecord(
              fileSystem,
              ownerRecordPath,
              candidateParent,
              sessionId,
              checkoutRoot,
              generation,
            ),
          { concurrency: 1 },
        );
        const memoryCandidates = [...unlaunchedCandidates.entries()].filter(
          ([, candidate]) =>
            candidate.state !== "staging" &&
            candidate.record.sessionId === sessionId &&
            candidate.record.checkoutRoot === checkoutRoot &&
            candidate.record.generation <= generation,
        );
        const persistedOwnerRecordPaths = new Set(ownerRecordPaths);
        const persistedCandidates: Array<readonly [string, UnlaunchedCandidate]> = [];
        for (const record of persistedRecords) {
          if (record === undefined) continue;
          const active = unlaunchedCandidates.get(record.candidateCheckout);
          if (
            record.cleanupState === "staging" &&
            active?.record.token === record.token &&
            active.state === "staging"
          )
            continue;
          if (
            record.cleanupState === "staging" ||
            record.cleanupState === "owner-record-cleanup-pending"
          ) {
            yield* removeOwnerRecordAfterCandidateAbsence(
              record.candidateCheckout,
              { record, state: "owner-record-cleanup-pending" },
              sessionId,
              checkoutRoot,
              generation,
            );
            continue;
          }
          if (record.cleanupState !== "cleanup-pending")
            return yield* Effect.fail(previewWorkflowApiCandidateCleanupError(record));
          persistedCandidates.push([
            record.candidateCheckout,
            { record, state: "cleanup-pending" },
          ]);
        }
        const owned = new Map<string, UnlaunchedCandidate>([
          ...memoryCandidates.filter(
            ([candidateCheckout]) =>
              !persistedOwnerRecordPaths.has(
                previewWorkflowApiCandidateOwnerRecordPath(candidateCheckout),
              ),
          ),
          ...persistedCandidates,
        ]);
        yield* Effect.forEach(
          [...owned.entries()],
          ([candidateCheckout, candidate]) =>
            candidate.state === "owner-record-cleanup-pending"
              ? removeOwnerRecordAfterCandidateAbsence(
                  candidateCheckout,
                  candidate,
                  sessionId,
                  checkoutRoot,
                  generation,
                )
              : removeOwnedCandidate(candidateCheckout, candidate),
          { discard: true },
        );
      });
    const failAfterCandidateCleanup = (
      candidateCheckout: string,
      input: PreviewWorkflowApiStartInput,
      failure: Effect.Effect<never, PreviewWorkflowApiSupervisorError>,
    ) =>
      Effect.gen(function* () {
        const failed = yield* Effect.exit(failure);
        if (Exit.isSuccess(failed)) return failed.value;
        const candidate = unlaunchedCandidates.get(candidateCheckout);
        if (candidate === undefined) return yield* Effect.failCause(failed.cause);
        const cleanup = yield* Effect.exit(removeOwnedCandidate(candidateCheckout, candidate));
        if (Exit.isSuccess(cleanup)) return yield* Effect.failCause(failed.cause);
        const originalError = Cause.findErrorOption(failed.cause);
        if (Option.isSome(originalError)) {
          const cleanupUnconfirmed = new PreviewWorkflowApiSupervisorError({
            reason: originalError.value.reason,
            sessionId: input.session.id,
            generation: input.session.generation,
            requestedRevision: input.revision,
            sourceStage: "candidate-cleanup-unconfirmed",
          });
          return yield* Effect.failCause(
            Cause.combine(
              Cause.fail(cleanupUnconfirmed),
              Cause.combine(failed.cause, cleanup.cause),
            ),
          );
        }
        return yield* Effect.failCause(Cause.combine(failed.cause, cleanup.cause));
      });

    const currentSourceRevision: PreviewWorkflowApiSupervisorAdapters["currentSourceRevision"] = (
      checkout,
    ) =>
      Effect.gen(function* () {
        const { root, entries } = yield* previewWorkflowApiSourceEntries(fileSystem, checkout);
        const graphRevision = previewWorkflowApiDependencyGraphRevision(entries);
        const cached = dependencyClosureByCheckout.get(root);
        if (cached !== undefined && cached.graphRevision === graphRevision)
          return previewWorkflowApiSourceRevisionFromFiles(entries, cached.digest);
        const snapshot = yield* previewWorkflowApiSourceSnapshotFromEntries(
          fileSystem,
          root,
          entries,
          trustedRuntimeArtifactAttestations,
        );
        dependencyClosureByCheckout.set(root, {
          graphRevision: snapshot.dependencyGraphRevision,
          digest: snapshot.dependencyClosureDigest,
        });
        return snapshot.revision;
      }).pipe(Effect.mapError(() => fail("workflow-source-unavailable")));
    const startProcess: PreviewWorkflowApiSupervisorAdapters["startProcess"] = (input) =>
      Effect.gen(function* () {
        const checkoutRoot = yield* fileSystem
          .realPath(input.checkout)
          .pipe(Effect.mapError(() => fail("workflow-source-unavailable")));
        yield* retryUnlaunchedCandidates(input.session.id, checkoutRoot, input.session.generation);
        yield* assertWorkflowApiCredentialAuthorityCurrent(
          options.credentialProvider,
          input.session,
          input.revision,
        );
        const listener = yield* workflowApiListener(input);
        yield* verifyWorkflowApiSourceSnapshot(
          fileSystem,
          input,
          trustedRuntimeArtifactAttestations,
        );
        const candidate = yield* stagePreviewWorkflowApiCandidate(
          fileSystem,
          input.checkout,
          input.revision,
          input.group.schemaArtifactDigest,
          trustedRuntimeArtifactAttestations,
          {
            created: (candidateCheckout, candidateCheckoutRoot) => {
              const record: PreviewWorkflowApiCandidateOwnerRecord = {
                schemaVersion: 1,
                checkoutRoot: candidateCheckoutRoot,
                candidateCheckout,
                sessionId: input.session.id,
                generation: input.session.generation,
                revision: input.revision,
                token: randomUUID(),
                cleanupState: "staging",
              };
              unlaunchedCandidates.set(candidateCheckout, { record, state: "staging" });
              return writePreviewWorkflowApiCandidateOwnerRecord(fileSystem, record);
            },
            cleanupConfirmed: (candidateCheckout) => {
              const candidate = unlaunchedCandidates.get(candidateCheckout);
              if (candidate === undefined) return Effect.void;
              return forgetCandidateCleanupRecord(candidateCheckout, candidate.record).pipe(
                Effect.mapError(
                  (error) =>
                    new PreviewWorkflowApiHostError({
                      reason: "workflow-source-unavailable",
                      phase: error.sourceStage ?? "candidate-owner-record-remove",
                    }),
                ),
              );
            },
            cleanupUnconfirmed: (candidateCheckout) => {
              const candidate = unlaunchedCandidates.get(candidateCheckout);
              return candidate === undefined
                ? Effect.void
                : markCandidateCleanupPending(candidate.record);
            },
          },
        ).pipe(
          Effect.mapError(
            (error) =>
              new PreviewWorkflowApiSupervisorError({
                reason: "workflow-source-unavailable",
                sourceStage: error.phase ?? "candidate-snapshot",
              }),
          ),
        );
        const sourceAfterStage = yield* Effect.exit(
          verifyPreviewWorkflowApiCandidateSourceBeforeAdmission(
            fileSystem,
            input,
            trustedRuntimeArtifactAttestations,
          ),
        );
        if (Exit.isFailure(sourceAfterStage))
          return yield* failAfterCandidateCleanup(
            candidate.checkout,
            input,
            Effect.failCause(sourceAfterStage.cause),
          );

        const databaseTargetResult = yield* Effect.exit(
          resolveTrustedWorkflowApiDatabaseTarget(options, input),
        );
        if (Exit.isFailure(databaseTargetResult))
          return yield* failAfterCandidateCleanup(
            candidate.checkout,
            input,
            Effect.failCause(databaseTargetResult.cause),
          );
        const databaseTarget = databaseTargetResult.value;
        const prepared = yield* Effect.exit(
          prepareWorkflowApiProcessRequest(
            options,
            input,
            listener,
            databaseTarget,
            candidate.checkout,
          ),
        );
        if (Exit.isFailure(prepared))
          return yield* failAfterCandidateCleanup(
            candidate.checkout,
            input,
            Effect.failCause(prepared.cause),
          );
        const { oauthClientId, origin, request } = prepared.value;
        const authorityCurrent = yield* Effect.exit(
          assertWorkflowApiCredentialAuthorityCurrent(
            options.credentialProvider,
            input.session,
            input.revision,
          ),
        );
        if (Exit.isFailure(authorityCurrent))
          return yield* failAfterCandidateCleanup(
            candidate.checkout,
            input,
            Effect.failCause(authorityCurrent.cause),
          );
        const starter = options.processStarter ?? startLongLivedProcess;
        const started = yield* Effect.exit(
          Effect.tryPromise({
            try: (signal) => starter(request, signal),
            catch: () => fail("workflow-api-process-start-failed"),
          }).pipe(Effect.mapError(() => fail("workflow-api-process-start-failed"))),
        );
        if (Exit.isFailure(started))
          return yield* failAfterCandidateCleanup(
            candidate.checkout,
            input,
            Effect.failCause(started.cause),
          );
        const running = started.value;
        const id = `${input.session.id}:${input.session.generation}:${input.revision}`;
        const localHost = listener.host === "::1" ? "[::1]" : listener.host;
        const info: ProcessInfo = {
          process: running,
          session: input.session,
          listener,
          group: input.group,
          revision: input.revision,
          oauthClientId,
          localOrigin: `http://${localHost}:${listener.port}`,
          stagedCheckout: candidate.checkout,
        };
        // Keep the exact owner record through the process lifetime. It is removed
        // only after stopProcess confirms deletion of this staged candidate.
        processes.set(id, info);
        return { id, endpoint: origin, opaque: id } satisfies PreviewWorkflowApiProcess;
      });

    const readinessRequestTimeout = Duration.seconds(2);
    const readinessProbeWindow = Duration.seconds(30);
    const probe: PreviewWorkflowApiSupervisorAdapters["probe"] = ({ process }) =>
      Effect.gen(function* () {
        const id = typeof process.opaque === "string" ? process.opaque : process.id;
        const info = processes.get(id);
        if (info === undefined) return yield* Effect.fail(fail("workflow-api-process-not-found"));
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const response = yield* httpClient
            .execute(HttpClientRequest.get(`${info.localOrigin}/ready`))
            .pipe(Effect.timeout(readinessRequestTimeout))
            .pipe(Effect.result);
          if (response._tag === "Success" && response.success.status === 200)
            return readinessFromHeaders(response.success.headers);
          if (response._tag === "Failure") {
            // A process that exits during startup will never produce a successful
            // readiness response; keep retrying only within the bounded probe window.
          }
          yield* Effect.sleep(Duration.millis(250));
        }
        return yield* Effect.fail(fail("workflow-api-readiness-timeout"));
      }).pipe(
        Effect.timeoutOption(readinessProbeWindow),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () => Effect.fail(fail("workflow-api-readiness-timeout")),
            onSome: Effect.succeed,
          }),
        ),
      );

    const probePublishedRoute: PreviewWorkflowApiSupervisorAdapters["probePublishedRoute"] = ({
      process,
      sessionEndpoint,
    }) =>
      Effect.gen(function* () {
        if (sessionEndpoint !== process.endpoint)
          return yield* Effect.fail(fail("workflow-api-readiness-timeout"));
        const readyUrl = new URL("/ready", sessionEndpoint).toString();
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const response = yield* httpClient
            .execute(HttpClientRequest.get(readyUrl))
            .pipe(Effect.timeout(readinessRequestTimeout))
            .pipe(Effect.result);
          if (response._tag === "Success" && response.success.status === 200)
            return readinessFromHeaders(response.success.headers);
          yield* Effect.sleep(Duration.millis(250));
        }
        return yield* Effect.fail(fail("workflow-api-readiness-timeout"));
      }).pipe(
        Effect.timeoutOption(readinessProbeWindow),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () => Effect.fail(fail("workflow-api-readiness-timeout")),
            onSome: Effect.succeed,
          }),
        ),
      );

    const sourceRevisions: PreviewWorkflowApiSupervisorAdapters["sourceRevisions"] = (checkout) =>
      Stream.concat(
        Stream.fromEffect(currentSourceRevision(checkout)),
        Stream.fromEffectSchedule(
          Effect.sleep(Duration.millis(300)).pipe(Effect.andThen(currentSourceRevision(checkout))),
          Schedule.spaced(Duration.millis(300)),
        ),
      ).pipe(Stream.changes);

    const authorityCurrent = options.credentialProvider.assertCurrent;
    const authorityExpiresAt = options.credentialProvider.authorityExpiresAt;
    const authorityNow = options.credentialProvider.authorityNow;

    return {
      ...(authorityCurrent === undefined
        ? {}
        : {
            assertAuthorityCurrent: () =>
              authorityCurrent().pipe(
                Effect.mapError(() => fail("workflow-api-authority-expired")),
              ),
          }),
      ...(authorityExpiresAt === undefined ? {} : { authorityExpiresAt }),
      ...(authorityNow === undefined ? {} : { authorityNow }),
      currentSourceRevision,
      startProcess,
      probe,
      probePublishedRoute,
      sourceRevisions,
      publishRoute: (input) => {
        const id = `${input.session.id}:${input.session.generation}:${input.revision}`;
        const process = processes.get(id);
        if (process === undefined)
          return Effect.fail(
            makePreviewWorkflowApiSupervisorError("process-start-failed", input.session),
          );
        let sessionEndpoint: string | undefined;
        const admitWorkflowRequest = makePreviewWorkflowApiWorkflowRequestRunner({
          controller: input.controller,
          group: input.group,
          oauthClientId: process.oauthClientId,
          endpoint: () => sessionEndpoint,
          ...(options.credentialProvider.assertCurrent === undefined
            ? {}
            : { assertAuthorityCurrent: options.credentialProvider.assertCurrent }),
        });
        return Effect.gen(function* () {
          yield* assertWorkflowApiCredentialAuthorityCurrent(
            options.credentialProvider,
            input.session,
            input.revision,
          );
          const endpoint = yield* options.route
            .publish({
              session: input.session,
              ownerIdentity: input.ownerIdentity,
              revision: input.revision,
              group: input.group,
              listener: process.listener,
              admitWorkflowRequest,
              ...(options.credentialProvider.assertCurrent === undefined
                ? {}
                : { assertAuthorityCurrent: options.credentialProvider.assertCurrent }),
            })
            .pipe(
              Effect.mapError(() =>
                makePreviewWorkflowApiSupervisorError(
                  "route-failed",
                  input.session,
                  input.revision,
                ),
              ),
            );
          yield* Effect.sync(() => (sessionEndpoint = endpoint));
          return endpoint;
        });
      },
      removeRoute: ({ sessionId, generation, ownerIdentity, expectedRevision }) =>
        options.route
          .remove({ sessionId, generation, ownerIdentity, expectedRevision })
          .pipe(Effect.mapError(() => fail("workflow-api-route-removal-failed"))),
      awaitExit: (process) => {
        const id = typeof process.opaque === "string" ? process.opaque : process.id;
        const info = processes.get(id);
        return info === undefined
          ? Effect.fail(fail("workflow-api-process-not-found"))
          : Effect.tryPromise({
              try: () => info.process.exited,
              catch: () => fail("workflow-api-process-exited"),
            }).pipe(Effect.mapError(() => fail("workflow-api-process-exited")));
      },
      stopProcess: (process) => {
        const id = typeof process.opaque === "string" ? process.opaque : process.id;
        const info = processes.get(id);
        if (info === undefined) return Effect.void;
        const ownership = unlaunchedCandidates.get(info.stagedCheckout);
        const cleanupCandidate =
          ownership === undefined
            ? fileSystem
                .remove(info.stagedCheckout, { recursive: true })
                .pipe(Effect.mapError(() => fail("process-stop-failed")))
            : removeOwnedCandidate(info.stagedCheckout, ownership);
        return Effect.tryPromise({
          try: async () => {
            await info.process.kill();
            await info.process.exited;
          },
          catch: () => fail("process-stop-failed"),
        }).pipe(
          Effect.mapError(() => fail("process-stop-failed")),
          Effect.timeoutOption(Duration.seconds(5)),
          Effect.flatMap((stopped) =>
            Option.match(stopped, {
              onNone: () => Effect.fail(fail("process-stop-failed")),
              onSome: () =>
                cleanupCandidate.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      processes.delete(id);
                    }),
                  ),
                ),
            }),
          ),
        );
      },
    } satisfies PreviewWorkflowApiSupervisorAdapters;
  });

export const PreviewWorkflowApiSupervisorLive = (options: {
  readonly credentialProvider: PreviewWorkflowApiCredentialProviderApi;
  readonly route: PreviewWorkflowApiApplicationRouteApi;
  readonly processStarter?: ProcessStarter;
  readonly trustedRuntimeArtifactAttestations?: PreviewWorkflowApiRuntimeArtifactAttestations;
}) =>
  Layer.effect(
    PreviewWorkflowApiSupervisor,
    makePreviewWorkflowApiSupervisorAdapters(options).pipe(
      Effect.map(makePreviewWorkflowApiSupervisor),
    ),
  ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp), Layer.provide(NodeFileSystem.layer));
