import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { SqlClient, SqlError } from "effect/unstable/sql";

/** A provider measurement is usable only when the provider has actually observed it. */
export const CapacityMeasurementSchema = Schema.Struct({
  provider: Schema.String,
  identity: Schema.String,
  dimension: Schema.String,
  observedAt: Schema.Number,
  total: Schema.Number,
  inUse: Schema.Number,
  grantsVerified: Schema.Boolean,
});
export type CapacityMeasurement = typeof CapacityMeasurementSchema.Type;

const PositiveMeasurementAge = Schema.Int.check(Schema.isGreaterThan(0));
export const PreviewAllocationConfigSchema = Schema.Struct({
  maximumMeasurementAgeMs: PositiveMeasurementAge,
});
export type PreviewAllocationConfig = typeof PreviewAllocationConfigSchema.Type;
export const DEFAULT_PREVIEW_ALLOCATION_CONFIG: PreviewAllocationConfig = {
  maximumMeasurementAgeMs: 15 * 60_000,
};
export const DEFAULT_PREVIEW_RESOURCE_ADAPTER_TIMEOUT_MS = 60_000;
const previewAcceptedWorkDrainMs = 5 * 60_000;
const previewSettlementRecoveryMs = 5 * 60_000;
const previewCleanupProofStabilityMs = 5 * 60_000;
export const previewOwnedResourceDeletionMs = 5 * 60_000;
export const previewCleanupReportingBudgetMs = 5_000;
const hasFreshDeletionClaim = (
  ledger: readonly Record<string, unknown>[],
  observedAt: number,
  timeoutMs: number,
) =>
  ledger.some(
    (entry) =>
      entry.state === "deleting" &&
      typeof entry.updated_at === "number" &&
      entry.updated_at > observedAt - timeoutMs,
  );
const initialDeletionWorkBudgetMs = (
  deletionStartedAt: number | null,
  proofStableAt: number,
  observedAt: number,
  hasFreshClaim: boolean,
) => {
  const maximumWorkMs = previewOwnedResourceDeletionMs - previewCleanupReportingBudgetMs;
  if (deletionStartedAt === null || deletionStartedAt < proofStableAt)
    return hasFreshClaim ? 0 : maximumWorkMs;
  const remainingMs = deletionStartedAt + previewOwnedResourceDeletionMs - observedAt;
  if (remainingMs > 0)
    return Math.min(maximumWorkMs, remainingMs - previewCleanupReportingBudgetMs);
  return hasFreshClaim ? 0 : maximumWorkMs;
};
const cleanupPreDeletionWindow = (
  startedAt: number,
  deadlineAt: number | undefined,
  expiredReason: "cleanup-pre-deletion-deadline-exceeded" | "cleanup-resolution-deadline-exceeded",
) => {
  if (deadlineAt !== undefined && !Number.isFinite(deadlineAt))
    return { error: "invalid-cleanup-deadline" } as const;
  const workDeadlineAt =
    (deadlineAt ?? startedAt + previewOwnedResourceDeletionMs) - previewCleanupReportingBudgetMs;
  const workBudgetMs = workDeadlineAt - startedAt;
  return workBudgetMs <= 0 ? { error: expiredReason } : { workDeadlineAt, workBudgetMs };
};
const buildProofValidationTiming = (
  proofAt: number | null,
  observedAt: number,
): PreviewCleanupTimingStatus["proofValidation"] => {
  if (proofAt === null)
    return { status: "unverified", proofAt: null, elapsedMs: null, remainingMs: null };
  const completeAt = proofAt + previewCleanupProofStabilityMs;
  return {
    status: observedAt >= completeAt ? "complete" : "validating",
    proofAt,
    elapsedMs: Math.max(0, Math.min(observedAt - proofAt, previewCleanupProofStabilityMs)),
    remainingMs: Math.max(0, completeAt - observedAt),
  };
};

const buildDeletionAttemptTiming = (
  deletionStartedAt: number | null,
  completedAt: number | null,
  quarantineReason: unknown,
  observedAt: number,
  unverified = false,
): PreviewCleanupTimingStatus["deletionAttempt"] => {
  if (deletionStartedAt === null)
    return { status: "not-started", startedAt: null, elapsedMs: null, remainingMs: null };
  if (unverified && completedAt === null)
    return {
      status: "unverified",
      startedAt: deletionStartedAt,
      elapsedMs: null,
      remainingMs: null,
    };
  const deadlineAt = deletionStartedAt + previewOwnedResourceDeletionMs;
  let status: PreviewCleanupTimingStatus["deletionAttempt"]["status"];
  if (completedAt !== null) status = "complete";
  else if (observedAt >= deadlineAt) status = "expired";
  else if (quarantineReason === "deletion-failed") status = "failed";
  else status = "in-progress";
  const endAt = completedAt ?? observedAt;
  const remainingMs = status === "complete" ? 0 : Math.max(0, deadlineAt - observedAt);
  return {
    status,
    startedAt: deletionStartedAt,
    elapsedMs: Math.max(0, Math.min(endAt - deletionStartedAt, previewOwnedResourceDeletionMs)),
    remainingMs,
  };
};

type CleanupTimingData = {
  readonly settlementStartedAt: number;
  readonly completedAt: number | null;
  readonly proofAt: number | null;
  readonly deletionStartedAt: number | null;
  readonly quarantineReason: unknown;
};

type CleanupProofToken = {
  readonly proofAt: number;
  readonly generation: number;
};

type CleanupProofValidation =
  | { readonly _tag: "Verified"; readonly proof: CleanupProofToken }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "ConfirmedInvalidation" }
  | { readonly _tag: "DeadlineExpired" }
  | { readonly _tag: "TimedOut" }
  | { readonly _tag: "Uncertain" };

const cleanupTimingDataFromRow = (
  cleanupState: Record<string, unknown> | undefined,
): CleanupTimingData | null => {
  if (cleanupState === undefined || Number(cleanupState.has_cleanup_timing) !== 1) return null;
  return {
    settlementStartedAt: Number(cleanupState.settlement_started_at),
    completedAt: cleanupState.completed_at == null ? null : Number(cleanupState.completed_at),
    proofAt: cleanupState.proof_at == null ? null : Number(cleanupState.proof_at),
    deletionStartedAt:
      cleanupState.deletion_started_at == null ? null : Number(cleanupState.deletion_started_at),
    quarantineReason: cleanupState.quarantine_reason,
  };
};

const hasProofBoundDeletionAttempt = (timing: CleanupTimingData) =>
  timing.deletionStartedAt !== null &&
  timing.proofAt !== null &&
  timing.deletionStartedAt >= timing.proofAt + previewCleanupProofStabilityMs;

const hasUnverifiedDeletionTimestamp = (timing: CleanupTimingData) =>
  timing.deletionStartedAt !== null &&
  timing.completedAt === null &&
  !hasProofBoundDeletionAttempt(timing);

const visibleDeletionStartedAt = (timing: CleanupTimingData, hasFreshDeletionClaim: boolean) => {
  if (timing.completedAt !== null || hasFreshDeletionClaim) return timing.deletionStartedAt;
  return hasProofBoundDeletionAttempt(timing) || hasUnverifiedDeletionTimestamp(timing)
    ? timing.deletionStartedAt
    : null;
};

const buildCleanupTimingStatus = (
  timing: CleanupTimingData | null,
  observedAt: number,
  hasFreshDeletionClaim: boolean,
): PreviewCleanupTimingStatus | null => {
  if (timing === null) return null;
  const endAt = timing.completedAt ?? observedAt;
  const deletionStartedAt = visibleDeletionStartedAt(timing, hasFreshDeletionClaim);
  return {
    totalElapsedMs: Math.max(0, endAt - timing.settlementStartedAt),
    proofValidation: buildProofValidationTiming(timing.proofAt, observedAt),
    deletionAttempt: buildDeletionAttemptTiming(
      deletionStartedAt,
      timing.completedAt,
      timing.quarantineReason,
      observedAt,
      hasUnverifiedDeletionTimestamp(timing),
    ),
  };
};
const cleanupOutcome = (
  cleanupState: Record<string, unknown> | undefined,
): PreviewAllocationStatus["cleanup"] => {
  if (cleanupState === undefined) return null;
  if (cleanupState.completed_at !== null) return "cleaned";
  return cleanupState.quarantine_reason == null ? "waiting" : "quarantined";
};
export type PreviewAllocationConfigParseResult =
  | { readonly config: PreviewAllocationConfig; readonly error?: never }
  | { readonly config?: never; readonly error: string };

export const parsePreviewAllocationConfig = (
  rawMaximumMeasurementAgeMs: string | undefined,
): PreviewAllocationConfigParseResult => {
  const value = rawMaximumMeasurementAgeMs?.trim();
  if (value === undefined || value === "") return { config: DEFAULT_PREVIEW_ALLOCATION_CONFIG };
  if (!/^[0-9]+$/.test(value))
    return { error: "TIARA_PREVIEW_MAX_MEASUREMENT_AGE_MS must be a positive safe integer." };
  const maximumMeasurementAgeMs = Number(value);
  if (!Number.isSafeInteger(maximumMeasurementAgeMs) || maximumMeasurementAgeMs < 1)
    return { error: "TIARA_PREVIEW_MAX_MEASUREMENT_AGE_MS must be a positive safe integer." };
  return { config: { maximumMeasurementAgeMs } };
};

export const VerifiedAllocationResolutionSchema = Schema.Struct({
  sessionId: Schema.String,
  resource: Schema.String,
  ownerToken: Schema.String,
  provider: Schema.String,
  identity: Schema.String,
  verifiedAt: Schema.Number,
  /** The provider confirms the allocation request is terminal, not merely absent right now. */
  allocationSettled: Schema.Boolean,
  result: Schema.Union([
    Schema.Struct({ status: Schema.Literal("found"), providerResourceId: Schema.String }),
    Schema.Struct({ status: Schema.Literal("absent") }),
  ]),
});
export type VerifiedAllocationResolution = typeof VerifiedAllocationResolutionSchema.Type;

export const PreviewCapacityBaselineSchema = Schema.Struct({
  measurements: Schema.Array(CapacityMeasurementSchema),
  profiles: Schema.Array(
    Schema.Struct({
      profile: Schema.String,
      selectedRoles: Schema.Array(Schema.String),
      ownedGroups: Schema.Array(Schema.String),
      demands: Schema.Array(
        Schema.Struct({
          dimension: Schema.String,
          amount: Schema.Number,
          provider: Schema.String,
          identity: Schema.String,
        }),
      ),
      resources: Schema.Array(Schema.String),
    }),
  ),
});
export type PreviewCapacityBaseline = typeof PreviewCapacityBaselineSchema.Type;

export interface CapacityDemand {
  readonly dimension: string;
  readonly amount: number;
  readonly provider: string;
  readonly identity: string;
}

const CapacityDemandSchema = Schema.Struct({
  dimension: Schema.String,
  amount: Schema.Number,
  provider: Schema.String,
  identity: Schema.String,
});

/** Unit-bearing dimensions providers must observe for each owned preview group. */
export const previewCapacityDimensionsByGroup = {
  "application-zero": [
    "postgres.databases.count",
    "postgres.roles.count",
    "postgres.active_slots.count",
    "postgres.temporary_slots.count",
    "postgres.senders.count",
    "postgres.connections.count",
    "postgres.wal.bytes",
    "postgres.sync_resync.bytes",
    "zero_cache.cpu.millicores",
    "zero_cache.memory.bytes",
    "zero_cache.storage.bytes",
  ],
  "workflow-execution": [
    "postgres.connections.count",
    "postgres.wal.bytes",
    "redis.memory.bytes",
    "workflow_api.cpu.millicores",
    "workflow_api.memory.bytes",
    "workflow_api.storage.bytes",
    "runner.cpu.millicores",
    "runner.memory.bytes",
    "runner.storage.bytes",
    "runner.slots.count",
    "browser_runner.slots.count",
  ],
  auth: [
    "postgres.connections.count",
    "redis.memory.bytes",
    "oauth.registrations.count",
    "issuer.capacity.count",
  ],
  "bot-storage": [
    "redis.memory.bytes",
    "discord.gateway.exclusive_slots.count",
    "google_sheets.target.exclusive_slots.count",
  ],
  search: [
    "meilisearch.cpu.millicores",
    "meilisearch.memory.bytes",
    "meilisearch.storage.bytes",
    "meilisearch.rebuild_slots.count",
  ],
} as const;
const allPreviewCapacityDimensions = new Set<string>(
  Object.values(previewCapacityDimensionsByGroup).flatMap((dimensions) => [...dimensions]),
);

