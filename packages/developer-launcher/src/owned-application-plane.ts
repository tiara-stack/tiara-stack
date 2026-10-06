import { createHash } from "node:crypto";
import { Effect, Match, Predicate, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  makeSyntheticDevelopmentSeed,
  syntheticDevelopmentSeedId,
  type ApprovedSeedBindings,
  type SyntheticDevelopmentSeed,
  type SyntheticDevelopmentSeedReceipt,
} from "./synthetic-development-seed";
import {
  previewCapacityDimensionsByGroup,
  type PreviewResourceAdapter,
  type PreviewResourceMetadata,
  type CapacityDemand,
} from "./preview-allocations";

export const ownedApplicationResource = "application-zero";
export class OwnedApplicationError extends Schema.TaggedErrorClass<OwnedApplicationError>()(
  "OwnedApplicationError",
  { reason: Schema.String },
) {}
const fail = (reason: string) => Effect.fail(new OwnedApplicationError({ reason }));
const LifecyclePhase = Schema.Literals([
  "reserved",
  "provisioning",
  "migrating",
  "starting",
  "ready",
  "quarantined",
  "deleting",
  "deleted",
  "resolving",
  "fenced",
]);
type LifecyclePhase = typeof LifecyclePhase.Type;
// Unknown allocation recovery may claim stable phases or an allocation interrupted by a crash.
// Active sessions and an existing resolution/deletion claim remain blocked.
const resolutionEligiblePlanePhases: ReadonlySet<LifecyclePhase> = new Set([
  "reserved",
  "provisioning",
  "migrating",
  "starting",
  "ready",
  "quarantined",
  "fenced",
]);
const compareCodePoints = (left: string, right: string) => {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
};
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (Predicate.isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => compareCodePoints(a, b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
};
export const applicationPlaneDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const digest = applicationPlaneDigest;
const Identifier = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,62}$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Migration = Schema.Struct({ id: Schema.Int, name: Schema.String, digest: Digest });
export const ApplicationArtifacts = Schema.Struct({
  generatedSchema: Digest,
  callbacks: Digest,
  authorization: Digest,
  client: Digest,
  deployment: Digest,
  zeroVersion: Schema.Literal("1.5.0"),
  migrations: Schema.Array(Migration),
});
export type ApplicationArtifacts = typeof ApplicationArtifacts.Type;
const ObjectKind = Schema.Literals([
  "database",
  "role",
  "grant",
  "schema",
  "publication",
  "trigger",
  "slot",
  "slot-prefix",
  "volume",
  "file",
]);
const Resource = Schema.Struct({ kind: ObjectKind, name: Schema.String });
export type ApplicationResource = typeof Resource.Type;
const Plane = Schema.Struct({
  sessionId: Schema.String,
  ownerToken: Schema.String,
  server: Schema.String,
  generation: Schema.Int,
  database: Identifier,
  app: Identifier,
  role: Identifier,
  replicationRole: Identifier,
  migrationOwner: Identifier,
  storageKey: Schema.String,
  callbackOrigin: Schema.String,
  cacheOrigin: Schema.String,
  artifacts: ApplicationArtifacts,
  resources: Schema.Array(Resource),
});
export type OwnedApplicationPlane = typeof Plane.Type;

/** All names are generated from centrally assigned session/owner identities, never branch names. */
export const applicationPlaneIdentity = (input: {
  readonly sessionId: string;
  readonly ownerToken: string;
  readonly server: string;
  readonly generation: number;
  readonly callbackOrigin: string;
  readonly cacheOrigin: string;
  readonly artifacts: ApplicationArtifacts;
}): OwnedApplicationPlane => {
  const app = `p${digest([input.server, input.sessionId, input.ownerToken, input.generation]).slice(0, 32)}`;
  const database = `${app}_db`;
  const role = `${app}_runtime`;
  const replicationRole = `${app}_replication`;
  const migrationOwner = `${app}_migrate`;
  return {
    ...input,
    app,
    database,
    role,
    replicationRole,
    migrationOwner,
    storageKey: `${input.sessionId}/${input.generation}/${app}/${input.artifacts.client}`,
    resources: [
      { kind: "database", name: database },
      ...[role, replicationRole, migrationOwner].map((name) => ({ kind: "role" as const, name })),
      ...[role, replicationRole, migrationOwner].map((name) => ({
        kind: "grant" as const,
        name: `${database}/${name}`,
      })),
      ...[app, `${app}_0`, `${app}_0/cvr`, `${app}_0/cdc`, `${app}_bootstrap`, `zero_${app}`].map(
        (name) => ({ kind: "schema" as const, name }),
      ),
      ...[
        `_${app}_metadata_0`,
        `_${app}_public_0`,
        `_zero_metadata_${app}`,
        `_zero_public_${app}`,
        "zero_data",
      ].map((name) => ({ kind: "publication" as const, name })),
      ...[
        `${app}_ddl_start_0`,
        `${app}_ddl_end_0`,
        `zero_ddl_start_${app}`,
        `zero_ddl_end_${app}`,
      ].map((name) => ({ kind: "trigger" as const, name })),
      { kind: "slot", name: `${app}_0` },
      { kind: "slot", name: `zero_${app}` },
      { kind: "slot-prefix", name: `${app}_0_` },
      { kind: "slot-prefix", name: `zero_${app}_` },
      { kind: "volume", name: `${app}-replica` },
      { kind: "volume", name: `${app}-credentials` },
      ...["runtime", "replication", "migration"].map((name) => ({
        kind: "file" as const,
        name: `${app}-credentials/${name}`,
      })),
      ...["replica.db", "replica.db-wal", "replica.db-shm"].map((file) => ({
        kind: "file" as const,
        name: `${app}-replica/${file}`,
      })),
    ],
  };
};

