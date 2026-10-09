import { Predicate, Schema } from "effect";

/** Server budget: body 60s + prepare 120s + restart 30s + readiness 30s = 240s; client allows 360s. */
export const stagedSourceActivationTimeouts = {
  requestBody: "60 seconds",
  preparation: "120 seconds",
  restart: "30 seconds",
  readiness: "30 seconds",
  transportRequest: "6 minutes",
} as const;

export const StagedSourceFileSchema = Schema.Struct({
  path: Schema.String,
  contentEncoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
  mode: Schema.Number,
});
export type StagedSourceFile = typeof StagedSourceFileSchema.Type;

const SnapshotDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const StagedSourceCompletionSchema = Schema.Struct({
  expectedFileCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  filesDigest: SnapshotDigest,
});
export const StagedSourceSnapshotSchema = Schema.Struct({
  revision: Schema.String,
  files: Schema.Array(StagedSourceFileSchema),
  completion: StagedSourceCompletionSchema,
});
export type StagedSourceSnapshot = typeof StagedSourceSnapshotSchema.Type;

/** Stable JSON representation used as the input to the snapshot SHA-256 digest. */
export const stagedSourceDigestInput = (revision: string, files: ReadonlyArray<StagedSourceFile>) =>
  JSON.stringify({
    revision,
    files: [...files]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map(({ path, contentEncoding, content, mode }) => [path, contentEncoding, content, mode]),
  });

const excludedPath =
  /(^|\/)(node_modules|\.git|\.env(?:\.[^/]*)?|credentials?|secrets?|\.config\/gcloud|\.aws|\.kube|\.npmrc|\.netrc|\.cache\/ms-playwright|\.local-browsers|ms-playwright|browser-binaries|chromium|chrome-linux|firefox|webkit)(\/|$)|(^|\/)(?:google-service-account|service-account|credentials)\.json$|\.(?:pem|p12|pfx|key)$/i;

/** Shared transfer path check so the host and runner reject the same files. */
export const isSafeStagedSourcePath = Predicate.and(
  (path: string) => path.length > 0,
  Predicate.and(
    (path: string) => !path.startsWith("/"),
    Predicate.and(
      (path: string) =>
        !path.split("/").some((part) => part === "" || part === "." || part === ".."),
      (path: string) => !excludedPath.test(path),
    ),
  ),
);

export const StagedSourcePackageManifestSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type StagedSourceSnapshotValidationReason =
  | "missing-revision"
  | "snapshot-completion-mismatch"
  | "excluded-or-unsafe-path"
  | "duplicate-path"
  | "invalid-mode"
  | "invalid-base64-content"
  | "invalid-package-manifest-encoding"
  | "invalid-package-manifest"
  | "incomplete-workspace-manifest";

const isCanonicalBase64 = (content: string) => {
  try {
    return btoa(atob(content)) === content;
  } catch {
    return false;
  }
};

const isValidPackageManifest = (content: string) => {
  try {
    Schema.decodeUnknownSync(Schema.fromJsonString(StagedSourcePackageManifestSchema))(content);
    return true;
  } catch {
    return false;
  }
};

const validateStagedSourcePackageManifest = (
  file: StagedSourceFile,
): StagedSourceSnapshotValidationReason | undefined => {
  if (file.path !== "package.json" && !/^packages\/[^/]+\/package\.json$/.test(file.path))
    return undefined;
  if (file.contentEncoding !== "utf8") return "invalid-package-manifest-encoding";
  return isValidPackageManifest(file.content) ? undefined : "invalid-package-manifest";
};

const validateStagedSourceFile = (
  file: StagedSourceFile,
  paths: ReadonlySet<string>,
): StagedSourceSnapshotValidationReason | undefined => {
  if (!isSafeStagedSourcePath(file.path)) return "excluded-or-unsafe-path";
  if (paths.has(file.path)) return "duplicate-path";
  if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) return "invalid-mode";
  if (file.contentEncoding === "base64" && !isCanonicalBase64(file.content))
    return "invalid-base64-content";
  return validateStagedSourcePackageManifest(file);
};

const validateStagedSourceFiles = (
  files: ReadonlyArray<StagedSourceFile>,
): StagedSourceSnapshotValidationReason | undefined => {
  const paths = new Set<string>();
  for (const file of files) {
    const reason = validateStagedSourceFile(file, paths);
    if (reason !== undefined) return reason;
    paths.add(file.path);
  }
  return paths.has("package.json") && paths.has("pnpm-lock.yaml")
    ? undefined
    : "incomplete-workspace-manifest";
};

/** Pure structural validation shared by host orchestration and the runner endpoint. */
export const validateStagedSourceSnapshot = (
  snapshot: StagedSourceSnapshot,
  expectedFilesDigest: string,
): StagedSourceSnapshotValidationReason | undefined => {
  if (snapshot.revision.length === 0) return "missing-revision";
  if (
    snapshot.completion.expectedFileCount !== snapshot.files.length ||
    snapshot.completion.filesDigest !== expectedFilesDigest
  )
    return "snapshot-completion-mismatch";
  return validateStagedSourceFiles(snapshot.files);
};

export const StagedRunnerSnapshotIdentitySchema = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Schema.Literal("ordinary-runner"),
});
export type StagedRunnerSnapshotIdentity = typeof StagedRunnerSnapshotIdentitySchema.Type;

export const StagedRunnerSnapshotActivationRequestSchema = Schema.Struct({
  identity: StagedRunnerSnapshotIdentitySchema,
  snapshot: StagedSourceSnapshotSchema,
});
export type StagedRunnerSnapshotActivationRequest =
  typeof StagedRunnerSnapshotActivationRequestSchema.Type;

export const RunnerRoleSchema = Schema.Literals(["ordinary-runner", "workflow-api"]);
export type RunnerRole = typeof RunnerRoleSchema.Type;

export const RunnerRevisionStatusSchema = Schema.Struct({
  requestedRevision: Schema.String,
  activeRevision: Schema.NullOr(Schema.String),
  unavailableRoles: Schema.Array(RunnerRoleSchema),
  failure: Schema.NullOr(Schema.String),
});
export type RunnerRevisionStatus = typeof RunnerRevisionStatusSchema.Type;