export interface PreviewResourceAdapter {
  readonly planProfile: (input: {
    readonly profile: string;
    readonly selectedRoles: readonly string[];
    readonly ownedGroups: readonly string[];
  }) => Effect.Effect<PreviewProfileDemandPlan, Error>;
  readonly validateProfileAllocation: (input: {
    readonly profile: string;
    readonly selectedRoles: readonly string[];
    readonly ownedGroups: readonly string[];
  }) => Effect.Effect<void, Error>;
  /** Adapter must allocate only resources in the disposable preview boundary. */
  readonly allocate: (input: {
    readonly sessionId: string;
    readonly ownerToken: string;
    readonly resource: string;
    readonly metadata?: PreviewResourceMetadata;
    readonly priorResources?: Readonly<Record<string, string>>;
  }) => Effect.Effect<string, Error | PlatformError, FileSystem.FileSystem>;
  /**
   * Delete must validate the exact provider identity and owner token before deletion and be
   * idempotent for that exact owned resource so a controller restart can safely retry.
   */
  readonly deleteOwned: (input: {
    readonly sessionId: string;
    readonly providerResourceId: string;
    readonly ownerToken: string;
    readonly resource: string;
  }) => Effect.Effect<void, Error | PlatformError, FileSystem.FileSystem>;
  /** Settlement/proof adapters may withhold deletion until their evidence is available. */
  readonly proveCleanup: (input: {
    readonly sessionId: string;
    readonly resources: readonly {
      readonly resource: string;
      readonly providerResourceId: string | null;
      readonly ownerToken: string;
    }[];
  }) => Effect.Effect<boolean, Error | PlatformError, FileSystem.FileSystem>;
  /**
   * Direct provider lookup used only by an explicit owner-authorized resolution action. The
   * adapter must establish that the allocation request is terminal before reporting absence.
   */
  readonly resolveUnknown?: (input: {
    readonly sessionId: string;
    readonly resource: string;
    readonly ownerToken: string;
    readonly providerIdentities: readonly {
      readonly provider: string;
      readonly identity: string;
    }[];
  }) => Effect.Effect<VerifiedAllocationResolution, Error | PlatformError, FileSystem.FileSystem>;
}

/** Small serializable target metadata for provider resources, kept out of the durable ledger. */
export type PreviewResourceMetadata = Readonly<Record<string, string | number | boolean>>;

export interface PreviewProfileDemandPlan {
  readonly demands: readonly CapacityDemand[];
  readonly resources: readonly string[];
}

export interface PreviewAllocationStatus {
  readonly reservations: readonly {
    readonly dimension: string;
    readonly amount: number;
    readonly provider: string;
    readonly identity: string;
    readonly releasedAt: number | null;
  }[];
  readonly allocations: readonly {
    readonly resource: string;
    readonly providerResourceId: string | null;
    readonly state:
      | "allocating"
      | "owned"
      | "deleting"
      | "quarantined"
      | "deleted"
      | "not-allocated";
    readonly failure: string | null;
  }[];
  readonly cleanup: "waiting" | "quarantined" | "cleaned" | null;
  readonly cleanupTiming: PreviewCleanupTimingStatus | null;
}

export interface PreviewAllocationCleanupResult {
  readonly outcome: "waiting" | "cleaned" | "quarantined";
  /** Persisted absolute post-proof attempt deadline returned by this bounded cleanup call. */
  readonly deletionDeadlineAt: number | null;
  /** Remaining time to that deadline, measured with the allocation controller's clock. */
  readonly remainingDeletionMs: number | null;
  /**
   * Whether cleanup established a proof-bound attempt or coherent absence, or is
   * uncertain/contended, unverified, or invalidated.
   */
  readonly reportAttemptState: "known" | "absent" | "unknown" | "unverified" | "invalidated";
  /** Typed cleanup failure preserved as data so callers can respect the report deadline. */
  readonly failure: PreviewAllocationError | SqlError.SqlError | Error | PlatformError | null;
}

type PreviewAllocationCleanupReportWindow = {
  state: PreviewAllocationCleanupResult["reportAttemptState"];
  deletionDeadlineAt: number | null;
};

type CleanupProofWorkPlan =
  | {
      readonly _tag: "Skip";
      readonly reportAttemptState: PreviewAllocationCleanupResult["reportAttemptState"];
      readonly outcome: PreviewAllocationCleanupResult["outcome"];
    }
  | {
      readonly _tag: "Run";
      readonly reportAttemptState: PreviewAllocationCleanupResult["reportAttemptState"];
      readonly outcome: PreviewAllocationCleanupResult["outcome"];
      readonly deadlineAt: number;
      readonly budgetMs: number;
    };

const cleanupReportWindowFromAuthorization = (authorization: {
  readonly deletionStartedAt: number | null;
  readonly proofAt: number | null;
}): PreviewAllocationCleanupReportWindow => {
  if (authorization.deletionStartedAt === null)
    return { state: "absent", deletionDeadlineAt: null };
  if (authorization.proofAt === null) return { state: "unverified", deletionDeadlineAt: null };
  const proofStableAt = authorization.proofAt + previewCleanupProofStabilityMs;
  return authorization.deletionStartedAt >= proofStableAt
    ? {
        state: "known",
        deletionDeadlineAt: authorization.deletionStartedAt + previewOwnedResourceDeletionMs,
      }
    : { state: "unverified", deletionDeadlineAt: null };
};

const cleanupReportAttemptStateForSnapshot = (
  state: PreviewAllocationCleanupResult["reportAttemptState"],
  hasFreshClaim: boolean,
): PreviewAllocationCleanupResult["reportAttemptState"] =>
  state === "absent" && hasFreshClaim ? "unknown" : state;

const cleanupSnapshotOutcome = (
  hasUnknownResources: boolean,
  hasFreshClaim: boolean,
): PreviewAllocationCleanupResult["outcome"] =>
  hasUnknownResources || hasFreshClaim ? "quarantined" : "waiting";

const activeCleanupAttemptDeadlineAt = (
  reportWindow: PreviewAllocationCleanupReportWindow,
  reportAttemptState: PreviewAllocationCleanupResult["reportAttemptState"],
  observedAt: number,
  hasFreshClaim: boolean,
) => {
  if (reportAttemptState !== "known") return null;
  const deadlineAt = reportWindow.deletionDeadlineAt;
  if (deadlineAt === null) return null;
  if (deadlineAt > observedAt || hasFreshClaim) return deadlineAt;
  return null;
};

const cleanupProofWorkDeadlineAt = (callDeadlineAt: number, attemptDeadlineAt: number | null) =>
  attemptDeadlineAt === null
    ? callDeadlineAt
    : Math.min(callDeadlineAt, attemptDeadlineAt - previewCleanupReportingBudgetMs);

const planCleanupProofWork = (
  reportWindow: PreviewAllocationCleanupReportWindow,
  ledger: readonly Record<string, unknown>[],
  observedAt: number,
  callDeadlineAt: number,
  adapterTimeoutMs: number,
): CleanupProofWorkPlan => {
  const hasUnknownResources = ledger.some(
    (entry) => typeof entry.provider_resource_id !== "string" || entry.provider_resource_id === "",
  );
  const hasFreshClaim = hasFreshDeletionClaim(ledger, observedAt, adapterTimeoutMs);
  const reportAttemptState = cleanupReportAttemptStateForSnapshot(
    reportWindow.state,
    hasFreshClaim,
  );
  const outcome = cleanupSnapshotOutcome(hasUnknownResources, hasFreshClaim);
  if (
    reportAttemptState === "unknown" ||
    reportAttemptState === "invalidated" ||
    (hasFreshClaim && reportAttemptState !== "known")
  )
    return { _tag: "Skip", reportAttemptState, outcome };
  const activeDeadlineAt = activeCleanupAttemptDeadlineAt(
    reportWindow,
    reportAttemptState,
    observedAt,
    hasFreshClaim,
  );
  const deadlineAt = cleanupProofWorkDeadlineAt(callDeadlineAt, activeDeadlineAt);
  const budgetMs = deadlineAt - observedAt;
  return budgetMs <= 0
    ? { _tag: "Skip", reportAttemptState, outcome }
    : { _tag: "Run", reportAttemptState, outcome, deadlineAt, budgetMs };
};

const makePreviewAllocationCleanupResult = (
  outcome: PreviewAllocationCleanupResult["outcome"],
  reportWindow: PreviewAllocationCleanupReportWindow,
  now: () => number,
  failure: PreviewAllocationCleanupResult["failure"] = null,
): PreviewAllocationCleanupResult => ({
  outcome,
  deletionDeadlineAt: reportWindow.state === "known" ? reportWindow.deletionDeadlineAt : null,
  remainingDeletionMs:
    reportWindow.state !== "known" || reportWindow.deletionDeadlineAt === null
      ? null
      : Math.max(0, reportWindow.deletionDeadlineAt - now()),
  reportAttemptState: reportWindow.state,
  failure,
});

const PreviewCapacityReservationRowSchema = Schema.Struct({
  dimension: Schema.String,
  amount: Schema.Number,
  provider: Schema.String,
  provider_identity: Schema.String,
  released_at: Schema.NullOr(Schema.Number),
});
const PreviewAllocationLedgerStatusRowSchema = Schema.Struct({
  resource: Schema.String,
  provider_resource_id: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    "allocating",
    "owned",
    "deleting",
    "quarantined",
    "deleted",
    "not-allocated",
  ]),
  updated_at: Schema.Number,
  failure: Schema.NullOr(Schema.String),
});
const PreviewAllocationCleanupRowSchema = Schema.Struct({
  resource: Schema.String,
  owner_token: Schema.String,
  provider_resource_id: Schema.NullOr(Schema.String),
  state: Schema.Literals([
    "allocating",
    "owned",
    "deleting",
    "quarantined",
    "deleted",
    "not-allocated",
  ]),
  updated_at: Schema.Number,
  failure: Schema.NullOr(Schema.String),
});
const PreviewCleanupAuthorizationRowSchema = Schema.Struct({
  proof_generation: Schema.Number,
  proof_at: Schema.NullOr(Schema.Number),
  deletion_started_at: Schema.NullOr(Schema.Number),
  resource: Schema.NullOr(Schema.String),
  owner_token: Schema.NullOr(Schema.String),
  provider_resource_id: Schema.NullOr(Schema.String),
  state: Schema.NullOr(
    Schema.Literals(["allocating", "owned", "deleting", "quarantined", "deleted", "not-allocated"]),
  ),
  updated_at: Schema.NullOr(Schema.Number),
  failure: Schema.NullOr(Schema.String),
});
type PreviewCleanupAuthorizationRow = typeof PreviewCleanupAuthorizationRowSchema.Type;
const firstCleanupAuthorization = (rows: readonly PreviewCleanupAuthorizationRow[]) => {
  const first = rows[0];
  if (first === undefined)
    return { proofGeneration: undefined, proofAt: null, deletionStartedAt: null };
  return {
    proofGeneration: first.proof_generation,
    proofAt: first.proof_at,
    deletionStartedAt: first.deletion_started_at,
  };
};
const PreviewResourceRowSchema = Schema.Struct({ resource: Schema.String });
const PreviewAllocationStateRowSchema = Schema.Struct({
  state: Schema.Literals([
    "allocating",
    "owned",
    "deleting",
    "quarantined",
    "deleted",
    "not-allocated",
  ]),
});
const PreviewAllocationOwnerRowSchema = Schema.Struct({
  resource: Schema.String,
  owner_token: Schema.String,
});
type PreviewAllocationOwnerRow = typeof PreviewAllocationOwnerRowSchema.Type;
const PreviewCleanupCompletionRowSchema = Schema.Struct({
  completed_at: Schema.NullOr(Schema.Number),
});
const PreviewCleanupProofAtRowSchema = Schema.Struct({ proof_at: Schema.NullOr(Schema.Number) });
const PreviewDeletionAttemptStartRowSchema = Schema.Struct({
  deletion_started_at: Schema.NullOr(Schema.Number),
});
const PreviewProviderIdentityRowSchema = Schema.Struct({
  provider: Schema.String,
  provider_identity: Schema.String,
});
const PersistedPreviewProfileDemandPlanRowSchema = Schema.Struct({
  selected_roles: Schema.String,
  owned_groups: Schema.String,
  demands: Schema.String,
  resources: Schema.String,
});

export interface PreviewCleanupTimingStatus {
  readonly totalElapsedMs: number;
  readonly proofValidation: {
    readonly status: "unverified" | "validating" | "complete";
    readonly proofAt: number | null;
    readonly elapsedMs: number | null;
    readonly remainingMs: number | null;
  };
  readonly deletionAttempt: {
    readonly status:
      | "not-started"
      | "unverified"
      | "in-progress"
      | "failed"
      | "expired"
      | "complete";
    readonly startedAt: number | null;
    readonly elapsedMs: number | null;
    readonly remainingMs: number | null;
  };
}

export interface CapacityCheckResult extends CapacityDemand {
  readonly status:
    | "ready"
    | "missing"
    | "provider-mismatch"
    | "unverified-grants"
    | "stale"
    | "exhausted";
  readonly observedProviders: readonly string[];
  readonly reserved: number | null;
  readonly available: number | null;
}