export const requiredApplicationGrants = [
  "create-database",
  "drop-owned-database",
  "create-scoped-roles",
  "revoke-scoped-grants",
  "create-publication",
  "own-published-tables",
  "create-schema",
  "logical-replication",
  "create-drop-slot",
  "terminate-owned-backends",
  "ddl-detection",
  "logical-messages",
] as const;
export interface ApplicationAdmission {
  readonly server: string;
  readonly observedAt: number;
  readonly development: boolean;
  readonly grants: readonly string[];
  readonly artifacts: ApplicationArtifacts;
  readonly sharedDatabases: readonly string[];
  /** Provider verifies the whole server catalog, including legacy and dynamic slot prefixes. */
  readonly namesAvailable: boolean;
  readonly scopedCredentials: boolean;
  readonly planeDigest: string;
}
export interface ApplicationInventory {
  readonly server: string;
  readonly database: string;
  readonly app: string;
  readonly ownerToken: string;
  /** No in-flight create/migration/start can complete after this observation. */
  readonly operationsTerminal: boolean;
  readonly writersTerminated: boolean;
  readonly objects: readonly {
    readonly kind: Exclude<ApplicationResource["kind"], "slot-prefix">;
    readonly name: string;
    readonly ownerToken: string;
    readonly database: string;
    readonly active: boolean;
  }[];
}

/**
 * Operator boundary. Implementations must fence writes by the recorded owner, verify real
 * PostgreSQL ACLs/catalogs, and keep credentials in managed files. No provider is installed
 * by default. A mock provider establishes orchestration evidence only.
 */
export interface OwnedApplicationProvider {
  readonly provider: string;
  readonly server: string;
  readonly demands: readonly CapacityDemand[];
  readonly inspectAdmission: (
    plane: OwnedApplicationPlane,
  ) => Effect.Effect<ApplicationAdmission, Error>;
  readonly provision: (plane: OwnedApplicationPlane) => Effect.Effect<void, Error>;
  /** Fresh database only, empty rows, immutable generated artifacts, one forward migration owner. */
  readonly migrate: (plane: OwnedApplicationPlane) => Effect.Effect<ApplicationArtifacts, Error>;
  /** Read trusted development identity/target evidence. Never create grants or credentials. */
  readonly resolveSeedBindings?: (
    plane: OwnedApplicationPlane,
    seedId: string,
  ) => Effect.Effect<ApprovedSeedBindings, Error>;
  /** Apply rows and an idempotency receipt in one owned-database transaction. */
  readonly applySeed?: (
    plane: OwnedApplicationPlane,
    seed: SyntheticDevelopmentSeed,
  ) => Effect.Effect<SyntheticDevelopmentSeedReceipt, Error>;
  readonly start: (
    plane: OwnedApplicationPlane,
    configuration: ApplicationRuntimeConfiguration,
  ) => Effect.Effect<void, Error>;
  /** Must traverse actual session endpoints and validate every participant's state/artifact identity. */
  readonly ready: (
    plane: OwnedApplicationPlane,
  ) => Effect.Effect<ApplicationEndpointEvidence, Error>;
  /** Fence queued operations as well as live consumers; return only after termination is proven. */
  readonly fence: (plane: OwnedApplicationPlane) => Effect.Effect<void, Error>;
  readonly inventory: (plane: OwnedApplicationPlane) => Effect.Effect<ApplicationInventory, Error>;
  /** Exact catalog identity and owner rechecked atomically with deletion. Never LIKE or zero-out. */
  readonly remove: (
    plane: OwnedApplicationPlane,
    resource: ApplicationInventory["objects"][number],
  ) => Effect.Effect<void, Error>;
}
interface SelectedSeedOperations {
  readonly resolveSeedBindings: NonNullable<OwnedApplicationProvider["resolveSeedBindings"]>;
  readonly applySeed: NonNullable<OwnedApplicationProvider["applySeed"]>;
}
const selectSeedOperations = (
  seedId: string | undefined,
  provider: OwnedApplicationProvider,
): Effect.Effect<SelectedSeedOperations | undefined, OwnedApplicationError> =>
  Effect.gen(function* () {
    if (seedId === undefined) return undefined;
    if (seedId !== syntheticDevelopmentSeedId) return yield* fail("unsupported-synthetic-seed");
    if (provider.resolveSeedBindings === undefined || provider.applySeed === undefined)
      return yield* fail("synthetic-seed-provider-unavailable");
    return {
      resolveSeedBindings: provider.resolveSeedBindings,
      applySeed: provider.applySeed,
    };
  });
