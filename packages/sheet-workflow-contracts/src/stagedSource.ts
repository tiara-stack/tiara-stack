import { Predicate, Schema } from "effect";

/** Server budget: authority 60s + body 60s + prepare 120s + restart 30s + readiness 30s = 300s; client allows 360s. */
export const stagedSourceActivationTimeouts = {
  /** TIA-229's approved read-only preflight budget, separate from snapshot preparation. */
  authority: "60 seconds",
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

export const StagedRunnerRoleSchema = Schema.Literals(["ordinary-runner", "browser-runner"]);
export type StagedRunnerRole = typeof StagedRunnerRoleSchema.Type;

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
  role: StagedRunnerRoleSchema,
});
export type StagedRunnerSnapshotIdentity = typeof StagedRunnerSnapshotIdentitySchema.Type;

export const StagedRunnerSnapshotActivationRequestSchema = Schema.Struct({
  identity: StagedRunnerSnapshotIdentitySchema,
  snapshot: StagedSourceSnapshotSchema,
});
export type StagedRunnerSnapshotActivationRequest =
  typeof StagedRunnerSnapshotActivationRequestSchema.Type;

export const RunnerRoleSchema = Schema.Literals([
  "workflow-api",
  "ordinary-runner",
  "browser-runner",
]);
export type RunnerRole = typeof RunnerRoleSchema.Type;

export const WorkflowRecreationRecoverySchema = Schema.Struct({
  failureReason: Schema.NonEmptyString,
  freshSessionDisposition: Schema.Literals([
    "ended",
    "expired",
    "active",
    "pending",
    "pending-quarantined",
    "state-unverified",
  ]),
  freshGroupQuarantineDisposition: Schema.Literals(["unconfirmed", "quarantined"]),
  quarantineDisposition: Schema.Literals([
    "pending",
    "quarantined",
    "ordinary-reassignment-blocked",
    "unconfirmed",
  ]),
  ordinaryReassignmentBlocked: Schema.NullOr(Schema.Boolean),
  recoveryRecordId: Schema.NonEmptyString,
  recoveryRecordWritten: Schema.Boolean,
  recoveryRecordUpdated: Schema.Boolean,
});
export type WorkflowRecreationRecovery = typeof WorkflowRecreationRecoverySchema.Type;

/** Human and machine status for each lifecycle boundary; only confirmed results advance. */
export const WorkflowTransitionPhaseFactsSchema = Schema.Struct({
  proposal: Schema.Literals(["not-started", "presented", "unconfirmed"]),
  admission: Schema.Literals(["not-started", "paused", "unconfirmed"]),
  producerFencing: Schema.Literals(["not-started", "fenced", "unconfirmed"]),
  drain: Schema.Literals(["not-started", "completed", "not-required", "ambiguous", "unconfirmed"]),
  cancellation: Schema.Literals([
    "not-started",
    "completed",
    "not-required",
    "ambiguous",
    "unconfirmed",
  ]),
  reconciliation: Schema.Literals([
    "not-started",
    "completed",
    "not-required",
    "ambiguous",
    "unconfirmed",
  ]),
  settlement: Schema.Literals(["not-started", "settled", "ambiguous", "unconfirmed"]),
  cessation: Schema.Literals(["not-started", "proven", "unproven", "unconfirmed"]),
  oldSessionEnd: Schema.Literals(["not-started", "ended", "unconfirmed"]),
  cleanup: Schema.Literals(["not-started", "completed", "unconfirmed"]),
  freshGroup: Schema.Literals(["not-started", "provisioned", "unconfirmed"]),
  activation: Schema.Literals(["not-started", "activated", "unconfirmed"]),
  quarantine: Schema.Literals(["not-started", "confirmed", "unconfirmed"]),
  ordinaryReassignment: Schema.Literals(["not-started", "blocked", "not-blocked", "unconfirmed"]),
  drainElapsedMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  cancellationReconciliationElapsedMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  cessationProofElapsedMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  settlementElapsedMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  acceptedWorkElapsedMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type WorkflowTransitionPhaseFacts = typeof WorkflowTransitionPhaseFactsSchema.Type;

export const WorkflowTransitionReasonSchema = Schema.Literals([
  "compatibility-evidence-unverified",
  "declared-contract-incompatible",
  "workflow-contracts-changed",
  "durable-deployment-changed",
  "action-version-changed",
  "workflow-group-added",
  "workflow-group-removed",
  "workflow-role-added",
  "workflow-role-removed",
]);
export type WorkflowTransitionReason = typeof WorkflowTransitionReasonSchema.Type;

export const WorkflowRecreationDiagnosticSchema = Schema.Struct({
  oldCleanupRecordId: Schema.NonEmptyString,
  freshSessionId: Schema.NonEmptyString,
  freshGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  priorRevision: Schema.NonEmptyString,
  requestedRevision: Schema.NonEmptyString,
  reasons: Schema.Array(WorkflowTransitionReasonSchema),
  phases: Schema.optionalKey(WorkflowTransitionPhaseFactsSchema),
  recovery: Schema.optionalKey(WorkflowRecreationRecoverySchema),
});
export type WorkflowRecreationDiagnostic = typeof WorkflowRecreationDiagnosticSchema.Type;

export const RunnerRevisionStatusSchema = Schema.Struct({
  requestedRevision: Schema.String,
  activeRevision: Schema.NullOr(Schema.String),
  unavailableRoles: Schema.Array(RunnerRoleSchema),
  failure: Schema.NullOr(Schema.String),
  oldCleanupRecordId: Schema.optionalKey(Schema.NonEmptyString),
  workflowRecreation: Schema.optionalKey(WorkflowRecreationDiagnosticSchema),
  workflowTransitionPhases: Schema.optionalKey(WorkflowTransitionPhaseFactsSchema),
});
export type RunnerRevisionStatus = typeof RunnerRevisionStatusSchema.Type;
