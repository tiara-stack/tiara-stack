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

/** Unit-bearing dimensions providers must observe for each owned preview group. */
export const previewCapacityDimensionsByGroup = {
  "application-zero": [
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
  ) => Effect.Effect<readonly CapacityCheckResult[], SqlError.SqlError>;
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
  ) => Effect.Effect<PreviewAllocationStatus, SqlError.SqlError>;
  readonly cleanup: (input: {
    readonly sessionId: string;
  }) => Effect.Effect<
    "waiting" | "cleaned" | "quarantined",
    PreviewAllocationError | SqlError.SqlError | Error | PlatformError,
    FileSystem.FileSystem
  >;
  readonly resolveUnknownAllocation: (input: {
    readonly sessionId: string;
    readonly resource: string;
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
  error instanceof PreviewAllocationError
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
      previewCapacityDimensionsByGroup[group as keyof typeof previewCapacityDimensionsByGroup] ??
      [],
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
          return yield* sql`SELECT resource, owner_token FROM preview_allocation_ledger WHERE session_id=${input.sessionId} ORDER BY rowid`;
        }),
      );

    const allocateOneResource = (
      sessionId: string,
      value: Record<string, unknown>,
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
      rows: Array<Record<string, unknown>>,
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
        if (cleanups.length > 0 && (cleanups[0] as Record<string, unknown>).completed_at !== null)
          return "cleaned" as const;
        if (Number(session.unsettled) !== 0) return "waiting" as const;
        const endedAt = Number(session.ended_at);
        if (cleanups.length === 0)
          yield* sql`INSERT INTO preview_cleanup_state(session_id, ended_at, proof_at) VALUES (${sessionId}, ${endedAt}, NULL) ON CONFLICT(session_id) DO NOTHING`;
        return { session } as const;
      });

    const loadKnownCleanupLedger = (sessionId: string, session: Record<string, unknown>) =>
      Effect.gen(function* () {
        const ledger =
          yield* sql`SELECT * FROM preview_allocation_ledger WHERE session_id=${sessionId} AND state IN ('allocating','owned','quarantined','deleting') ORDER BY rowid DESC`;
        const allRows =
          yield* sql`SELECT resource FROM preview_allocation_ledger WHERE session_id=${sessionId}`;
        let recordedResources: Readonly<Record<string, unknown>>;
        try {
          recordedResources = JSON.parse(String(session.resource_ids)) as Readonly<
            Record<string, unknown>
          >;
        } catch {
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-ownership-ledger' WHERE session_id=${sessionId}`;
          return undefined;
        }
        const ledgerResources = new Set(
          (allRows as Array<Record<string, unknown>>).map((row) => String(row.resource)),
        );
        if (Object.keys(recordedResources).some((resource) => !ledgerResources.has(resource))) {
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-ownership-ledger' WHERE session_id=${sessionId}`;
          return undefined;
        }
        return ledger as Array<Record<string, unknown>>;
      });

    const verifyCleanupProof = (sessionId: string, ledger: readonly Record<string, unknown>[]) =>
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
          yield* sql`UPDATE preview_cleanup_state SET proof_at=NULL WHERE session_id=${sessionId}`;
          return false;
        }
        const proofCompletedAt = now();
        yield* sql`UPDATE preview_cleanup_state SET proof_at=COALESCE(proof_at, ${proofCompletedAt}) WHERE session_id=${sessionId}`;
        const rows =
          yield* sql`SELECT proof_at FROM preview_cleanup_state WHERE session_id=${sessionId}`;
        const proofAt = Number((rows[0] as Record<string, unknown>).proof_at);
        return now() >= proofAt + 5 * 60_000;
      });

    const readDeletionClaimOutcome = (sessionId: string, resource: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT state FROM preview_allocation_ledger WHERE session_id=${sessionId} AND resource=${resource}`;
        const state = (rows[0] as Record<string, unknown> | undefined)?.state;
        if (state === "deleted" || state === "not-allocated") return "deleted" as const;
        return state === "deleting" ? ("waiting" as const) : ("quarantined" as const);
      });

    const deleteCleanupResource = (sessionId: string, entry: Record<string, unknown>) =>
      Effect.gen(function* () {
        const resource = String(entry.resource);
        const ownerToken = String(entry.owner_token);
        const providerResourceId = entry.provider_resource_id;
        if (typeof providerResourceId !== "string" || providerResourceId === "") {
          const time = now();
          yield* sql`UPDATE preview_allocation_ledger SET state='quarantined', failure='unknown-owner-or-resource', updated_at=${time} WHERE session_id=${sessionId} AND resource=${resource}`;
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-owner-or-resource' WHERE session_id=${sessionId}`;
          return "quarantined" as const;
        }
        const claimTime = now();
        const claimed =
          yield* sql`UPDATE preview_allocation_ledger SET state='deleting', failure=NULL, updated_at=${claimTime} WHERE session_id=${sessionId} AND resource=${resource} AND owner_token=${ownerToken} AND provider_resource_id=${providerResourceId} AND (state IN ('owned','quarantined') OR (state='deleting' AND updated_at <= ${claimTime - validatedAdapterTimeoutMs})) RETURNING resource`;
        if (claimed.length === 0) return yield* readDeletionClaimOutcome(sessionId, resource);
        const removed = yield* Effect.result(
          withPreviewResourceAdapterTimeout(
            "resource-deletion",
            adapter.deleteOwned({ sessionId, providerResourceId, ownerToken, resource }),
            validatedAdapterTimeoutMs,
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

    const deleteCleanupLedger = (sessionId: string, ledger: readonly Record<string, unknown>[]) =>
      Effect.gen(function* () {
        for (const entry of ledger) {
          const result = yield* deleteCleanupResource(sessionId, entry);
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
          yield* sql`UPDATE preview_allocation_ledger SET state='quarantined', failure='unknown-owner-or-resource', updated_at=${time} WHERE session_id=${sessionId} AND resource=${resource}`;
        }
        if (entries.length > 0)
          yield* sql`UPDATE preview_cleanup_state SET quarantine_reason='unknown-owner-or-resource' WHERE session_id=${sessionId}`;
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
        const identities = (rows as Array<Record<string, unknown>>).map((row) => ({
          provider: String(row.provider),
          identity: String(row.provider_identity),
        }));
        if (identities.length === 0)
          return yield* Effect.fail(allocationError("provider-resolution-identity-unreserved"));
        return identities;
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
    ) =>
      Effect.gen(function* () {
        if (adapter.resolveUnknown === undefined)
          return yield* Effect.fail(allocationError("provider-resolution-unavailable"));
        const response = yield* Effect.result(
          withPreviewResourceAdapterTimeout(
            "ownership-resolution",
            adapter.resolveUnknown({ ...input, ownerToken, providerIdentities }),
            validatedAdapterTimeoutMs * 2,
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
          yield* sql`UPDATE preview_cleanup_state SET proof_at=NULL WHERE session_id=${input.sessionId}`;
          const unresolved =
            yield* sql`SELECT resource FROM preview_allocation_ledger WHERE session_id=${input.sessionId} AND (state='quarantined' OR (state IN ('allocating','deleting') AND provider_resource_id IS NULL))`;
          if (unresolved.length === 0)
            yield* sql`UPDATE preview_cleanup_state SET quarantine_reason=NULL WHERE session_id=${input.sessionId}`;
        }),
      );

    const releaseCleanupReservations = (sessionId: string, time: number) =>
      Effect.gen(function* () {
        yield* sql`UPDATE preview_capacity_reservations SET released_at=${time} WHERE session_id=${sessionId} AND released_at IS NULL`;
        yield* sql`UPDATE preview_cleanup_state SET completed_at=${time}, quarantine_reason=NULL WHERE session_id=${sessionId}`;
      });

    const cleanupResources = (
      sessionId: string,
      ledger: readonly Record<string, unknown>[],
      unknownResourcesCount: number,
      time: number,
    ) =>
      Effect.gen(function* () {
        if (!(yield* verifyCleanupProof(sessionId, ledger)))
          return unknownResourcesCount > 0 ? ("quarantined" as const) : ("waiting" as const);
        const deletion = yield* deleteCleanupLedger(sessionId, ledger);
        if (deletion === "quarantined") return "quarantined" as const;
        if (deletion === "waiting") return "waiting" as const;
        if (yield* hasUnresolvedAllocations(sessionId)) return "quarantined" as const;
        yield* releaseCleanupReservations(sessionId, time);
        return "cleaned" as const;
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
          const persisted = rows[0] as Record<string, unknown> | undefined;
          const normalizeSet = (values: readonly string[]) => [...new Set(values)].sort();
          const plan =
            persisted !== undefined &&
            JSON.stringify(
              normalizeSet(JSON.parse(String(persisted.selected_roles)) as string[]),
            ) === JSON.stringify(normalizeSet(input.selectedRoles)) &&
            JSON.stringify(normalizeSet(JSON.parse(String(persisted.owned_groups)) as string[])) ===
              JSON.stringify(normalizeSet(input.ownedGroups))
              ? {
                  demands: JSON.parse(String(persisted.demands)) as readonly CapacityDemand[],
                  resources: JSON.parse(String(persisted.resources)) as readonly string[],
                }
              : yield* Effect.mapError(
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
              const observedProviders = (otherRows as Array<Record<string, unknown>>).map(
                (other) => `${String(other.provider)}/${String(other.provider_identity)}`,
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
          return yield* allocateRecordedResources(
            input.sessionId,
            rows as Array<Record<string, unknown>>,
            input.resourceMetadata,
          );
        }),
      cleanup: (input) =>
        Effect.gen(function* () {
          const time = now();
          const sessionState = yield* loadCleanupSession(input.sessionId);
          if (sessionState === "cleaned") return "cleaned" as const;
          if (sessionState === "waiting") return "waiting" as const;
          const ledger = yield* loadKnownCleanupLedger(input.sessionId, sessionState.session);
          if (ledger === undefined) return "quarantined" as const;
          const unknownResources = ledger.filter(
            (entry) =>
              typeof entry.provider_resource_id !== "string" || entry.provider_resource_id === "",
          );
          yield* markUnknownRowsQuarantined(input.sessionId, unknownResources, time);
          return yield* cleanupResources(input.sessionId, ledger, unknownResources.length, time);
        }),
      resolveUnknownAllocation: (input) =>
        Effect.gen(function* () {
          const ownerToken = yield* readUnknownAllocationTarget(input.sessionId, input.resource);
          const providerIdentities = yield* readProviderIdentities(input.sessionId);
          const evidence = yield* verifyResolutionEvidence(input, ownerToken, providerIdentities);
          yield* persistResolutionEvidence(input, ownerToken, evidence);
          return Match.value(evidence.result).pipe(
            Match.when({ status: "found" }, () => "resolved-owned" as const),
            Match.when({ status: "absent" }, () => "verified-absent" as const),
            Match.exhaustive,
          );
        }),
      inspect: (sessionId) =>
        Effect.gen(function* () {
          const reservations =
            yield* sql`SELECT * FROM preview_capacity_reservations WHERE session_id=${sessionId} ORDER BY dimension`;
          const allocations =
            yield* sql`SELECT * FROM preview_allocation_ledger WHERE session_id=${sessionId} ORDER BY resource`;
          const cleanup =
            yield* sql`SELECT * FROM preview_cleanup_state WHERE session_id=${sessionId}`;
          const cleanupState = cleanup[0] as Record<string, unknown> | undefined;
          return {
            reservations: (reservations as Array<Record<string, unknown>>).map((row) => ({
              dimension: String(row.dimension),
              amount: Number(row.amount),
              provider: String(row.provider),
              identity: String(row.provider_identity),
              releasedAt: row.released_at === null ? null : Number(row.released_at),
            })),
            allocations: (allocations as Array<Record<string, unknown>>).map((row) => ({
              resource: String(row.resource),
              providerResourceId:
                typeof row.provider_resource_id === "string" ? row.provider_resource_id : null,
              state: row.state as
                | "allocating"
                | "owned"
                | "deleting"
                | "quarantined"
                | "deleted"
                | "not-allocated",
              failure: typeof row.failure === "string" ? row.failure : null,
            })),
            cleanup:
              cleanupState === undefined
                ? null
                : cleanupState.completed_at !== null
                  ? "cleaned"
                  : cleanupState.quarantine_reason == null
                    ? "waiting"
                    : "quarantined",
          };
        }),
    };
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
        JSON.parse(ownerRecord) as {
          readonly sessionId?: unknown;
          readonly ownerToken?: unknown;
          readonly resource?: unknown;
        },
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