export interface ApplicationEndpointEvidence {
  readonly sessionId: string;
  readonly generation: number;
  readonly database: string;
  readonly app: string;
  readonly callbackOrigin: string;
  readonly cacheOrigin: string;
  readonly storageKey: string;
  readonly artifacts: ApplicationArtifacts;
}
export interface ApplicationRuntimeConfiguration {
  readonly database: string;
  readonly credentialRoles: {
    readonly runtime: string;
    readonly replication: string;
    readonly migration: string;
  };
  readonly dbBootstrapPolicy: "shared-admission";
  readonly zero: {
    readonly appId: string;
    readonly upstreamDatabase: string;
    readonly cvrDatabase: string;
    readonly changeDatabase: string;
    readonly publications: readonly string[];
    readonly queryURL: string;
    readonly mutateURL: string;
    readonly replicaFile: string;
  };
  readonly client: { readonly cacheURL: string; readonly storageKey: string };
  readonly seed: false;
}
export const applicationRuntimeConfiguration = (
  plane: OwnedApplicationPlane,
): ApplicationRuntimeConfiguration => ({
  database: plane.database,
  credentialRoles: {
    runtime: plane.role,
    replication: plane.replicationRole,
    migration: plane.migrationOwner,
  },
  dbBootstrapPolicy: "shared-admission",
  zero: {
    appId: plane.app,
    upstreamDatabase: plane.database,
    cvrDatabase: plane.database,
    changeDatabase: plane.database,
    publications: ["zero_data"],
    queryURL: `${plane.callbackOrigin}/zero/query`,
    mutateURL: `${plane.callbackOrigin}/zero/mutate`,
    replicaFile: `${plane.app}-replica/replica.db`,
  },
  client: { cacheURL: plane.cacheOrigin, storageKey: plane.storageKey },
  seed: false,
});

const validateSessionOrigin = (origin: string) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(origin),
      catch: () => new OwnedApplicationError({ reason: "invalid-session-origin" }),
    });
    if (url.protocol !== "https:" || url.username || url.password || url.origin !== origin)
      return yield* fail("invalid-session-origin");
  });

const validatePlaneIdentity = (plane: OwnedApplicationPlane) => {
  if (
    plane.generation < 1 ||
    plane.sessionId === "" ||
    plane.ownerToken === "" ||
    plane.server === ""
  )
    return fail("invalid-identity");
  return Effect.void;
};

const validateResourceIdentifiers = (resources: readonly ApplicationResource[]) =>
  resources.some(
    (resource) =>
      !["grant", "file", "volume"].includes(resource.kind) && Buffer.byteLength(resource.name) > 63,
  )
    ? fail("identifier-limit")
    : Effect.void;

const validateForwardMigrations = (migrations: ApplicationArtifacts["migrations"]) =>
  migrations.length === 0 ||
  migrations.some(
    (migration, index) => migration.id <= (migrations[index - 1]?.id ?? 0) || migration.name === "",
  )
    ? fail("invalid-forward-migrations")
    : Effect.void;

const validatePlane = (plane: OwnedApplicationPlane) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Plane)(plane).pipe(
      Effect.mapError(() => new OwnedApplicationError({ reason: "invalid-plane" })),
    );
    yield* validatePlaneIdentity(plane);
    yield* validateSessionOrigin(plane.callbackOrigin);
    yield* validateSessionOrigin(plane.cacheOrigin);
    if (plane.callbackOrigin === plane.cacheOrigin)
      return yield* fail("distinct-session-destinations-required");
    yield* validateResourceIdentifiers(plane.resources);
    yield* validateForwardMigrations(plane.artifacts.migrations);
  });