export interface PreviewAllocationApi {
  readonly importBaseline: (
    baseline: PreviewCapacityBaseline,
  ) => Effect.Effect<
    { readonly measurements: number; readonly profiles: number },
    PreviewAllocationError | SqlError.SqlError
  >;
  readonly planProfile: (input: {
    readonly profile: string;
    readonly selectedRoles: readonly string[];
    readonly ownedGroups: readonly string[];
  }) => Effect.Effect<PreviewProfileDemandPlan, PreviewAllocationError | SqlError.SqlError>;
  readonly validateProfileAllocation: (input: {
    readonly profile: string;
    readonly selectedRoles: readonly string[];
    readonly ownedGroups: readonly string[];
  }) => Effect.Effect<void, PreviewAllocationError>;
  readonly checkCapacity: (
    demands: readonly CapacityDemand[],
  ) => Effect.Effect<readonly CapacityCheckResult[], PreviewAllocationError | SqlError.SqlError>;
  readonly observeCapacity: (
    measurement: CapacityMeasurement,
  ) => Effect.Effect<void, PreviewAllocationError | SqlError.SqlError>;
  readonly reserveAndAllocate: (input: {
    readonly sessionId: string;
    readonly demands: readonly CapacityDemand[];
    readonly resources: readonly string[];
    readonly resourceMetadata?: Readonly<Record<string, PreviewResourceMetadata>>;
  }) => Effect.Effect<
    Readonly<Record<string, string>>,
    PreviewAllocationError | SqlError.SqlError,
    FileSystem.FileSystem
  >;
  readonly inspect: (
    sessionId: string,
  ) => Effect.Effect<PreviewAllocationStatus, PreviewAllocationError | SqlError.SqlError>;
  readonly cleanup: (input: {
    readonly sessionId: string;
    /** Bounds gateway/provider work before the post-proof deletion phase begins. */
    readonly preDeletionDeadlineAt?: number;
  }) => Effect.Effect<
    "waiting" | "cleaned" | "quarantined",
    PreviewAllocationError | SqlError.SqlError | Error | PlatformError,
    FileSystem.FileSystem
  >;
  readonly cleanupWithDeadline: (input: {
    readonly sessionId: string;
    /** Bounds gateway/provider work before the post-proof deletion phase begins. */
    readonly preDeletionDeadlineAt?: number;
  }) => Effect.Effect<PreviewAllocationCleanupResult, never, FileSystem.FileSystem>;
  readonly markCleanupUnconfirmed: (input: {
    readonly sessionId: string;
    readonly reason:
      | "cleanup-deadline-exceeded"
      | "gateway-cleanup-unconfirmed"
      | "allocation-cleanup-unconfirmed";
  }) => Effect.Effect<void, PreviewAllocationError | SqlError.SqlError>;
  readonly resolveUnknownAllocation: (input: {
    readonly sessionId: string;
    readonly resource: string;
    /** Bounds provider ownership resolution before the deletion phase begins. */
    readonly preDeletionDeadlineAt?: number;
  }) => Effect.Effect<
    "resolved-owned" | "verified-absent",
    PreviewAllocationError | SqlError.SqlError | Error | PlatformError,
    FileSystem.FileSystem
  >;
}

export class PreviewAllocationError extends Schema.TaggedErrorClass<PreviewAllocationError>()(
  "PreviewAllocationError",
  {
    reason: Schema.String,
    dimension: Schema.optionalKey(Schema.String),
    requested: Schema.optionalKey(Schema.Number),
    reserved: Schema.optionalKey(Schema.Number),
    available: Schema.optionalKey(Schema.Number),
  },
) {}

const allocationError = (
  reason: string,
  values: Partial<{
    dimension: string;
    requested: number;
    reserved: number;
    available: number;
  }> = {},
) => new PreviewAllocationError({ reason, ...values });

const allocationFailureDescription = (error: unknown) =>
  error instanceof PreviewAllocationError // oxlint-disable-line no-nested-ternary -- inherited master site
    ? error.reason
    : error instanceof Error
      ? error.message
      : "unknown provider adapter failure";

const withPreviewResourceAdapterTimeout = <A, E, R>(
  operation: string,
  effect: Effect.Effect<A, E, R>,
  timeoutMs: number,
) =>
  effect.pipe(
    Effect.timeoutOption(Duration.millis(timeoutMs)),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(allocationError(`provider-${operation}-timeout`)),
    ),
  );
const hasSafeCapacityIdentityLength = Predicate.and(
  (value: string) => value.length > 0,
  (value: string) => value.length <= 160,
);
const usesAllowedCapacityIdentityCharacters = (value: string) =>
  /^[A-Za-z0-9][A-Za-z0-9:._/@+-]*$/.test(value);
const hasNoCredentialAssignment = (value: string) =>
  !/(?:password|token|secret|api[_-]?key)\s*[:=]/i.test(value);
const hasNoCredentialTokenPrefix = (value: string) =>
  !/^(?:Bearer\s|(?:sk|ghp|gho|xox[baprs])-|eyJ[A-Za-z0-9_-]+\.)/i.test(value);
const isSafeCapacityIdentity = Predicate.and(
  hasSafeCapacityIdentityLength,
  Predicate.and(
    usesAllowedCapacityIdentityCharacters,
    Predicate.and(hasNoCredentialAssignment, hasNoCredentialTokenPrefix),
  ),
);
const isSafeProviderIdentity = Predicate.and(
  (value: { readonly provider: string; readonly identity: string }) =>
    isSafeCapacityIdentity(value.provider),
  (value: { readonly provider: string; readonly identity: string }) =>
    isSafeCapacityIdentity(value.identity),
);

const validateBaselineMeasurements = (measurements: readonly CapacityMeasurement[]) => {
  const seen = new Set<string>();
  for (const measurement of measurements) {
    const key = `${measurement.provider}\u0000${measurement.identity}\u0000${measurement.dimension}`;
    if (seen.has(key)) return allocationError("duplicate-baseline-measurement");
    seen.add(key);
    if (
      !isSafeCapacityIdentity(measurement.provider) ||
      !isSafeCapacityIdentity(measurement.identity)
    )
      return allocationError("unsafe-provider-identity", { dimension: measurement.dimension });
  }
  return undefined;
};

const matchesOwnedGroupDemand = (
  ownedGroups: readonly string[],
  demands: readonly { readonly dimension: string }[],
  resources: readonly string[],
) => {
  const expected = ownedGroups.flatMap(
    (group) =>
      previewCapacityDimensionsByGroup[
        group /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as keyof typeof previewCapacityDimensionsByGroup /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */
      ] ?? [],
  );
  const required = [...new Set(expected)];
  const actual = demands.map(({ dimension }) => dimension);
  const resourcesMatch =
    JSON.stringify([...ownedGroups].sort()) === JSON.stringify([...resources].sort());
  return (
    required.length === actual.length &&
    required.every((dimension) => actual.includes(dimension)) &&
    new Set(actual).size === actual.length &&
    resourcesMatch
  );
};

const hasCompleteProfileDemand = (profile: PreviewCapacityBaseline["profiles"][number]) => {
  const amountsAreMeasured = profile.demands.every(
    ({ amount }) => Number.isFinite(amount) && amount > 0,
  );
  const providersAreExplicit = profile.demands.every(
    ({ provider, identity }) =>
      isSafeCapacityIdentity(provider) && isSafeCapacityIdentity(identity),
  );
  return (
    matchesOwnedGroupDemand(profile.ownedGroups, profile.demands, profile.resources) &&
    amountsAreMeasured &&
    providersAreExplicit
  );
};

const validateBaselineProfiles = (profiles: PreviewCapacityBaseline["profiles"]) => {
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.profile)) return allocationError("duplicate-profile-demand-plan");
    seen.add(profile.profile);
    if (!hasCompleteProfileDemand(profile))
      return allocationError("profile-demand-plan-validation-failed");
  }
  return undefined;
};

const isValidCapacityMeasurement = (measurement: CapacityMeasurement, now: number) =>
  Predicate.and(
    isSafeProviderIdentity,
    Predicate.and(
      (value: CapacityMeasurement) => allPreviewCapacityDimensions.has(value.dimension),
      Predicate.and(
        (value: CapacityMeasurement) =>
          Number.isFinite(value.observedAt) &&
          Number.isFinite(value.total) &&
          Number.isFinite(value.inUse),
        Predicate.and(
          (value: CapacityMeasurement) =>
            value.total >= 0 && value.inUse >= 0 && value.inUse <= value.total,
          (value: CapacityMeasurement) => value.observedAt <= now,
        ),
      ),
    ),
  )(measurement);

const invalidCapacityMeasurement = (measurement: CapacityMeasurement, now: number) =>
  isValidCapacityMeasurement(measurement, now) ? undefined : "invalid-capacity-measurement";

/**
 * Durable measured-capacity reservations and an exact-identity allocation ledger.
 * Provider effects are injected, and unknown measurements never become capacity.
 */