type InventoryObject = ApplicationInventory["objects"][number];
const isReservedSlot = (resources: readonly ApplicationResource[], name: string) =>
  /^[a-z0-9_]{1,63}$/.test(name) &&
  resources.some(
    (resource) =>
      (resource.kind === "slot" && resource.name === name) ||
      (resource.kind === "slot-prefix" && name.startsWith(resource.name)),
  );
const isReservedObject = (resources: readonly ApplicationResource[], object: InventoryObject) =>
  Match.value(object.kind).pipe(
    Match.when("slot", () => isReservedSlot(resources, object.name)),
    Match.orElse((kind) =>
      resources.some(
        (resource) =>
          resource.kind !== "slot-prefix" &&
          resource.kind === kind &&
          resource.name === object.name,
      ),
    ),
  );

const verifyInventoryOwner = (plane: OwnedApplicationPlane, inventory: ApplicationInventory) =>
  inventory.server !== plane.server ||
  inventory.database !== plane.database ||
  inventory.app !== plane.app ||
  inventory.ownerToken !== plane.ownerToken
    ? fail("inventory-owner-mismatch")
    : Effect.void;

const verifyInventoryObject = (plane: OwnedApplicationPlane, object: InventoryObject) =>
  !isReservedObject(plane.resources, object) ||
  object.ownerToken !== plane.ownerToken ||
  object.database !== plane.database ||
  object.active
    ? fail("resource-ownership-unproved")
    : Effect.void;

const verifyInventory = (plane: OwnedApplicationPlane, inventory: ApplicationInventory) =>
  Effect.gen(function* () {
    yield* verifyInventoryOwner(plane, inventory);
    if (!inventory.operationsTerminal || !inventory.writersTerminated)
      return yield* fail("termination-unproved");
    for (const object of inventory.objects) yield* verifyInventoryObject(plane, object);
  });

const verifyMeasuredDemands = (provider: OwnedApplicationProvider) =>
  Effect.gen(function* () {
    const invalidDemand = provider.demands.some(
      (demand) =>
        demand.provider !== provider.provider ||
        demand.identity !== provider.server ||
        !Number.isFinite(demand.amount) ||
        demand.amount <= 0,
    );
    const missingDimension = previewCapacityDimensionsByGroup["application-zero"].some(
      (dimension) => !provider.demands.some((demand) => demand.dimension === dimension),
    );
    if (invalidDemand || missingDimension) return yield* fail("incomplete-measured-demand");
    if (
      !provider.demands.some(
        (demand) => demand.dimension === "postgres.databases.count" && demand.amount >= 1,
      )
    )
      return yield* fail("scoped-database-capacity-required");
    if (
      !provider.demands.some(
        (demand) => demand.dimension === "postgres.roles.count" && demand.amount >= 3,
      )
    )
      return yield* fail("scoped-role-capacity-required");
  });

const verifyAdmissionIdentity = (plane: OwnedApplicationPlane, evidence: ApplicationAdmission) =>
  Effect.gen(function* () {
    if (evidence.planeDigest !== digest(plane))
      return yield* fail("admission-state-identity-mismatch");
    if (
      evidence.server !== plane.server ||
      !evidence.development ||
      evidence.sharedDatabases.includes(plane.database)
    )
      return yield* fail("owned-development-database-required");
  });

const verifyEvidenceFreshness = (observedAt: number, now: () => number, maxAge: number) =>
  !Number.isFinite(observedAt) || observedAt > now() || now() - observedAt > maxAge
    ? fail("stale-admission-evidence")
    : Effect.void;

const verifyAdmissionContracts = (plane: OwnedApplicationPlane, evidence: ApplicationAdmission) =>
  Effect.gen(function* () {
    if (
      !evidence.scopedCredentials ||
      requiredApplicationGrants.some((grant) => !evidence.grants.includes(grant))
    )
      return yield* fail("postgres-grants-unverified");
    if (!evidence.namesAvailable) return yield* fail("provider-name-collision");
    if (digest(evidence.artifacts) !== digest(plane.artifacts))
      return yield* fail("artifact-compatibility-mismatch");
  });