export const makePreviewAllocationController = (
  adapter: PreviewResourceAdapter,
  now: () => number = Date.now,
  config: PreviewAllocationConfig = DEFAULT_PREVIEW_ALLOCATION_CONFIG,
  initializeSchema = true,
  adapterTimeoutMs = DEFAULT_PREVIEW_RESOURCE_ADAPTER_TIMEOUT_MS,
) =>
  Effect.gen(function* () {
    const decodedConfig = yield* Schema.decodeUnknownEffect(PreviewAllocationConfigSchema)(
      config,
    ).pipe(Effect.mapError(() => allocationError("invalid-preview-allocation-config")));
    const maximumMeasurementAgeMs = decodedConfig.maximumMeasurementAgeMs;
    const validatedAdapterTimeoutMs = yield* Schema.decodeUnknownEffect(PositiveMeasurementAge)(
      adapterTimeoutMs,
    ).pipe(Effect.mapError(() => allocationError("invalid-preview-resource-adapter-timeout")));
    const sql = yield* SqlClient.SqlClient;
    if (initializeSchema) {
      yield* sql`CREATE TABLE IF NOT EXISTS preview_capacity_measurements (
      provider TEXT NOT NULL, provider_identity TEXT NOT NULL, dimension TEXT NOT NULL,
      observed_at INTEGER NOT NULL, total REAL NOT NULL, in_use REAL NOT NULL,
      grants_verified INTEGER NOT NULL, PRIMARY KEY(provider, provider_identity, dimension)
    )`;
      yield* sql`CREATE TABLE IF NOT EXISTS preview_profile_demand_plans (
      profile TEXT PRIMARY KEY, selected_roles TEXT NOT NULL, owned_groups TEXT NOT NULL,
      demands TEXT NOT NULL, resources TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`;
      yield* sql`CREATE TABLE IF NOT EXISTS preview_capacity_reservations (
      session_id TEXT NOT NULL, dimension TEXT NOT NULL, amount REAL NOT NULL,
      provider TEXT NOT NULL, provider_identity TEXT NOT NULL, released_at INTEGER,
      PRIMARY KEY(session_id, dimension)
    )`;
      yield* sql`CREATE TABLE IF NOT EXISTS preview_allocation_ledger (
      session_id TEXT NOT NULL, resource TEXT NOT NULL, owner_token TEXT NOT NULL,
      provider_resource_id TEXT, state TEXT NOT NULL CHECK(state IN ('allocating','owned','deleting','quarantined','deleted','not-allocated')),
      updated_at INTEGER NOT NULL, failure TEXT,
      PRIMARY KEY(session_id, resource)
    )`;
      yield* sql`CREATE TABLE IF NOT EXISTS preview_cleanup_state (
      session_id TEXT PRIMARY KEY, ended_at INTEGER NOT NULL, proof_at INTEGER,
      quarantine_reason TEXT, completed_at INTEGER
    )`;
      yield* sql`CREATE TABLE IF NOT EXISTS preview_cleanup_proof_fences (
      session_id TEXT PRIMARY KEY, generation INTEGER NOT NULL
    )`;
      // NULL until proof is current and stable; then this anchors one absolute
      // post-proof deletion attempt, including in-progress retries.
      yield* sql`CREATE TABLE IF NOT EXISTS preview_cleanup_timing (
      session_id TEXT PRIMARY KEY REFERENCES preview_cleanup_state(session_id),
      settlement_started_at INTEGER NOT NULL, deletion_started_at INTEGER
    )`;
      yield* sql`CREATE TABLE IF NOT EXISTS preview_allocation_resolutions (
      session_id TEXT NOT NULL, resource TEXT NOT NULL, owner_token TEXT NOT NULL,
      provider TEXT NOT NULL, provider_identity TEXT NOT NULL, verified_at INTEGER NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('found','absent')), provider_resource_id TEXT,
      PRIMARY KEY(session_id, resource)
    )`;
    }

    const validateAllocationRequest = (input: {
      readonly demands: readonly CapacityDemand[];
      readonly resources: readonly string[];
    }) => {
      if (new Set(input.demands.map(({ dimension }) => dimension)).size !== input.demands.length)
        return allocationError("duplicate-capacity-demand");
      if (new Set(input.resources).size !== input.resources.length)
        return allocationError("duplicate-resource-demand");
      return input.demands.length === 0 || input.resources.length === 0
        ? allocationError("empty-profile-demand")
        : undefined;
    };

    const ensureCleanupProofFence = (sessionId: string) =>
      sql`INSERT INTO preview_cleanup_proof_fences(session_id, generation) VALUES (${sessionId}, 0) ON CONFLICT(session_id) DO NOTHING`;

    const cleanupProofIsCurrent = (sessionId: string, proof: CleanupProofToken) =>
      Effect.map(
        sql`SELECT 1 FROM preview_cleanup_state AS cleanup
          JOIN preview_cleanup_proof_fences AS fence ON fence.session_id=cleanup.session_id
          WHERE cleanup.session_id=${sessionId}
            AND cleanup.proof_at=${proof.proofAt}
            AND fence.generation=${proof.generation}
            AND cleanup.proof_at + ${previewCleanupProofStabilityMs} <= ${now()}`,
        (rows) => rows.length > 0,
      );

    const readVerifiedCapacity = (demand: CapacityDemand) =>
      Effect.gen(function* () {
        if (!(demand.amount > 0) || !Number.isFinite(demand.amount))
          return yield* Effect.fail(
            allocationError("invalid-capacity-demand", { dimension: demand.dimension }),
          );
        const rows =
          yield* sql`SELECT * FROM preview_capacity_measurements WHERE dimension=${demand.dimension} AND provider=${demand.provider} AND provider_identity=${demand.identity}`;
        const row = rows[0] as Record<string, unknown> | undefined;
        if (row === undefined) {
          const alternatives =
            yield* sql`SELECT provider FROM preview_capacity_measurements WHERE dimension=${demand.dimension}`;
          return yield* Effect.fail(
            allocationError(
              alternatives.length > 0
                ? "capacity-provider-identity-mismatch"
                : "capacity-or-grants-unobserved",
              { dimension: demand.dimension },
            ),
          );
        }
        if (Number(row.grants_verified) !== 1)
          return yield* Effect.fail(
            allocationError("capacity-or-grants-unobserved", { dimension: demand.dimension }),
          );
        if (now() - Number(row.observed_at) > maximumMeasurementAgeMs)
          return yield* Effect.fail(
            allocationError("capacity-measurement-stale", { dimension: demand.dimension }),
          );
        return row;
      });

    const reserveDemandCapacity = (demand: CapacityDemand, row: Record<string, unknown>) =>
      Effect.gen(function* () {
        const reservations =
          yield* sql`SELECT COALESCE(SUM(amount), 0) AS amount FROM preview_capacity_reservations WHERE dimension=${demand.dimension} AND provider=${demand.provider} AND provider_identity=${demand.identity} AND released_at IS NULL`;
        const reserved = Number(
          (reservations[0] as Record<string, unknown> | undefined)?.amount ?? 0,
        );
        const available = Number(row.total) - Number(row.in_use) - reserved;
        if (available < demand.amount)
          return yield* Effect.fail(
            allocationError("capacity-exhausted", {
              dimension: demand.dimension,
              requested: demand.amount,
              reserved,
              available: Math.max(0, available),
            }),
          );
        return { provider: String(row.provider), identity: String(row.provider_identity) };
      });

    const checkDemandCapacity = (demand: CapacityDemand) =>
      Effect.flatMap(readVerifiedCapacity(demand), (row) => reserveDemandCapacity(demand, row));

    const reserveCapacityAndLedger = (input: {
      readonly sessionId: string;
      readonly demands: readonly CapacityDemand[];
      readonly resources: readonly string[];
    }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const measurements = yield* Effect.forEach(input.demands, checkDemandCapacity);
          for (const [index, demand] of input.demands.entries()) {
            const measurement = measurements[index]!;
            yield* sql`INSERT INTO preview_capacity_reservations (session_id, dimension, amount, provider, provider_identity)
          VALUES (${input.sessionId}, ${demand.dimension}, ${demand.amount}, ${measurement.provider}, ${measurement.identity})`;
          }
          for (const resource of input.resources) {
            const ownerToken = randomUUID();
            yield* sql`INSERT INTO preview_allocation_ledger (session_id, resource, owner_token, state, updated_at)
          VALUES (${input.sessionId}, ${resource}, ${ownerToken}, 'allocating', ${now()})`;
          }
          const rows =
            yield* sql`SELECT resource, owner_token FROM preview_allocation_ledger WHERE session_id=${input.sessionId} ORDER BY rowid`;
          return yield* Schema.decodeUnknownEffect(Schema.Array(PreviewAllocationOwnerRowSchema))(
            rows,
          ).pipe(Effect.mapError(() => allocationError("allocation-owner-ledger-invalid")));
        }),
      );

    const allocateOneResource = (
      sessionId: string,
      value: PreviewAllocationOwnerRow,
      resourceMetadata: Readonly<Record<string, PreviewResourceMetadata>> | undefined,
      priorResources: Readonly<Record<string, string>>,
    ) =>
      Effect.gen(function* () {
        const resource = String(value.resource);
        const ownerToken = String(value.owner_token);
        const result = yield* Effect.result(
          withPreviewResourceAdapterTimeout(
            "resource-allocation",
            adapter.allocate({
              sessionId,
              ownerToken,
              resource,
              ...(resourceMetadata?.[resource] === undefined
                ? {}
                : { metadata: resourceMetadata[resource] }),
              priorResources,
            }),
            validatedAdapterTimeoutMs,
          ),
        );
        if (Result.isFailure(result)) {
          yield* sql`UPDATE preview_allocation_ledger SET state='quarantined', failure='allocation-failed', updated_at=${now()} WHERE session_id=${sessionId} AND resource=${resource} AND owner_token=${ownerToken} AND state='allocating'`;
          return yield* Effect.fail(allocationError("partial-allocation-quarantined"));
        }
        if (result.success.trim() === "") {
          yield* sql`UPDATE preview_allocation_ledger SET state='quarantined', failure='provider-resource-id-missing', updated_at=${now()} WHERE session_id=${sessionId} AND resource=${resource} AND owner_token=${ownerToken} AND state='allocating'`;
          return yield* Effect.fail(allocationError("provider-resource-id-missing"));
        }
        const updated =
          yield* sql`UPDATE preview_allocation_ledger SET provider_resource_id=${result.success}, state='owned', updated_at=${now()} WHERE session_id=${sessionId} AND resource=${resource} AND owner_token=${ownerToken} AND state='allocating' RETURNING resource`;
        if (updated.length === 0)
          return yield* Effect.fail(allocationError("allocation-ledger-write-failed"));
        return [resource, result.success] as const;
      });

    const allocateRecordedResources = (
      sessionId: string,
      rows: ReadonlyArray<PreviewAllocationOwnerRow>,
      resourceMetadata: Readonly<Record<string, PreviewResourceMetadata>> | undefined,
    ) =>
      Effect.gen(function* () {
        const allocated: (readonly [string, string])[] = [];
        for (const [index, row] of rows.entries()) {
          const priorResources = Object.fromEntries(allocated);
          const result = yield* Effect.result(
            allocateOneResource(sessionId, row, resourceMetadata, priorResources),
          );
          if (result._tag === "Failure") {
            for (const skipped of rows.slice(index + 1)) {
              const resource = String(skipped.resource);
              yield* sql`UPDATE preview_allocation_ledger SET state='not-allocated', failure='allocation-not-attempted', updated_at=${now()} WHERE session_id=${sessionId} AND resource=${resource} AND state='allocating'`;
            }
            return yield* Effect.fail(result.failure);
          }
          allocated.push(result.success);
        }
        return Object.fromEntries(allocated);
      });

    const readRequiredSession = (sessionId: string) =>
      Effect.gen(function* () {
        const sessions =
          yield* sql`SELECT ended_at, unsettled, resource_ids FROM preview_sessions WHERE id=${sessionId}`;
        const session = sessions[0] as Record<string, unknown> | undefined;
        if (session === undefined) return yield* Effect.fail(allocationError("unknown-session"));
        return session;
      });

    const loadCleanupSession = (sessionId: string) =>
      Effect.gen(function* () {
        const session = yield* readRequiredSession(sessionId);
        if (session.ended_at === null)
          return yield* Effect.fail(allocationError("live-session-destruction-refused"));
        const cleanups =
          yield* sql`SELECT completed_at FROM preview_cleanup_state WHERE session_id=${sessionId}`;
        const cleanupRows = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(Schema.Array(PreviewCleanupCompletionRowSchema))(cleanups),
          catch: () => allocationError("allocation-cleanup-ledger-invalid"),
        });

        if (cleanupRows[0] !== undefined && cleanupRows[0].completed_at !== null)
          return "cleaned" as const;
        const endedAt = Number(session.ended_at);
        if (cleanups.length === 0)
          yield* sql`INSERT INTO preview_cleanup_state(session_id, ended_at, proof_at) VALUES (${sessionId}, ${endedAt}, NULL) ON CONFLICT(session_id) DO NOTHING`;
        yield* sql`INSERT INTO preview_cleanup_timing(session_id, settlement_started_at) VALUES (${sessionId}, ${endedAt}) ON CONFLICT(session_id) DO NOTHING`;
        yield* ensureCleanupProofFence(sessionId);
        if (Number(session.unsettled) !== 0) {
          if (now() < endedAt + previewAcceptedWorkDrainMs + previewSettlementRecoveryMs)
            return "waiting" as const;
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='accepted-work-settlement-unproven' WHERE session_id=${sessionId} AND completed_at IS NULL`;
          return "quarantined" as const;
        }
        yield* sql`UPDATE preview_cleanup_state SET quarantine_reason=NULL WHERE session_id=${sessionId} AND quarantine_reason='accepted-work-settlement-unproven' AND completed_at IS NULL`;
        return { session } as const;
      });

    const loadKnownCleanupLedger = (sessionId: string, session: Record<string, unknown>) =>
      Effect.gen(function* () {
        yield* ensureCleanupProofFence(sessionId);
        const authorizationRows = yield* sql`SELECT fence.generation AS proof_generation,
            cleanup.proof_at AS proof_at,
            timing.deletion_started_at AS deletion_started_at,
            allocation.resource AS resource,
            allocation.owner_token AS owner_token,
            allocation.provider_resource_id AS provider_resource_id,
            allocation.state AS state,
            allocation.updated_at AS updated_at,
            allocation.failure AS failure
          FROM preview_cleanup_proof_fences AS fence
          LEFT JOIN preview_cleanup_state AS cleanup ON cleanup.session_id=fence.session_id
          LEFT JOIN preview_cleanup_timing AS timing ON timing.session_id=fence.session_id
          LEFT JOIN preview_allocation_ledger AS allocation
            ON allocation.session_id=fence.session_id
              AND allocation.state IN ('allocating','owned','quarantined','deleting')
          WHERE fence.session_id=${sessionId}
          ORDER BY allocation.rowid DESC`;
        const authorizationRowsResult = yield* Effect.result(
          Schema.decodeUnknownEffect(Schema.Array(PreviewCleanupAuthorizationRowSchema))(
            authorizationRows,
          ).pipe(Effect.mapError(() => allocationError("cleanup-proof-fence-invalid"))),
        );
        if (Result.isFailure(authorizationRowsResult)) {
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-ownership-ledger' WHERE session_id=${sessionId}`;
          return undefined;
        }
        const authorization = authorizationRowsResult.success;
        const { proofGeneration, proofAt, deletionStartedAt } =
          firstCleanupAuthorization(authorization);
        if (
          proofGeneration === undefined ||
          authorization.some((row) => row.proof_generation !== proofGeneration)
        ) {
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-ownership-ledger' WHERE session_id=${sessionId}`;
          return undefined;
        }
        const ledger = authorization.flatMap((row) =>
          row.resource === null
            ? []
            : [
                {
                  resource: row.resource,
                  owner_token: row.owner_token,
                  provider_resource_id: row.provider_resource_id,
                  state: row.state,
                  updated_at: row.updated_at,
                  failure: row.failure,
                },
              ],
        );
        const allRows =
          yield* sql`SELECT resource FROM preview_allocation_ledger WHERE session_id=${sessionId}`;
        const recordedResourcesResult = yield* Effect.result(
          Effect.try({
            try: () =>
              Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                JSON.parse(String(session.resource_ids)),
              ),
            catch: () => allocationError("unknown-ownership-ledger"),
          }),
        );
        if (Result.isFailure(recordedResourcesResult)) {
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-ownership-ledger' WHERE session_id=${sessionId}`;
          return undefined;
        }
        const ledgerResult = yield* Effect.result(
          Schema.decodeUnknownEffect(Schema.Array(PreviewAllocationCleanupRowSchema))(ledger).pipe(
            Effect.mapError(() => allocationError("allocation-ownership-ledger-invalid")),
          ),
        );
        if (Result.isFailure(ledgerResult)) {
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-ownership-ledger' WHERE session_id=${sessionId}`;
          return undefined;
        }
        const resourceRowsResult = yield* Effect.result(
          Schema.decodeUnknownEffect(Schema.Array(PreviewResourceRowSchema))(allRows).pipe(
            Effect.mapError(() => allocationError("unknown-ownership-ledger")),
          ),
        );
        if (Result.isFailure(resourceRowsResult)) {
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-ownership-ledger' WHERE session_id=${sessionId}`;
          return undefined;
        }
        const ledgerResources = new Set(resourceRowsResult.success.map((row) => row.resource));
        const recordedResources = recordedResourcesResult.success;
        if (Object.keys(recordedResources).some((resource) => !ledgerResources.has(resource))) {
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-ownership-ledger' WHERE session_id=${sessionId}`;
          return undefined;
        }

        return { ledger: ledgerResult.success, proofGeneration, proofAt, deletionStartedAt };
      });

    const verifyCleanupProof = (
      sessionId: string,
      ledger: readonly Record<string, unknown>[],
      proofGeneration: number,
    ): Effect.Effect<
      CleanupProofValidation,
      SqlError.SqlError | Error | PlatformError,
      FileSystem.FileSystem
    > =>
      Effect.gen(function* () {
        const proof = yield* Effect.result(
          withPreviewResourceAdapterTimeout(
            "cleanup-proof",
            adapter.proveCleanup({
              sessionId,
              resources: ledger.map((entry) => ({
                resource: String(entry.resource),
                providerResourceId:
                  typeof entry.provider_resource_id === "string"
                    ? entry.provider_resource_id
                    : null,
                ownerToken: String(entry.owner_token),
              })),
            }),
            validatedAdapterTimeoutMs,
          ),
        );
        if (proof._tag === "Failure" || !proof.success) {
          const invalidated = yield* sql.withTransaction(
            Effect.gen(function* () {
              const invalidated = yield* sql`UPDATE preview_cleanup_proof_fences
                  SET generation=generation+1
                  WHERE session_id=${sessionId} AND generation=${proofGeneration}
                  RETURNING generation`;
              if (invalidated.length === 0) return false;
              yield* sql`UPDATE preview_cleanup_state SET proof_at=NULL WHERE session_id=${sessionId}`;
              return true;
            }),
          );
          return invalidated
            ? ({ _tag: "ConfirmedInvalidation" } as const)
            : ({ _tag: "Uncertain" } as const);
        }
        const proofCompletedAt = now();
        const rows = yield* sql`UPDATE preview_cleanup_state
            SET proof_at=COALESCE(proof_at, ${proofCompletedAt})
            WHERE session_id=${sessionId}
              AND EXISTS (
                SELECT 1 FROM preview_cleanup_proof_fences AS fence
                WHERE fence.session_id=${sessionId} AND fence.generation=${proofGeneration}
              )
            RETURNING proof_at`;
        const proofRows = yield* Schema.decodeUnknownEffect(
          Schema.Array(PreviewCleanupProofAtRowSchema),
        )(rows).pipe(Effect.mapError(() => allocationError("cleanup-proof-state-invalid")));
        const proofAt = proofRows[0]?.proof_at;
        if (proofAt === undefined || proofAt === null) return { _tag: "Uncertain" } as const;
        return now() >= proofAt + previewCleanupProofStabilityMs
          ? ({ _tag: "Verified", proof: { proofAt, generation: proofGeneration } } as const)
          : ({ _tag: "Pending" } as const);
      });

    const readDeletionClaimOutcome = (sessionId: string, resource: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT state FROM preview_allocation_ledger WHERE session_id=${sessionId} AND resource=${resource}`;
        const stateRows = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Schema.Array(PreviewAllocationStateRowSchema))(rows),
          catch: () => allocationError("allocation-ownership-ledger-invalid"),
        });
        const state = stateRows[0]?.state;
        if (state === "deleted" || state === "not-allocated") return "deleted" as const;
        return state === "deleting" ? ("waiting" as const) : ("quarantined" as const);
      });

    const quarantineUnknownCleanupResource = (
      sessionId: string,
      resource: string,
      proof: CleanupProofToken,
    ) =>
      Effect.gen(function* () {
        const time = now();
        const quarantined = yield* sql.withTransaction(
          Effect.gen(function* () {
            const updated = yield* sql`UPDATE preview_allocation_ledger
              SET state='quarantined', failure='unknown-owner-or-resource', updated_at=${time}
              WHERE session_id=${sessionId} AND resource=${resource}
                AND (provider_resource_id IS NULL OR provider_resource_id='')
                AND state IN ('allocating','owned','quarantined','deleting')
                AND EXISTS (
                  SELECT 1 FROM preview_cleanup_state AS cleanup
                  JOIN preview_cleanup_proof_fences AS fence ON fence.session_id=cleanup.session_id
                  WHERE cleanup.session_id=${sessionId}
                    AND cleanup.completed_at IS NULL
                    AND cleanup.proof_at=${proof.proofAt}
                    AND fence.generation=${proof.generation}
                )
              RETURNING resource`;
            if (updated.length === 0) return false;
            yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-owner-or-resource'
              WHERE session_id=${sessionId} AND completed_at IS NULL
                AND proof_at=${proof.proofAt}
                AND EXISTS (
                  SELECT 1 FROM preview_cleanup_proof_fences AS fence
                  WHERE fence.session_id=${sessionId} AND fence.generation=${proof.generation}
                )
                AND EXISTS (
                  SELECT 1 FROM preview_allocation_ledger
                  WHERE session_id=${sessionId}
                    AND (provider_resource_id IS NULL OR provider_resource_id='')
                    AND state IN ('allocating','owned','quarantined','deleting')
                )`;
            return true;
          }),
        );
        if (quarantined) return "quarantined" as const;
        if (!(yield* cleanupProofIsCurrent(sessionId, proof))) return "waiting" as const;
        return yield* readDeletionClaimOutcome(sessionId, resource);
      });

    const deleteCleanupResource = (
      sessionId: string,
      entry: Record<string, unknown>,
      timeoutMs: number,
      proof: CleanupProofToken,
    ) =>
      Effect.gen(function* () {
        const resource = String(entry.resource);
        const ownerToken = String(entry.owner_token);
        const providerResourceId = entry.provider_resource_id;
        if (typeof providerResourceId !== "string" || providerResourceId === "")
          return yield* quarantineUnknownCleanupResource(sessionId, resource, proof);
        const claimTime = now();
        const claimed =
          yield* sql`UPDATE preview_allocation_ledger SET state='deleting', failure=NULL, updated_at=${claimTime} WHERE session_id=${sessionId} AND resource=${resource} AND owner_token=${ownerToken} AND provider_resource_id=${providerResourceId} AND (state IN ('owned','quarantined') OR (state='deleting' AND updated_at <= ${claimTime - validatedAdapterTimeoutMs})) AND EXISTS (
            SELECT 1 FROM preview_cleanup_state AS cleanup
            JOIN preview_cleanup_proof_fences AS fence ON fence.session_id=cleanup.session_id
            WHERE cleanup.session_id=${sessionId}
              AND cleanup.proof_at=${proof.proofAt}
              AND fence.generation=${proof.generation}
              AND cleanup.proof_at + ${previewCleanupProofStabilityMs} <= ${claimTime}
          ) RETURNING resource`;
        if (claimed.length === 0) {
          if (!(yield* cleanupProofIsCurrent(sessionId, proof))) return "waiting" as const;
          return yield* readDeletionClaimOutcome(sessionId, resource);
        }
        const removed = yield* Effect.result(
          withPreviewResourceAdapterTimeout(
            "resource-deletion",
            adapter.deleteOwned({ sessionId, providerResourceId, ownerToken, resource }),
            timeoutMs,
          ),
        );
        if (removed._tag === "Failure") {
          const failureKind = removed.failure instanceof Error ? removed.failure.name : "unknown";
          const quarantined =
            yield* sql`UPDATE preview_allocation_ledger SET state='quarantined', failure=${`deletion-failed:${failureKind}`}, updated_at=${now()} WHERE session_id=${sessionId} AND resource=${resource} AND owner_token=${ownerToken} AND provider_resource_id=${providerResourceId} AND state='deleting' AND updated_at=${claimTime} RETURNING resource`;
          if (quarantined.length === 0) return yield* readDeletionClaimOutcome(sessionId, resource);
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='deletion-failed' WHERE session_id=${sessionId}`;
          return "quarantined" as const;
        }
        const deleted =
          yield* sql`UPDATE preview_allocation_ledger SET state='deleted', failure=NULL, updated_at=${now()} WHERE session_id=${sessionId} AND resource=${resource} AND owner_token=${ownerToken} AND provider_resource_id=${providerResourceId} AND state='deleting' AND updated_at=${claimTime} RETURNING resource`;
        return deleted.length > 0
          ? ("deleted" as const)
          : yield* readDeletionClaimOutcome(sessionId, resource);
      });

    /**
     * This timestamp starts only after adapter proof is current and stable. It anchors one
     * absolute deletion attempt across in-progress retries. A persisted legacy timestamp that
     * predates stable proof is rebased only after proof is current and no fresh deletion claim
     * remains. A new explicit cleanup invocation can start a new attempt only after proof is
     * revalidated and prior deletion claims settle.
     */
    const persistCleanupDeletionAttemptStart = (
      sessionId: string,
      time: number,
      proof: CleanupProofToken,
      attemptStarted: boolean,
    ) => {
      const attemptStartedFlag = Number(attemptStarted);
      return sql`UPDATE preview_cleanup_timing
        SET deletion_started_at = CASE
          WHEN deletion_started_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM preview_allocation_ledger AS claim
              WHERE claim.session_id=${sessionId}
                AND claim.state='deleting'
                AND claim.updated_at > ${time - validatedAdapterTimeoutMs}
            ) THEN ${time}
          WHEN ${attemptStartedFlag} = 0
            AND NOT EXISTS (
              SELECT 1 FROM preview_allocation_ledger AS claim
              WHERE claim.session_id=${sessionId}
                AND claim.state='deleting'
                AND claim.updated_at > ${time - validatedAdapterTimeoutMs}
            )
            AND (
              deletion_started_at + ${previewOwnedResourceDeletionMs} <= ${time}
              OR deletion_started_at < (
                SELECT proof_at + ${previewCleanupProofStabilityMs}
                FROM preview_cleanup_state
                WHERE session_id=${sessionId}
              )
            ) THEN ${time}
          ELSE deletion_started_at
        END
        WHERE session_id=${sessionId}
          AND EXISTS (
            SELECT 1 FROM preview_cleanup_state AS cleanup
            JOIN preview_cleanup_proof_fences AS fence ON fence.session_id=cleanup.session_id
            WHERE cleanup.session_id=${sessionId}
              AND cleanup.proof_at=${proof.proofAt}
              AND fence.generation=${proof.generation}
              AND cleanup.proof_at + ${previewCleanupProofStabilityMs} <= ${time}
          )
        RETURNING deletion_started_at`;
    };

    const missingCleanupDeletionAttempt = (
      sessionId: string,
      proof: CleanupProofToken,
      reportWindow: PreviewAllocationCleanupReportWindow,
    ) =>
      Effect.gen(function* () {
        const preservedDeadline =
          reportWindow.state === "known" ? reportWindow.deletionDeadlineAt : null;
        if (!(yield* cleanupProofIsCurrent(sessionId, proof))) {
          if (preservedDeadline === null) {
            reportWindow.state = "invalidated";
            reportWindow.deletionDeadlineAt = null;
          }
          return { remainingMs: null, deletionDeadlineAt: preservedDeadline } as const;
        }
        if (preservedDeadline === null) {
          reportWindow.state = "unknown";
          reportWindow.deletionDeadlineAt = null;
        }
        yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='cleanup-timing-missing' WHERE session_id=${sessionId}`;
        return { remainingMs: null, deletionDeadlineAt: preservedDeadline } as const;
      });

    const recordCleanupReportWindow = (
      reportWindow: PreviewAllocationCleanupReportWindow,
      startedAt: number,
      proofStableAt: number,
    ) => {
      if (startedAt >= proofStableAt) {
        reportWindow.state = "known";
        reportWindow.deletionDeadlineAt = startedAt + previewOwnedResourceDeletionMs;
      } else {
        reportWindow.state = "absent";
        reportWindow.deletionDeadlineAt = null;
      }
    };

    const remainingDeletionPhase = (
      sessionId: string,
      attempt: { started: boolean },
      proof: CleanupProofToken,
      reportWindow: PreviewAllocationCleanupReportWindow,
    ) =>
      Effect.gen(function* () {
        const time = now();
        const proofStableAt = proof.proofAt + previewCleanupProofStabilityMs;
        const rows = yield* persistCleanupDeletionAttemptStart(
          sessionId,
          time,
          proof,
          attempt.started,
        );
        const timerRows = yield* Schema.decodeUnknownEffect(
          Schema.Array(PreviewDeletionAttemptStartRowSchema),
        )(rows).pipe(Effect.mapError(() => allocationError("cleanup-timing-ledger-invalid")));
        const startedAt = timerRows[0]?.deletion_started_at ?? undefined;
        if (startedAt === undefined)
          return yield* missingCleanupDeletionAttempt(sessionId, proof, reportWindow);
        if (startedAt === time)
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason=NULL WHERE session_id=${sessionId} AND completed_at IS NULL AND quarantine_reason IN ('deletion-failed','owned-resource-deletion-deadline-exceeded')`;
        attempt.started = true;
        const deletionDeadlineAt = startedAt + previewOwnedResourceDeletionMs;
        recordCleanupReportWindow(reportWindow, startedAt, proofStableAt);
        const remainingMs = deletionDeadlineAt - now();
        if (remainingMs > 0) return { remainingMs, deletionDeadlineAt } as const;
        yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='owned-resource-deletion-deadline-exceeded' WHERE session_id=${sessionId}`;
        return { remainingMs: null, deletionDeadlineAt } as const;
      });

    const remainingDeletionWorkWindow = (
      sessionId: string,
      attempt: { started: boolean },
      proof: CleanupProofToken,
      reportWindow: PreviewAllocationCleanupReportWindow,
    ) =>
      Effect.gen(function* () {
        const phase = yield* remainingDeletionPhase(sessionId, attempt, proof, reportWindow);
        if (phase.remainingMs === null || phase.deletionDeadlineAt === null)
          return {
            _tag: "Outcome",
            outcome: (yield* cleanupProofIsCurrent(sessionId, proof))
              ? ("quarantined" as const)
              : ("waiting" as const),
            deletionDeadlineAt: phase.deletionDeadlineAt,
          } as const;
        const budgetMs = Math.floor(phase.remainingMs - previewCleanupReportingBudgetMs);
        if (budgetMs <= 0)
          return {
            _tag: "Outcome",
            outcome: "quarantined" as const,
            deletionDeadlineAt: phase.deletionDeadlineAt,
          } as const;
        return { _tag: "Budget", budgetMs, deletionDeadlineAt: phase.deletionDeadlineAt } as const;
      });

    const deleteCleanupLedger = (
      sessionId: string,
      ledger: readonly Record<string, unknown>[],
      attempt: { started: boolean },
      proof: CleanupProofToken,
      reportWindow: PreviewAllocationCleanupReportWindow,
    ) =>
      Effect.gen(function* () {
        for (const entry of ledger) {
          const workWindow = yield* remainingDeletionWorkWindow(
            sessionId,
            attempt,
            proof,
            reportWindow,
          );
          if (workWindow._tag === "Outcome") return workWindow.outcome;
          const result = yield* deleteCleanupResource(
            sessionId,
            entry,
            Math.min(validatedAdapterTimeoutMs, workWindow.budgetMs),
            proof,
          );
          if (result !== "deleted") return result;
        }
        return "deleted" as const;
      });

    const markUnknownRowsQuarantined = (
      sessionId: string,
      entries: readonly Record<string, unknown>[],
      time: number,
    ) =>
      Effect.gen(function* () {
        for (const entry of entries) {
          const resource = String(entry.resource);
          yield* sql`UPDATE preview_allocation_ledger SET state='quarantined', failure='unknown-owner-or-resource', updated_at=${time} WHERE session_id=${sessionId} AND resource=${resource} AND (provider_resource_id IS NULL OR provider_resource_id='') AND state IN ('allocating','owned','quarantined','deleting')`;
        }
        if (entries.length > 0)
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-owner-or-resource'
            WHERE session_id=${sessionId} AND completed_at IS NULL AND EXISTS (
              SELECT 1 FROM preview_allocation_ledger
              WHERE session_id=${sessionId}
                AND (provider_resource_id IS NULL OR provider_resource_id='')
                AND state IN ('allocating','owned','quarantined','deleting')
            )`;
      });

    const hasUnresolvedAllocations = (sessionId: string) =>
      Effect.map(
        sql`SELECT resource FROM preview_allocation_ledger WHERE session_id=${sessionId} AND state NOT IN ('deleted','not-allocated')`,
        (rows) => rows.length > 0,
      );

    const readUnknownAllocationTarget = (sessionId: string, resource: string) =>
      Effect.gen(function* () {
        const session = yield* readRequiredSession(sessionId);
        if (session.ended_at === null || Number(session.unsettled) !== 0)
          return yield* Effect.fail(allocationError("resolution-requires-ended-settled-session"));
        const rows =
          yield* sql`SELECT owner_token, provider_resource_id, state FROM preview_allocation_ledger WHERE session_id=${sessionId} AND resource=${resource}`;
        const allocation = rows[0] as Record<string, unknown> | undefined;
        if (
          allocation === undefined ||
          (allocation.state !== "quarantined" && allocation.state !== "allocating") ||
          allocation.provider_resource_id !== null
        )
          return yield* Effect.fail(allocationError("allocation-is-not-unknown"));
        return String(allocation.owner_token);
      });

    const readProviderIdentities = (sessionId: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT DISTINCT provider, provider_identity FROM preview_capacity_reservations WHERE session_id=${sessionId}`;
        const identities = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(Schema.Array(PreviewProviderIdentityRowSchema))(rows),
          catch: () => allocationError("provider-resolution-identity-invalid"),
        });
        if (identities.length === 0)
          return yield* Effect.fail(allocationError("provider-resolution-identity-unreserved"));
        return identities.map(({ provider, provider_identity }) => ({
          provider,
          identity: provider_identity,
        }));
      });

    const hasResolutionOwnerMatch = (
      evidence: VerifiedAllocationResolution,
      input: { readonly sessionId: string; readonly resource: string },
      ownerToken: string,
    ) =>
      evidence.sessionId === input.sessionId &&
      evidence.resource === input.resource &&
      evidence.ownerToken === ownerToken &&
      isSafeCapacityIdentity(evidence.provider) &&
      isSafeCapacityIdentity(evidence.identity);

    const hasFreshResolutionTimestamp = (evidence: VerifiedAllocationResolution) => {
      const observedAt = now();
      return (
        Number.isFinite(evidence.verifiedAt) &&
        evidence.verifiedAt <= observedAt &&
        observedAt - evidence.verifiedAt <= maximumMeasurementAgeMs
      );
    };

    const matchesReservedProviderIdentity = (
      evidence: VerifiedAllocationResolution,
      providerIdentities: readonly { readonly provider: string; readonly identity: string }[],
    ) =>
      providerIdentities.some(
        (identity) =>
          identity.provider === evidence.provider && identity.identity === evidence.identity,
      );

    const hasResolvedResourceId = (evidence: VerifiedAllocationResolution) =>
      evidence.result.status === "absent" || evidence.result.providerResourceId.trim() !== "";

    const verifyResolutionEvidence = (
      input: { readonly sessionId: string; readonly resource: string },
      ownerToken: string,
      providerIdentities: readonly { readonly provider: string; readonly identity: string }[],
      timeoutMs: number,
    ) =>
      Effect.gen(function* () {
        if (adapter.resolveUnknown === undefined)
          return yield* Effect.fail(allocationError("provider-resolution-unavailable"));
        const response = yield* Effect.result(
          withPreviewResourceAdapterTimeout(
            "ownership-resolution",
            adapter.resolveUnknown({
              sessionId: input.sessionId,
              resource: input.resource,
              ownerToken,
              providerIdentities,
            }),
            timeoutMs,
          ),
        );
        if (response._tag === "Failure")
          return yield* Effect.fail(allocationError("provider-resolution-failed"));
        const decoded = yield* Effect.result(
          Schema.decodeUnknownEffect(VerifiedAllocationResolutionSchema)(response.success),
        );
        if (decoded._tag === "Failure")
          return yield* Effect.fail(allocationError("provider-resolution-evidence-invalid"));
        const evidence = decoded.success;
        if (
          !hasResolutionOwnerMatch(evidence, input, ownerToken) ||
          !hasFreshResolutionTimestamp(evidence)
        )
          return yield* Effect.fail(
            allocationError("provider-resolution-evidence-mismatch-or-stale"),
          );
        if (!evidence.allocationSettled)
          return yield* Effect.fail(allocationError("provider-allocation-not-settled"));
        if (!matchesReservedProviderIdentity(evidence, providerIdentities))
          return yield* Effect.fail(allocationError("provider-resolution-identity-unreserved"));
        if (!hasResolvedResourceId(evidence))
          return yield* Effect.fail(allocationError("provider-resolution-resource-id-missing"));
        return evidence;
      });

    const persistResolutionEvidence = (
      input: { readonly sessionId: string; readonly resource: string },
      ownerToken: string,
      evidence: VerifiedAllocationResolution,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* ensureCleanupProofFence(input.sessionId);
          const resolution = Match.value(evidence.result).pipe(
            Match.when({ status: "found" }, (found) => ({
              outcome: "found" as const,
              providerResourceId: found.providerResourceId,
            })),
            Match.when({ status: "absent" }, () => ({
              outcome: "absent" as const,
              providerResourceId: null,
            })),
            Match.exhaustive,
          );
          yield* sql`INSERT INTO preview_allocation_resolutions
            (session_id, resource, owner_token, provider, provider_identity, verified_at, outcome, provider_resource_id)
            VALUES (${input.sessionId}, ${input.resource}, ${ownerToken}, ${evidence.provider}, ${evidence.identity}, ${evidence.verifiedAt}, ${resolution.outcome}, ${resolution.providerResourceId})
            ON CONFLICT(session_id, resource) DO UPDATE SET owner_token=excluded.owner_token, provider=excluded.provider, provider_identity=excluded.provider_identity, verified_at=excluded.verified_at, outcome=excluded.outcome, provider_resource_id=excluded.provider_resource_id`;
          const updated = yield* Match.value(evidence.result).pipe(
            Match.when(
              { status: "found" },
              ({ providerResourceId }) =>
                sql`UPDATE preview_allocation_ledger SET provider_resource_id=${providerResourceId}, state='owned', failure=NULL, updated_at=${now()} WHERE session_id=${input.sessionId} AND resource=${input.resource} AND owner_token=${ownerToken} AND provider_resource_id IS NULL RETURNING resource`,
            ),
            Match.when(
              { status: "absent" },
              () =>
                sql`UPDATE preview_allocation_ledger SET state='deleted', failure='provider-verified-absent', updated_at=${now()} WHERE session_id=${input.sessionId} AND resource=${input.resource} AND owner_token=${ownerToken} AND provider_resource_id IS NULL RETURNING resource`,
            ),
            Match.exhaustive,
          );
          if (updated.length === 0)
            return yield* Effect.fail(allocationError("allocation-resolution-raced"));
          yield* sql`UPDATE preview_cleanup_proof_fences
            SET generation=generation+1 WHERE session_id=${input.sessionId}`;
          yield* sql`UPDATE preview_cleanup_state SET proof_at=NULL WHERE session_id=${input.sessionId}`;
          const unresolved =
            yield* sql`SELECT resource FROM preview_allocation_ledger WHERE session_id=${input.sessionId} AND (state='quarantined' OR (state IN ('allocating','deleting') AND provider_resource_id IS NULL))`;
          if (unresolved.length === 0)
            yield* sql`UPDATE preview_cleanup_state SET quarantine_reason=NULL WHERE session_id=${input.sessionId}`;
        }),
      );

    const releaseCleanupReservations = (
      sessionId: string,
      time: number,
      proof: CleanupProofToken,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const completed = yield* sql`UPDATE preview_cleanup_state
            SET completed_at=${time}, quarantine_reason=NULL
            WHERE session_id=${sessionId} AND completed_at IS NULL
              AND proof_at=${proof.proofAt}
              AND EXISTS (
                SELECT 1 FROM preview_cleanup_proof_fences AS fence
                WHERE fence.session_id=${sessionId} AND fence.generation=${proof.generation}
              )
            RETURNING session_id`;
          if (completed.length === 0) return false;
          yield* sql`UPDATE preview_capacity_reservations SET released_at=${time} WHERE session_id=${sessionId} AND released_at IS NULL`;
          return true;
        }),
      );

    const releaseReservationsAfterDeletion = (
      sessionId: string,
      attempt: { started: boolean },
      proof: CleanupProofToken,
      reportWindow: PreviewAllocationCleanupReportWindow,
    ) =>
      Effect.gen(function* () {
        const workWindow = yield* remainingDeletionWorkWindow(
          sessionId,
          attempt,
          proof,
          reportWindow,
        );
        if (workWindow._tag === "Outcome") return workWindow.outcome;
        if (yield* hasUnresolvedAllocations(sessionId)) return "quarantined" as const;
        const released = yield* releaseCleanupReservations(sessionId, now(), proof).pipe(
          Effect.timeoutOption(Duration.millis(workWindow.budgetMs)),
        );
        if (Option.isNone(released)) return "quarantined" as const;
        if (!released.value)
          return (yield* cleanupProofIsCurrent(sessionId, proof))
            ? ("quarantined" as const)
            : ("waiting" as const);
        return "cleaned" as const;
      });

    const cleanupResources = (
      sessionId: string,
      ledger: readonly Record<string, unknown>[],
      proof: CleanupProofToken,
      priorDeletionStartedAt: number | null,
      reportWindow: PreviewAllocationCleanupReportWindow,
    ) =>
      Effect.gen(function* () {
        const deletionAttempt = { started: false };
        const initialTime = now();
        const result = (outcome: PreviewAllocationCleanupResult["outcome"]) =>
          makePreviewAllocationCleanupResult(outcome, reportWindow, now);
        const proofStableAt = proof.proofAt + previewCleanupProofStabilityMs;
        const freshDeletionClaim = hasFreshDeletionClaim(
          ledger,
          initialTime,
          validatedAdapterTimeoutMs,
        );
        const initialWorkBudgetMs = initialDeletionWorkBudgetMs(
          priorDeletionStartedAt,
          proofStableAt,
          initialTime,
          freshDeletionClaim,
        );
        if (initialWorkBudgetMs <= 0) return result("quarantined");
        // Charge the first persisted timing operation to the same attempt observed with its
        // proof-generation and ledger snapshot, leaving the reporting reserve available.
        const initialWorkWindow = yield* remainingDeletionWorkWindow(
          sessionId,
          deletionAttempt,
          proof,
          reportWindow,
        ).pipe(Effect.timeoutOption(Duration.millis(initialWorkBudgetMs)));
        if (Option.isNone(initialWorkWindow))
          return yield* Effect.fail(allocationError("cleanup-deletion-deadline-exceeded"));
        const workWindow = initialWorkWindow.value;
        if (workWindow._tag === "Outcome") return result(workWindow.outcome);
        const deletionPhase = Effect.gen(function* () {
          const deletion = yield* deleteCleanupLedger(
            sessionId,
            ledger,
            deletionAttempt,
            proof,
            reportWindow,
          );
          if (deletion !== "deleted") return deletion;
          return yield* releaseReservationsAfterDeletion(
            sessionId,
            deletionAttempt,
            proof,
            reportWindow,
          );
        });
        const completed = yield* deletionPhase.pipe(
          Effect.timeoutOption(Duration.millis(workWindow.budgetMs)),
        );
        if (Option.isSome(completed)) return result(completed.value);
        return yield* Effect.fail(allocationError("cleanup-deletion-deadline-exceeded"));
      });

    const cleanupWithDeadline = (input: {
      readonly sessionId: string;
      readonly preDeletionDeadlineAt?: number;
    }) =>
      Effect.gen(function* () {
        const reportWindow: PreviewAllocationCleanupReportWindow = {
          state: "unknown",
          deletionDeadlineAt: null,
        };
        const result = (
          outcome: PreviewAllocationCleanupResult["outcome"],
          failure: PreviewAllocationCleanupResult["failure"] = null,
        ) => makePreviewAllocationCleanupResult(outcome, reportWindow, now, failure);
        const cleanup = Effect.gen(function* () {
          const startedAt = now();
          const preDeletionWindow = cleanupPreDeletionWindow(
            startedAt,
            input.preDeletionDeadlineAt,
            "cleanup-pre-deletion-deadline-exceeded",
          );
          if ("error" in preDeletionWindow)
            return yield* Effect.fail(allocationError(preDeletionWindow.error));

          const prepareCleanup = Effect.gen(function* () {
            const sessionState = yield* loadCleanupSession(input.sessionId);
            if (typeof sessionState === "string") {
              reportWindow.state = "absent";
              return { _tag: "Outcome", outcome: sessionState } as const;
            }
            const authorization = yield* loadKnownCleanupLedger(
              input.sessionId,
              sessionState.session,
            );
            if (authorization === undefined) {
              reportWindow.state = "unknown";
              reportWindow.deletionDeadlineAt = null;
              return { _tag: "Outcome", outcome: "quarantined" } as const;
            }
            Object.assign(reportWindow, cleanupReportWindowFromAuthorization(authorization));
            const ledger = authorization.ledger;
            const unknownResources = ledger.filter(
              (entry) =>
                typeof entry.provider_resource_id !== "string" || entry.provider_resource_id === "",
            );
            const proofWorkPlan = planCleanupProofWork(
              reportWindow,
              ledger,
              now(),
              preDeletionWindow.workDeadlineAt,
              validatedAdapterTimeoutMs,
            );
            reportWindow.state = proofWorkPlan.reportAttemptState;
            if (reportWindow.state !== "known") reportWindow.deletionDeadlineAt = null;
            if (proofWorkPlan._tag === "Skip")
              return { _tag: "Outcome", outcome: proofWorkPlan.outcome } as const;
            const proofValidationResult = yield* Effect.gen(function* () {
              yield* markUnknownRowsQuarantined(input.sessionId, unknownResources, now());
              return yield* verifyCleanupProofWithinDeadline(
                input.sessionId,
                ledger,
                authorization.proofGeneration,
                proofWorkPlan.deadlineAt,
              );
            }).pipe(Effect.timeoutOption(Duration.millis(proofWorkPlan.budgetMs)));
            const proofValidation = Option.getOrElse(
              proofValidationResult,
              () => ({ _tag: "TimedOut" }) as const,
            );
            if (proofValidation._tag === "Uncertain") {
              reportWindow.state = "unknown";
              reportWindow.deletionDeadlineAt = null;
              return { _tag: "Outcome", outcome: "waiting" as const } as const;
            }
            if (proofValidation._tag === "ConfirmedInvalidation") {
              if (reportWindow.state !== "known") {
                reportWindow.state = "invalidated";
                reportWindow.deletionDeadlineAt = null;
              }
              return { _tag: "Outcome", outcome: proofWorkPlan.outcome } as const;
            }
            if (proofValidation._tag !== "Verified")
              return { _tag: "Outcome", outcome: proofWorkPlan.outcome } as const;
            return {
              _tag: "Ready",
              ledger,
              proof: proofValidation.proof,
              deletionStartedAt: authorization.deletionStartedAt,
            } as const;
          });
          const prepared = yield* prepareCleanup.pipe(
            Effect.timeoutOption(Duration.millis(preDeletionWindow.workBudgetMs)),
          );
          if (Option.isNone(prepared))
            return yield* Effect.fail(allocationError("cleanup-pre-deletion-deadline-exceeded"));
          if (prepared.value._tag === "Outcome") return result(prepared.value.outcome);
          return yield* cleanupResources(
            input.sessionId,
            prepared.value.ledger,
            prepared.value.proof,
            prepared.value.deletionStartedAt,
            reportWindow,
          );
        });
        const attempted = yield* Effect.result(cleanup);
        if (Result.isFailure(attempted)) return result("quarantined", attempted.failure);
        return attempted.success;
      });

    const api: PreviewAllocationApi = {
      importBaseline: (baseline) => {
        const invalid =
          validateBaselineMeasurements(baseline.measurements) ??
          validateBaselineProfiles(baseline.profiles);
        if (invalid !== undefined) return Effect.fail(invalid);
        return sql.withTransaction(
          Effect.gen(function* () {
            yield* Effect.forEach(baseline.measurements, (measurement) =>
              api.observeCapacity(measurement),
            );
            for (const profile of baseline.profiles) {
              yield* sql`INSERT INTO preview_profile_demand_plans(profile, selected_roles, owned_groups, demands, resources, updated_at)
              VALUES (${profile.profile}, ${JSON.stringify(profile.selectedRoles)}, ${JSON.stringify(profile.ownedGroups)}, ${JSON.stringify(profile.demands)}, ${JSON.stringify(profile.resources)}, ${now()})
              ON CONFLICT(profile) DO UPDATE SET selected_roles=excluded.selected_roles, owned_groups=excluded.owned_groups, demands=excluded.demands, resources=excluded.resources, updated_at=excluded.updated_at`;
            }
            return {
              measurements: baseline.measurements.length,
              profiles: baseline.profiles.length,
            };
          }),
        );
      },
      planProfile: (input) =>
        Effect.gen(function* () {
          const rows =
            yield* sql`SELECT selected_roles, owned_groups, demands, resources FROM preview_profile_demand_plans WHERE profile=${input.profile}`;
          const persistedRows = yield* Effect.try({
            try: () =>
              Schema.decodeUnknownSync(Schema.Array(PersistedPreviewProfileDemandPlanRowSchema))(
                rows,
              ),
            catch: () => allocationError("persisted-profile-demand-plan-invalid"),
          });
          const persisted = persistedRows[0];
          const normalizeSet = (values: readonly string[]) => [...new Set(values)].sort();
          let plan: PreviewProfileDemandPlan | undefined;
          if (persisted !== undefined) {
            const selections = yield* Effect.try({
              try: () => ({
                selectedRoles: Schema.decodeUnknownSync(Schema.Array(Schema.String))(
                  JSON.parse(persisted.selected_roles),
                ),
                ownedGroups: Schema.decodeUnknownSync(Schema.Array(Schema.String))(
                  JSON.parse(persisted.owned_groups),
                ),
              }),
              catch: () => allocationError("persisted-profile-demand-plan-invalid"),
            });
            if (
              JSON.stringify(normalizeSet(selections.selectedRoles)) ===
                JSON.stringify(normalizeSet(input.selectedRoles)) &&
              JSON.stringify(normalizeSet(selections.ownedGroups)) ===
                JSON.stringify(normalizeSet(input.ownedGroups))
            ) {
              plan = yield* Effect.try({
                try: () => ({
                  demands: Schema.decodeUnknownSync(Schema.Array(CapacityDemandSchema))(
                    JSON.parse(persisted.demands),
                  ),
                  resources: Schema.decodeUnknownSync(Schema.Array(Schema.String))(
                    JSON.parse(persisted.resources),
                  ),
                }),
                catch: () => allocationError("persisted-profile-demand-plan-invalid"),
              });
            }
          }
          if (plan === undefined)
            plan = yield* Effect.mapError(
              withPreviewResourceAdapterTimeout(
                "profile-planning",
                adapter.planProfile(input),
                validatedAdapterTimeoutMs,
              ),
              (error) =>
                allocationError(
                  `profile-demand-unavailable:${allocationFailureDescription(error)}`,
                ),
            );
          if (
            hasCompleteProfileDemand({
              profile: input.profile,
              selectedRoles: input.selectedRoles,
              ownedGroups: input.ownedGroups,
              demands: plan.demands,
              resources: plan.resources,
            })
          )
            return plan;
          return yield* Effect.fail(
            allocationError("profile-demand-does-not-match-selected-owned-groups"),
          );
        }),
      validateProfileAllocation: (input) =>
        Effect.mapError(
          withPreviewResourceAdapterTimeout(
            "profile-allocation-validation",
            adapter.validateProfileAllocation(input),
            validatedAdapterTimeoutMs,
          ),
          (error) =>
            allocationError(
              `profile-allocation-unavailable:${allocationFailureDescription(error)}`,
            ),
        ),
      checkCapacity: (demands) =>
        Effect.forEach(demands, (demand) =>
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT * FROM preview_capacity_measurements WHERE dimension=${demand.dimension} AND provider=${demand.provider} AND provider_identity=${demand.identity}`;
            const row = rows[0] as Record<string, unknown> | undefined;
            if (row === undefined) {
              const otherRows =
                yield* sql`SELECT provider, provider_identity FROM preview_capacity_measurements WHERE dimension=${demand.dimension}`;
              const providerRows = yield* Effect.try({
                try: () =>
                  Schema.decodeUnknownSync(Schema.Array(PreviewProviderIdentityRowSchema))(
                    otherRows,
                  ),
                catch: () => allocationError("capacity-provider-ledger-invalid"),
              });
              const observedProviders = providerRows.map(
                (other) => `${other.provider}/${other.provider_identity}`,
              );
              return {
                ...demand,
                status:
                  observedProviders.length === 0
                    ? ("missing" as const)
                    : ("provider-mismatch" as const),
                observedProviders,
                reserved: null,
                available: null,
              };
            }
            if (Number(row.grants_verified) !== 1)
              return {
                ...demand,
                status: "unverified-grants" as const,
                observedProviders: [`${demand.provider}/${demand.identity}`],
                reserved: null,
                available: null,
              };
            if (now() - Number(row.observed_at) > maximumMeasurementAgeMs)
              return {
                ...demand,
                status: "stale" as const,
                observedProviders: [`${demand.provider}/${demand.identity}`],
                reserved: null,
                available: null,
              };
            const reservations =
              yield* sql`SELECT COALESCE(SUM(amount), 0) AS amount FROM preview_capacity_reservations WHERE dimension=${demand.dimension} AND provider=${demand.provider} AND provider_identity=${demand.identity} AND released_at IS NULL`;
            const reserved = Number(
              (reservations[0] as Record<string, unknown> | undefined)?.amount ?? 0,
            );
            const available = Math.max(0, Number(row.total) - Number(row.in_use) - reserved);
            return {
              ...demand,
              status: available < demand.amount ? ("exhausted" as const) : ("ready" as const),
              observedProviders: [`${demand.provider}/${demand.identity}`],
              reserved,
              available,
            };
          }),
        ),
      observeCapacity: (measurement) =>
        Effect.gen(function* () {
          const invalidReason = invalidCapacityMeasurement(measurement, now());
          if (invalidReason !== undefined)
            return yield* Effect.fail(
              allocationError(invalidReason, { dimension: measurement.dimension }),
            );
          yield* sql`INSERT INTO preview_capacity_measurements
            (provider, provider_identity, dimension, observed_at, total, in_use, grants_verified)
            VALUES (${measurement.provider}, ${measurement.identity}, ${measurement.dimension}, ${measurement.observedAt}, ${measurement.total}, ${measurement.inUse}, ${measurement.grantsVerified ? 1 : 0})
            ON CONFLICT(provider, provider_identity, dimension) DO UPDATE SET
              observed_at=excluded.observed_at, total=excluded.total, in_use=excluded.in_use,
              grants_verified=excluded.grants_verified`;
        }),
      reserveAndAllocate: (input) =>
        Effect.gen(function* () {
          const invalid = validateAllocationRequest(input);
          if (invalid !== undefined) return yield* Effect.fail(invalid);
          const existing =
            yield* sql`SELECT session_id FROM preview_capacity_reservations WHERE session_id=${input.sessionId} AND released_at IS NULL LIMIT 1`;
          if (existing.length > 0)
            return yield* Effect.fail(allocationError("session-already-reserved"));
          const rows = yield* reserveCapacityAndLedger(input);
          return yield* allocateRecordedResources(input.sessionId, rows, input.resourceMetadata);
        }),
      cleanup: (input) =>
        Effect.flatMap(cleanupWithDeadline(input), (result) =>
          result.failure === null ? Effect.succeed(result.outcome) : Effect.fail(result.failure),
        ),
      cleanupWithDeadline,
      resolveUnknownAllocation: (input) =>
        Effect.gen(function* () {
          const startedAt = now();
          const preDeletionWindow = cleanupPreDeletionWindow(
            startedAt,
            input.preDeletionDeadlineAt,
            "cleanup-resolution-deadline-exceeded",
          );
          if ("error" in preDeletionWindow)
            return yield* Effect.fail(allocationError(preDeletionWindow.error));

          const resolve = Effect.gen(function* () {
            const ownerToken = yield* readUnknownAllocationTarget(input.sessionId, input.resource);
            const providerIdentities = yield* readProviderIdentities(input.sessionId);
            const timeoutMs = Math.min(
              validatedAdapterTimeoutMs * 2,
              preDeletionWindow.workDeadlineAt - now(),
            );
            if (timeoutMs <= 0)
              return yield* Effect.fail(allocationError("cleanup-resolution-deadline-exceeded"));
            const evidence = yield* verifyResolutionEvidence(
              input,
              ownerToken,
              providerIdentities,
              timeoutMs,
            );
            yield* persistResolutionEvidence(input, ownerToken, evidence);
            return Match.value(evidence.result).pipe(
              Match.when({ status: "found" }, () => "resolved-owned" as const),
              Match.when({ status: "absent" }, () => "verified-absent" as const),
              Match.exhaustive,
            );
          });
          const resolved = yield* resolve.pipe(
            Effect.timeoutOption(Duration.millis(preDeletionWindow.workBudgetMs)),
          );
          if (Option.isNone(resolved))
            return yield* Effect.fail(allocationError("cleanup-resolution-deadline-exceeded"));
          return resolved.value;
        }),
      inspect: (sessionId) =>
        Effect.gen(function* () {
          const reservationRows =
            yield* sql`SELECT * FROM preview_capacity_reservations WHERE session_id=${sessionId} ORDER BY dimension`;
          const allocationRows =
            yield* sql`SELECT * FROM preview_allocation_ledger WHERE session_id=${sessionId} ORDER BY resource`;
          const cleanupRows =
            yield* sql`SELECT cleanup_state.*, timing.settlement_started_at, timing.deletion_started_at,
              CASE WHEN timing.session_id IS NULL THEN 0 ELSE 1 END AS has_cleanup_timing
            FROM preview_cleanup_state AS cleanup_state
            LEFT JOIN preview_cleanup_timing AS timing ON timing.session_id=cleanup_state.session_id
            WHERE cleanup_state.session_id=${sessionId}`;
          const reservations = yield* Effect.try({
            try: () =>
              Schema.decodeUnknownSync(Schema.Array(PreviewCapacityReservationRowSchema))(
                reservationRows,
              ),
            catch: () => allocationError("allocation-reservation-ledger-invalid"),
          });
          const allocations = yield* Effect.try({
            try: () =>
              Schema.decodeUnknownSync(Schema.Array(PreviewAllocationLedgerStatusRowSchema))(
                allocationRows,
              ),
            catch: () => allocationError("allocation-ownership-ledger-invalid"),
          });
          const cleanupState = yield* Effect.try({
            try: () =>
              cleanupRows.length === 0
                ? undefined
                : Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
                    cleanupRows[0],
                  ),
            catch: () => allocationError("allocation-cleanup-ledger-invalid"),
          });
          const observedAt = now();
          const hasFreshDeletionClaim = allocations.some(
            (allocation) =>
              allocation.state === "deleting" &&
              allocation.updated_at > observedAt - validatedAdapterTimeoutMs,
          );
          return {
            reservations: reservations.map((row) => ({
              dimension: row.dimension,
              amount: row.amount,
              provider: row.provider,
              identity: row.provider_identity,
              releasedAt: row.released_at,
            })),
            allocations: allocations.map((row) => ({
              resource: String(row.resource),
              providerResourceId: row.provider_resource_id,
              state: row.state,
              failure: row.failure,
            })),
            cleanup: cleanupOutcome(cleanupState),
            cleanupTiming: buildCleanupTimingStatus(
              cleanupTimingDataFromRow(cleanupState),
              observedAt,
              hasFreshDeletionClaim,
            ),
          };
        }),
      markCleanupUnconfirmed: (input) =>
        Effect.gen(function* () {
          const session = yield* readRequiredSession(input.sessionId);
          if (session.ended_at === null)
            return yield* Effect.fail(allocationError("live-session-destruction-refused"));
          const endedAt = Number(session.ended_at);
          yield* sql`INSERT INTO preview_cleanup_state(session_id, ended_at, proof_at) VALUES (${input.sessionId}, ${endedAt}, NULL) ON CONFLICT(session_id) DO NOTHING`;
          yield* sql`INSERT INTO preview_cleanup_timing(session_id, settlement_started_at) VALUES (${input.sessionId}, ${endedAt}) ON CONFLICT(session_id) DO NOTHING`;
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason=${input.reason} WHERE session_id=${input.sessionId} AND completed_at IS NULL`;
        }),
    };

    function verifyCleanupProofWithinDeadline(
      sessionId: string,
      ledger: readonly Record<string, unknown>[],
      proofGeneration: number,
      preDeletionDeadlineAt: number | undefined,
    ): Effect.Effect<
      CleanupProofValidation,
      SqlError.SqlError | Error | PlatformError,
      FileSystem.FileSystem
    > {
      if (preDeletionDeadlineAt === undefined)
        return verifyCleanupProof(sessionId, ledger, proofGeneration);
      return Effect.gen(function* () {
        const remainingProofMs = preDeletionDeadlineAt - now();
        if (remainingProofMs <= 0) return { _tag: "DeadlineExpired" } as const;
        const proof = yield* verifyCleanupProof(sessionId, ledger, proofGeneration).pipe(
          Effect.timeoutOption(Duration.millis(remainingProofMs)),
        );
        return Option.getOrElse(proof, () => ({ _tag: "TimedOut" }) as const);
      });
    }

    return api;
  });