/** Captures the controller SQL service. Its durable journal survives launcher/workspace loss. */
export const makeOwnedApplicationResourceAdapter = (
  base: PreviewResourceAdapter,
  provider: OwnedApplicationProvider,
  options: {
    readonly profile: string;
    readonly artifacts: ApplicationArtifacts;
    readonly destinations: (sessionId: string) => {
      readonly callbackOrigin: string;
      readonly cacheOrigin: string;
    };
    readonly now?: () => number;
    readonly maximumEvidenceAgeMs?: number;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = options.now ?? Date.now;
    const maxAge = options.maximumEvidenceAgeMs ?? 60_000;
    if (!Number.isSafeInteger(maxAge) || maxAge <= 0) return yield* fail("invalid-evidence-age");
    yield* sql`CREATE TABLE IF NOT EXISTS preview_application_planes (
    session_id TEXT PRIMARY KEY, owner_token TEXT NOT NULL, plane TEXT NOT NULL,
    phase TEXT NOT NULL, released INTEGER NOT NULL DEFAULT 0
  )`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_application_names (
    server TEXT NOT NULL, namespace TEXT NOT NULL, name TEXT NOT NULL,
    session_id TEXT NOT NULL, PRIMARY KEY(server, namespace, name)
  )`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_application_seed_receipts (
    session_id TEXT PRIMARY KEY, owner_token TEXT NOT NULL, seed_id TEXT NOT NULL,
    seed_identity TEXT, status TEXT NOT NULL
  )`;
    const dbError = () => new OwnedApplicationError({ reason: "plane-journal-unavailable" });
    const load = (sessionId: string, ownerToken: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT plane, phase, released FROM preview_application_planes WHERE session_id=${sessionId} AND owner_token=${ownerToken}`.pipe(
            Effect.mapError(dbError),
          );
        const row = rows[0];
        if (row === undefined) return yield* fail("unknown-plane-owner");
        const plane = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Plane))(
          String(row.plane),
        ).pipe(
          Effect.mapError(
            () => new OwnedApplicationError({ reason: "invalid-plane-journal-record" }),
          ),
        );
        const phase = yield* Schema.decodeUnknownEffect(LifecyclePhase)(row.phase).pipe(
          Effect.mapError(
            () => new OwnedApplicationError({ reason: "invalid-plane-journal-record" }),
          ),
        );
        return { plane, phase, released: Number(row.released) === 1 };
      });
    const inspectAdmission = (plane: OwnedApplicationPlane) =>
      Effect.gen(function* () {
        yield* validatePlane(plane);
        yield* verifyMeasuredDemands(provider);
        const evidence = yield* provider.inspectAdmission(plane);
        yield* verifyAdmissionIdentity(plane, evidence);
        yield* verifyEvidenceFreshness(evidence.observedAt, now, maxAge);
        yield* verifyAdmissionContracts(plane, evidence);
      });
    const reserve = (plane: OwnedApplicationPlane, seedId: string | undefined) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* assertSession(plane.sessionId);
            yield* sql`INSERT INTO preview_application_planes(session_id, owner_token, plane, phase) VALUES (${plane.sessionId}, ${plane.ownerToken}, ${JSON.stringify(plane)}, 'reserved')`;
            if (seedId !== undefined) {
              yield* sql`INSERT INTO preview_application_seed_receipts(session_id, owner_token, seed_id, status) VALUES (${plane.sessionId}, ${plane.ownerToken}, ${seedId}, 'pending')`;
            }
            // Schemas/legacy names are reserved across the entire server, not just this database.
            for (const resource of [
              { kind: "app", name: plane.app },
              { kind: "endpoint", name: plane.callbackOrigin },
              { kind: "endpoint", name: plane.cacheOrigin },
              { kind: "client", name: plane.storageKey },
              ...plane.resources,
            ]) {
              const namespace =
                resource.kind === "publication" && resource.name === "zero_data"
                  ? `${plane.database}/publication`
                  : resource.kind;
              yield* sql`INSERT INTO preview_application_names(server, namespace, name, session_id) VALUES (${plane.server}, ${namespace}, ${resource.name}, ${plane.sessionId})`;
            }
          }),
        )
        .pipe(Effect.catchTag("SqlError", () => fail("resource-reservation-conflict")));
    // Late replies may arrive after recovery has claimed or released this plane.
    // Failure finalizers only quarantine the lifecycle operation they still own.
    const quarantineAllocation = (plane: OwnedApplicationPlane) =>
      sql`UPDATE preview_application_planes SET phase='quarantined' WHERE session_id=${plane.sessionId} AND owner_token=${plane.ownerToken} AND released=0 AND phase IN ('reserved','provisioning','migrating','starting')`.pipe(
        Effect.asVoid,
        Effect.mapError(dbError),
      );
    const quarantineCleanup = (plane: OwnedApplicationPlane) =>
      sql`UPDATE preview_application_planes SET phase='quarantined' WHERE session_id=${plane.sessionId} AND owner_token=${plane.ownerToken} AND released=0 AND phase='deleting'`.pipe(
        Effect.asVoid,
        Effect.mapError(dbError),
      );
    const updatePhaseIfCurrent = (
      plane: OwnedApplicationPlane,
      current: LifecyclePhase,
      next: LifecyclePhase,
    ) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE preview_application_planes SET phase=${next} WHERE session_id=${plane.sessionId} AND owner_token=${plane.ownerToken} AND released=0 AND phase=${current} RETURNING session_id`.pipe(
            Effect.mapError(dbError),
          );
        if (rows.length !== 1) return yield* fail("plane-resolution-raced");
      });
    const claimPlaneResolution = (record: {
      readonly plane: OwnedApplicationPlane;
      readonly phase: LifecyclePhase;
      readonly released: boolean;
    }) =>
      Effect.gen(function* () {
        if (record.released || !resolutionEligiblePlanePhases.has(record.phase))
          return yield* fail("plane-resolution-not-terminal");
        const endedSession =
          yield* sql`SELECT id FROM preview_sessions WHERE id=${record.plane.sessionId} AND ended_at IS NOT NULL`.pipe(
            Effect.mapError(dbError),
          );
        if (endedSession.length !== 1) return yield* fail("resolution-requires-ended-session");
        const claimed =
          yield* sql`UPDATE preview_application_planes SET phase='resolving' WHERE session_id=${record.plane.sessionId} AND owner_token=${record.plane.ownerToken} AND released=0 AND phase=${record.phase} AND EXISTS (SELECT 1 FROM preview_sessions WHERE id=${record.plane.sessionId} AND ended_at IS NOT NULL) RETURNING session_id`.pipe(
            Effect.mapError(dbError),
          );
        if (claimed.length !== 1) return yield* fail("plane-resolution-raced");
      });
    const assertSession = (sessionId: string) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT manifests FROM preview_sessions WHERE id=${sessionId} AND phase='pending' AND generation=1 AND ended_at IS NULL AND lease_deadline > ${now()}`.pipe(
            Effect.mapError(dbError),
          );
        if (rows.length !== 1) return yield* fail("session-not-pending");
        const manifests = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
        )(String(rows[0]!.manifests)).pipe(Effect.mapError(dbError));
        if (
          manifests["application-zero"] !== digest(options.artifacts) ||
          manifests["deployed-manifest"] !== options.artifacts.deployment
        )
          return yield* fail("session-artifacts-mismatch");
      });
    const applySelectedSeed = (
      plane: OwnedApplicationPlane,
      sessionId: string,
      seedId: string | undefined,
      seedOperations: SelectedSeedOperations | undefined,
    ) =>
      Effect.gen(function* () {
        if (seedId === undefined) return;
        if (seedOperations === undefined) return yield* fail("synthetic-seed-provider-unavailable");
        yield* assertSession(sessionId);
        const bindings = yield* seedOperations.resolveSeedBindings(plane, seedId);
        const seed = yield* makeSyntheticDevelopmentSeed(seedId, bindings);
        yield* assertSession(sessionId);
        const receipt = yield* seedOperations.applySeed(plane, seed);
        if (receipt.identity !== seed.identity)
          return yield* fail("synthetic-seed-identity-mismatch");
        const completed =
          yield* sql`UPDATE preview_application_seed_receipts SET seed_identity=${seed.identity}, status='complete' WHERE session_id=${sessionId} AND owner_token=${plane.ownerToken} AND seed_id=${seedId} AND status='pending' RETURNING session_id`.pipe(
            Effect.mapError(dbError),
          );
        if (completed.length !== 1) return yield* fail("synthetic-seed-journal-conflict");
      });
    const allocate = (
      sessionId: string,
      ownerToken: string,
      metadata: PreviewResourceMetadata | undefined,
    ) =>
      Effect.gen(function* () {
        if (metadata?.seedId !== undefined && typeof metadata.seedId !== "string")
          return yield* fail("unsupported-synthetic-seed");
        const seedId = typeof metadata?.seedId === "string" ? metadata.seedId : undefined;
        const seedOperations = yield* selectSeedOperations(seedId, provider);
        yield* assertSession(sessionId);
        const ledger =
          yield* sql`SELECT owner_token FROM preview_allocation_ledger WHERE session_id=${sessionId} AND resource=${ownedApplicationResource} AND owner_token=${ownerToken} AND state='allocating'`.pipe(
            Effect.mapError(dbError),
          );
        if (ledger.length !== 1) return yield* fail("allocation-ledger-owner-required");
        const capacity =
          yield* sql`SELECT dimension, amount FROM preview_capacity_reservations WHERE session_id=${sessionId} AND provider=${provider.provider} AND provider_identity=${provider.server} AND released_at IS NULL`.pipe(
            Effect.mapError(dbError),
          );
        if (
          provider.demands.some(
            (d) =>
              !capacity.some((r) => r.dimension === d.dimension && Number(r.amount) >= d.amount),
          )
        )
          return yield* fail("capacity-reservation-required");
        const plane = applicationPlaneIdentity({
          sessionId,
          ownerToken,
          server: provider.server,
          generation: 1,
          ...options.destinations(sessionId),
          artifacts: options.artifacts,
        });
        yield* inspectAdmission(plane);
        yield* reserve(plane, seedId);
        const work = Effect.gen(function* () {
          yield* updatePhaseIfCurrent(plane, "reserved", "provisioning");
          yield* assertSession(sessionId);
          yield* provider.provision(plane);
          yield* updatePhaseIfCurrent(plane, "provisioning", "migrating");
          yield* assertSession(sessionId);
          const applied = yield* provider.migrate(plane);
          if (digest(applied) !== digest(plane.artifacts))
            return yield* fail("applied-artifacts-mismatch");
          yield* applySelectedSeed(plane, sessionId, seedId, seedOperations);
          yield* updatePhaseIfCurrent(plane, "migrating", "starting");
          yield* assertSession(sessionId);
          yield* provider.start(plane, applicationRuntimeConfiguration(plane));
          const ready = yield* provider.ready(plane);
          const expected: ApplicationEndpointEvidence = {
            sessionId,
            generation: plane.generation,
            database: plane.database,
            app: plane.app,
            callbackOrigin: plane.callbackOrigin,
            cacheOrigin: plane.cacheOrigin,
            storageKey: plane.storageKey,
            artifacts: plane.artifacts,
          };
          if (digest(ready) !== digest(expected))
            return yield* fail("session-endpoint-identity-mismatch");
          yield* assertSession(sessionId);
          yield* updatePhaseIfCurrent(plane, "starting", "ready");
          return seedId === undefined
            ? `owned-application:${sessionId}`
            : `owned-application:${sessionId}:seed=${seedId};status=complete`;
        });
        return yield* work.pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? quarantineAllocation(plane) : Effect.void,
          ),
        );
      });
    const cleanup = (sessionId: string, ownerToken: string) =>
      Effect.gen(function* () {
        const record = yield* load(sessionId, ownerToken);
        if (record.released) return;
        const plane = record.plane;
        // Atomic claim; a crash leaves the plane quarantined until explicit provider resolution.
        const claimed =
          yield* sql`UPDATE preview_application_planes SET phase='deleting' WHERE session_id=${sessionId} AND owner_token=${ownerToken} AND released=0 AND phase IN ('ready','quarantined','fenced') RETURNING session_id`.pipe(
            Effect.mapError(dbError),
          );
        if (claimed.length !== 1) return yield* fail("plane-operation-in-progress");
        const work = Effect.gen(function* () {
          yield* provider.fence(plane);
          const inventory = yield* provider.inventory(plane);
          yield* verifyInventory(plane, inventory);
          const order: Record<ApplicationInventory["objects"][number]["kind"], number> = {
            slot: 0,
            trigger: 1,
            publication: 2,
            schema: 3,
            file: 4,
            volume: 5,
            grant: 6,
            database: 7,
            role: 8,
          };
          for (const object of [...inventory.objects].sort((a, b) => order[a.kind] - order[b.kind]))
            yield* provider.remove(plane, object);
          const after = yield* provider.inventory(plane);
          yield* verifyInventory(plane, after);
          if (after.objects.length !== 0) return yield* fail("release-not-proved");
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const released =
                  yield* sql`UPDATE preview_application_planes SET phase='deleted', released=1 WHERE session_id=${sessionId} AND owner_token=${ownerToken} AND released=0 AND phase='deleting' RETURNING session_id`;
                if (released.length !== 1) return yield* fail("plane-resolution-raced");
                yield* sql`DELETE FROM preview_application_names WHERE session_id=${sessionId} AND server=${plane.server}`;
              }),
            )
            .pipe(Effect.catchTag("SqlError", () => Effect.fail(dbError())));
        });
        yield* work.pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? quarantineCleanup(plane) : Effect.void,
          ),
        );
      });
    const verifiesProviderResourceId = (
      sessionId: string,
      ownerToken: string,
      providerResourceId: string,
    ) =>
      Effect.gen(function* () {
        if (providerResourceId === `owned-application:${sessionId}`) return true;
        const rows =
          yield* sql`SELECT seed_id, seed_identity FROM preview_application_seed_receipts WHERE session_id=${sessionId} AND owner_token=${ownerToken} AND status='complete'`.pipe(
            Effect.mapError(dbError),
          );
        return rows.some(
          (row) =>
            typeof row.seed_id === "string" &&
            row.seed_id === syntheticDevelopmentSeedId &&
            typeof row.seed_identity === "string" &&
            /^[a-f0-9]{64}$/.test(row.seed_identity) &&
            providerResourceId ===
              `owned-application:${sessionId}:seed=${row.seed_id};status=complete`,
        );
      });
    const adapter: PreviewResourceAdapter = {
      ...base,
      planProfile: (input) =>
        input.ownedGroups.includes(ownedApplicationResource)
          ? input.profile === options.profile &&
            input.ownedGroups.length === 1 &&
            input.selectedRoles.includes("sheet-db-server") &&
            input.selectedRoles.includes("sheet-web") &&
            input.selectedRoles.every((role) => ["sheet-db-server", "sheet-web"].includes(role))
            ? Effect.succeed({ demands: provider.demands, resources: [ownedApplicationResource] })
            : fail("unsupported-application-profile")
          : base.planProfile(input),
      validateProfileAllocation: (input) =>
        input.ownedGroups.includes(ownedApplicationResource)
          ? Effect.asVoid(adapter.planProfile(input))
          : base.validateProfileAllocation(input),
      allocate: (input) =>
        input.resource === ownedApplicationResource
          ? allocate(input.sessionId, input.ownerToken, input.metadata)
          : base.allocate(input),
      deleteOwned: (input) =>
        input.resource === ownedApplicationResource
          ? verifiesProviderResourceId(
              input.sessionId,
              input.ownerToken,
              input.providerResourceId,
            ).pipe(
              Effect.flatMap((valid) =>
                valid
                  ? cleanup(input.sessionId, input.ownerToken)
                  : fail("plane-reference-mismatch"),
              ),
            )
          : base.deleteOwned(input),
      proveCleanup: (input) =>
        Effect.gen(function* () {
          for (const resource of input.resources.filter(
            (r) => r.resource === ownedApplicationResource,
          )) {
            if (
              !(yield* verifiesProviderResourceId(
                input.sessionId,
                resource.ownerToken,
                resource.providerResourceId ?? "",
              ))
            )
              return false;
            const record = yield* load(input.sessionId, resource.ownerToken);
            if (!["ready", "quarantined", "fenced", "deleted"].includes(record.phase)) return false;
          }
          return yield* base.proveCleanup({
            ...input,
            resources: input.resources.filter((r) => r.resource !== ownedApplicationResource),
          });
        }),
      resolveUnknown: (input) =>
        input.resource !== ownedApplicationResource
          ? (base.resolveUnknown?.(input) ?? fail("unknown-resource"))
          : Effect.gen(function* () {
              const records =
                yield* sql`SELECT owner_token FROM preview_application_planes WHERE session_id=${input.sessionId}`.pipe(
                  Effect.mapError(dbError),
                );
              if (records.length === 0) {
                const ended =
                  yield* sql`SELECT id FROM preview_sessions WHERE id=${input.sessionId} AND ended_at IS NOT NULL`.pipe(
                    Effect.mapError(dbError),
                  );
                if (ended.length !== 1) return yield* fail("resolution-requires-ended-session");
                return {
                  ...input,
                  provider: provider.provider,
                  identity: provider.server,
                  verifiedAt: now(),
                  allocationSettled: true,
                  result: { status: "absent" as const },
                };
              }
              const record = yield* load(input.sessionId, input.ownerToken);
              if (
                !input.providerIdentities.some(
                  (i) => i.provider === provider.provider && i.identity === provider.server,
                )
              )
                return yield* fail("resolution-provider-mismatch");
              yield* claimPlaneResolution(record);
              const resolution = Effect.gen(function* () {
                yield* provider.fence(record.plane);
                yield* verifyInventory(record.plane, yield* provider.inventory(record.plane));
                yield* updatePhaseIfCurrent(record.plane, "resolving", "fenced");
              });
              yield* resolution.pipe(
                Effect.onExit((exit) =>
                  exit._tag === "Failure"
                    ? updatePhaseIfCurrent(record.plane, "resolving", "quarantined")
                    : Effect.void,
                ),
              );
              return {
                ...input,
                provider: provider.provider,
                identity: provider.server,
                verifiedAt: now(),
                allocationSettled: true,
                result: {
                  status: "found" as const,
                  providerResourceId: `owned-application:${input.sessionId}`,
                },
              };
            }),
    };
    return adapter;
  });