export class PreviewAllocationController extends Context.Service<
  PreviewAllocationController,
  PreviewAllocationApi
>()("developer-launcher/PreviewAllocationController") {}

export const PreviewAllocationControllerLive = (
  adapter: PreviewResourceAdapter,
  now: () => number = Date.now,
  config: PreviewAllocationConfig = DEFAULT_PREVIEW_ALLOCATION_CONFIG,
  initializeSchema = true,
  adapterTimeoutMs = DEFAULT_PREVIEW_RESOURCE_ADAPTER_TIMEOUT_MS,
) =>
  Layer.effect(
    PreviewAllocationController,
    makePreviewAllocationController(adapter, now, config, initializeSchema, adapterTimeoutMs),
  );

const verifyLocalOwnerRecord = (
  ownerRecord: string,
  expected: { readonly sessionId: string; readonly ownerToken: string; readonly resource: string },
) =>
  Effect.gen(function* () {
    const decoded = yield* Effect.try({
      try: () =>
        JSON.parse(
          ownerRecord,
        ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as {
          readonly sessionId?: unknown;
          readonly ownerToken?: unknown;
          readonly resource?: unknown;
        } /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      catch: () => new Error("local-resource-owner-record-invalid"),
    });
    if (
      decoded.sessionId !== expected.sessionId ||
      decoded.ownerToken !== expected.ownerToken ||
      decoded.resource !== expected.resource
    )
      return yield* Effect.fail(new Error("local-resource-owner-mismatch"));
  });

/** Local disposable adapter used by launcher acceptance tests, never by connected profiles. */
export const makeLocalFilesystemPreviewResourceAdapter = (root: string): PreviewResourceAdapter => {
  const rootPath = path.resolve(root);
  const safeSegment = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  return {
    planProfile: () =>
      Effect.fail(new Error("local-adapter-does-not-provide-connected-profile-demand")),
    validateProfileAllocation: () =>
      Effect.fail(
        new Error("local-filesystem-adapter-does-not-allocate-connected-profile-resources"),
      ),
    allocate: ({ sessionId, ownerToken, resource }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        if (!safeSegment(sessionId) || !safeSegment(ownerToken) || !safeSegment(resource))
          return yield* Effect.fail(new Error("unsafe-local-resource-identity"));
        const ownerDirectory = path.join(rootPath, sessionId);
        const resourcePath = path.join(ownerDirectory, `${resource}.owner`);
        yield* fileSystem.makeDirectory(ownerDirectory, { recursive: true, mode: 0o700 });
        yield* fileSystem.writeFileString(
          resourcePath,
          JSON.stringify({ sessionId, ownerToken, resource }),
          { flag: "wx", mode: 0o600 },
        );
        yield* fileSystem.chmod(ownerDirectory, 0o700);
        yield* fileSystem.chmod(resourcePath, 0o600);
        return resourcePath;
      }),
    deleteOwned: ({ providerResourceId, ownerToken, resource }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const resolved = path.resolve(providerResourceId);
        const relative = path.relative(rootPath, resolved);
        if (
          relative === "" ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          return yield* Effect.fail(new Error("local-resource-outside-owner-root"));
        if (!(yield* fileSystem.exists(resolved))) return;
        const ownerRecord = yield* fileSystem.readFileString(resolved);
        yield* verifyLocalOwnerRecord(ownerRecord, {
          sessionId: path.basename(path.dirname(resolved)),
          ownerToken,
          resource,
        });
        yield* fileSystem.remove(resolved);
      }),
    proveCleanup: ({ resources }) =>
      Effect.succeed(resources.every(({ providerResourceId }) => providerResourceId !== null)),
    resolveUnknown: ({ sessionId, resource, ownerToken, providerIdentities }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        if (!safeSegment(sessionId) || !safeSegment(ownerToken) || !safeSegment(resource))
          return yield* Effect.fail(new Error("unsafe-local-resource-identity"));
        if (providerIdentities.length !== 1)
          return yield* Effect.fail(new Error("local-resource-provider-identity-is-ambiguous"));
        const providerIdentity = providerIdentities[0]!;
        const resourcePath = path.join(rootPath, sessionId, `${resource}.owner`);
        if (!(yield* fileSystem.exists(resourcePath)))
          return {
            sessionId,
            resource,
            ownerToken,
            provider: providerIdentity.provider,
            identity: providerIdentity.identity,
            verifiedAt: Date.now(),
            allocationSettled: true,
            result: { status: "absent" as const },
          };
        const ownerRecord = yield* fileSystem.readFileString(resourcePath);
        yield* verifyLocalOwnerRecord(ownerRecord, { sessionId, ownerToken, resource });
        return {
          sessionId,
          resource,
          ownerToken,
          provider: providerIdentity.provider,
          identity: providerIdentity.identity,
          verifiedAt: Date.now(),
          allocationSettled: true,
          result: { status: "found" as const, providerResourceId: resourcePath },
        };
      }),
  };
};
