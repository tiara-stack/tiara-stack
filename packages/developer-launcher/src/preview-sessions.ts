import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Context, Duration, Effect, Layer, Match, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";

export const previewSessionLeaseMs = 120_000;
export const previewSessionHeartbeatMs = 15_000;
export const previewSupervisorLeaseMs = 30_000;

export const PreviewSessionPhase = Schema.Literals([
  "pending",
  "starting",
  "active",
  "stopping",
  "ended",
  "expired",
]);
export type PreviewSessionPhase = typeof PreviewSessionPhase.Type;

export const PreviewSessionSchema = Schema.Struct({
  id: Schema.String,
  owner: Schema.String,
  checkout: Schema.String,
  resources: Schema.Record(Schema.String, Schema.String),
  manifests: Schema.Record(Schema.String, Schema.String),
  requestedRevision: Schema.String,
  activeRevision: Schema.NullOr(Schema.String),
  phase: PreviewSessionPhase,
  generation: Schema.Number,
  leaseDeadline: Schema.Number,
  lastRenewedAt: Schema.Number,
  unsettled: Schema.Number,
  endedAt: Schema.NullOr(Schema.Number),
});
export type PreviewSession = typeof PreviewSessionSchema.Type;

export const CreatePreviewSessionSchema = Schema.Struct({
  owner: Schema.String,
  checkout: Schema.String,
  manifests: Schema.Record(Schema.String, Schema.String),
  requestedRevision: Schema.String,
});
export const SessionCredentialsSchema = Schema.Struct({
  ownerIdentity: Schema.String,
  supervisorIdentity: Schema.String,
});

/** Typed messages shared by the embedded controller and future transport adapters. */
export const PreviewSessionProtocolRequest = Schema.Union([
  Schema.TaggedStruct("Create", { input: CreatePreviewSessionSchema }),
  Schema.TaggedStruct("Status", { id: Schema.String }),
  Schema.TaggedStruct("Heartbeat", {
    id: Schema.String,
    supervisorIdentity: Schema.String,
    generation: Schema.Number,
  }),
  Schema.TaggedStruct("Resume", { id: Schema.String, ownerIdentity: Schema.String }),
  Schema.TaggedStruct("Stop", { id: Schema.String, ownerIdentity: Schema.String }),
  Schema.TaggedStruct("Admit", { id: Schema.String, generation: Schema.Number }),
  Schema.TaggedStruct("Settle", { id: Schema.String, generation: Schema.Number }),
]);
export type PreviewSessionProtocolRequest = typeof PreviewSessionProtocolRequest.Type;
export const PreviewSessionProtocolResponse = Schema.Union([
  Schema.TaggedStruct("Created", {
    session: PreviewSessionSchema,
    ownerIdentity: Schema.String,
    supervisorIdentity: Schema.String,
  }),
  Schema.TaggedStruct("Session", { session: PreviewSessionSchema }),
  Schema.TaggedStruct("Resumed", {
    session: PreviewSessionSchema,
    supervisorIdentity: Schema.String,
  }),
  Schema.TaggedStruct("Settled", { id: Schema.String, generation: Schema.Number }),
]);
export type PreviewSessionProtocolResponse = typeof PreviewSessionProtocolResponse.Type;

export type CreatePreviewSession = {
  readonly owner: string;
  readonly checkout: string;
  readonly manifests: Readonly<Record<string, string>>;
  readonly requestedRevision: string;
};

export type SessionCredentials = {
  readonly session: PreviewSession;
  /** Owner proof authorizes resume and stop; never use it to renew a supervisor lease. */
  readonly ownerIdentity: string;
  /** Rotated on resume; only the matching generation can renew or activate. */
  readonly supervisorIdentity: string;
};

export type SupervisorCredentials = {
  readonly session: PreviewSession;
  readonly supervisorIdentity: string;
};

export class PreviewSessionError extends Schema.TaggedErrorClass<PreviewSessionError>()(
  "PreviewSessionError",
  { reason: Schema.String },
) {}

type ControllerError = PreviewSessionError | SqlError.SqlError;

export interface PreviewSessionControllerApi {
  readonly create: (
    input: CreatePreviewSession,
  ) => Effect.Effect<SessionCredentials, ControllerError>;
  readonly status: (id: string) => Effect.Effect<PreviewSession, ControllerError>;
  readonly heartbeat: (
    id: string,
    supervisorIdentity: string,
    generation: number,
  ) => Effect.Effect<PreviewSession, ControllerError>;
  readonly resume: (
    id: string,
    ownerIdentity: string,
  ) => Effect.Effect<SupervisorCredentials, ControllerError>;
  readonly activate: (
    id: string,
    generation: number,
    supervisorIdentity: string,
    activeRevision: string,
  ) => Effect.Effect<PreviewSession, ControllerError>;
  readonly stop: (
    id: string,
    ownerIdentity: string,
  ) => Effect.Effect<PreviewSession, ControllerError>;
  readonly admit: (
    id: string,
    generation: number,
  ) => Effect.Effect<PreviewSession, ControllerError>;
  readonly settle: (id: string, generation: number) => Effect.Effect<void, ControllerError>;
}

export const dispatchPreviewSessionProtocol = (
  controller: PreviewSessionControllerApi,
  input: unknown,
): Effect.Effect<PreviewSessionProtocolResponse, ControllerError> => {
  let request: PreviewSessionProtocolRequest;
  try {
    request = Schema.decodeUnknownSync(PreviewSessionProtocolRequest)(input);
  } catch {
    return Effect.fail(new PreviewSessionError({ reason: "invalid-protocol-message" }));
  }
  return Match.value(request).pipe(
    Match.tag("Create", ({ input }) =>
      Effect.map(controller.create(input), ({ session, ownerIdentity, supervisorIdentity }) => ({
        _tag: "Created" as const,
        session,
        ownerIdentity,
        supervisorIdentity,
      })),
    ),
    Match.tag("Status", ({ id }) =>
      Effect.map(controller.status(id), (session) => ({ _tag: "Session" as const, session })),
    ),
    Match.tag("Heartbeat", ({ id, supervisorIdentity, generation }) =>
      Effect.map(controller.heartbeat(id, supervisorIdentity, generation), (session) => ({
        _tag: "Session" as const,
        session,
      })),
    ),
    Match.tag("Resume", ({ id, ownerIdentity }) =>
      Effect.map(controller.resume(id, ownerIdentity), ({ session, supervisorIdentity }) => ({
        _tag: "Resumed" as const,
        session,
        supervisorIdentity,
      })),
    ),
    Match.tag("Stop", ({ id, ownerIdentity }) =>
      Effect.map(controller.stop(id, ownerIdentity), (session) => ({
        _tag: "Session" as const,
        session,
      })),
    ),
    Match.tag("Admit", ({ id, generation }) =>
      Effect.map(controller.admit(id, generation), (session) => ({
        _tag: "Session" as const,
        session,
      })),
    ),
    Match.tag("Settle", ({ id, generation }) =>
      Effect.map(controller.settle(id, generation), () => ({
        _tag: "Settled" as const,
        id,
        generation,
      })),
    ),
    Match.exhaustive,
  );
};

export class PreviewSessionController extends Context.Service<
  PreviewSessionController,
  PreviewSessionControllerApi
>()("developer-launcher/PreviewSessionController") {}

export interface PreviewSessionRuntimeApi {
  readonly admit: (
    id: string,
    generation: number,
  ) => Effect.Effect<PreviewSession, ControllerError>;
  readonly settle: (id: string, generation: number) => Effect.Effect<void, ControllerError>;
}

/** Narrow authority for runtime consumers: no create, heartbeat, resume, or stop operations. */
export class PreviewSessionRuntime extends Context.Service<
  PreviewSessionRuntime,
  PreviewSessionRuntimeApi
>()("developer-launcher/PreviewSessionRuntime") {}

const digestIdentity = (identity: string) => createHash("sha256").update(identity).digest("hex");
const sessionError = (reason: string) => new PreviewSessionError({ reason });

const decodeRow = (row: Record<string, unknown>): PreviewSession => ({
  id: String(row.id),
  owner: String(row.owner),
  checkout: String(row.checkout),
  resources: JSON.parse(String(row.resource_ids)) as Record<string, string>,
  manifests: JSON.parse(String(row.manifests)) as Record<string, string>,
  requestedRevision: String(row.requested_revision),
  activeRevision: typeof row.active_revision === "string" ? row.active_revision : null,
  phase: row.phase as PreviewSessionPhase,
  generation: Number(row.generation),
  leaseDeadline: Number(row.lease_deadline),
  lastRenewedAt: Number(row.last_renewed_at),
  unsettled: Number(row.unsettled),
  endedAt: row.ended_at === null ? null : Number(row.ended_at),
});

/** Durable authority store. The caller supplies time so lease boundaries are deterministic. */
export const makePreviewSessionController = (now: () => number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      CREATE TABLE IF NOT EXISTS preview_sessions (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        checkout TEXT NOT NULL,
        resource_ids TEXT NOT NULL,
        manifests TEXT NOT NULL,
        requested_revision TEXT NOT NULL,
        active_revision TEXT,
        phase TEXT NOT NULL CHECK (phase IN ('pending','starting','active','stopping','ended','expired')),
        generation INTEGER NOT NULL,
        identity_digest TEXT NOT NULL,
        supervisor_identity_digest TEXT NOT NULL DEFAULT '',
        lease_deadline INTEGER NOT NULL,
        last_renewed_at INTEGER NOT NULL,
        supervisor_lease_until INTEGER NOT NULL DEFAULT 0,
        ended_at INTEGER,
        unsettled INTEGER NOT NULL DEFAULT 0
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS preview_session_admissions (
        session_id TEXT NOT NULL REFERENCES preview_sessions(id),
        generation INTEGER NOT NULL,
        outstanding INTEGER NOT NULL,
        PRIMARY KEY (session_id, generation)
      )
    `;

    const find = (id: string) =>
      sql`SELECT * FROM preview_sessions WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0] as Record<string, unknown> | undefined),
      );
    const expireIfNeeded = (id: string, session: PreviewSession) =>
      Effect.gen(function* () {
        const time = now();
        if (session.endedAt !== null || session.leaseDeadline > time) return session;
        yield* sql`UPDATE preview_sessions SET phase='expired', ended_at=${time} WHERE id=${id} AND ended_at IS NULL AND lease_deadline <= ${time}`;
        return { ...session, phase: "expired" as const, endedAt: time };
      });
    const validateSessionAccess = (
      row: Record<string, unknown>,
      session: PreviewSession,
      identity?: string,
      generation?: number,
      allowEnded = false,
    ) =>
      Effect.gen(function* () {
        if (!allowEnded && session.endedAt !== null)
          return yield* Effect.fail(sessionError("session-ended"));
        if (identity !== undefined && digestIdentity(identity) !== row.identity_digest) {
          return yield* Effect.fail(sessionError("identity-mismatch"));
        }
        if (generation !== undefined && session.generation !== generation) {
          return yield* Effect.fail(sessionError("stale-supervisor"));
        }
        return session;
      });
    const valid = (id: string, identity?: string, generation?: number, allowEnded = false) =>
      Effect.gen(function* () {
        const row = yield* find(id);
        if (row === undefined) return yield* Effect.fail(sessionError("unknown-session"));
        const session = yield* expireIfNeeded(id, decodeRow(row));
        return yield* validateSessionAccess(row, session, identity, generation, allowEnded);
      });

    const api: PreviewSessionControllerApi = {
      create: (input) =>
        Effect.gen(function* () {
          const time = now();
          const id = randomUUID();
          const ownerIdentity = randomBytes(32).toString("base64url");
          const supervisorIdentity = randomBytes(32).toString("base64url");
          const resourceIds = Object.fromEntries(
            Object.keys(input.manifests).map((resource) => [resource, randomUUID()]),
          );
          yield* sql`INSERT INTO preview_sessions (id, owner, checkout, resource_ids, manifests, requested_revision, phase, generation, identity_digest, supervisor_identity_digest, lease_deadline, last_renewed_at, supervisor_lease_until) VALUES (${id}, ${input.owner}, ${input.checkout}, ${JSON.stringify(resourceIds)}, ${JSON.stringify(input.manifests)}, ${input.requestedRevision}, 'pending', 1, ${digestIdentity(ownerIdentity)}, ${digestIdentity(supervisorIdentity)}, ${time + previewSessionLeaseMs}, ${time}, ${time + previewSupervisorLeaseMs})`;
          return { ownerIdentity, supervisorIdentity, session: yield* valid(id) };
        }),
      status: (id) => valid(id, undefined, undefined, true),
      heartbeat: (id, supervisorIdentity, generation) =>
        Effect.gen(function* () {
          const current = yield* valid(id, undefined, generation);
          if (current.phase === "ended" || current.phase === "expired")
            return yield* Effect.fail(sessionError("session-ended"));
          const time = now();
          const rows =
            yield* sql`UPDATE preview_sessions SET lease_deadline=${time + previewSessionLeaseMs}, supervisor_lease_until=${time + previewSupervisorLeaseMs}, last_renewed_at=${time} WHERE id=${id} AND supervisor_identity_digest=${digestIdentity(supervisorIdentity)} AND generation=${generation} AND ended_at IS NULL AND lease_deadline > ${time} RETURNING *`;
          if (rows.length === 0) return yield* Effect.fail(sessionError("lease-expired-or-fenced"));
          return decodeRow(rows[0] as Record<string, unknown>);
        }),
      resume: (id, ownerIdentity) =>
        Effect.gen(function* () {
          const current = yield* valid(id, ownerIdentity);
          if (current.phase === "ended" || current.phase === "expired")
            return yield* Effect.fail(sessionError("session-ended"));
          const time = now();
          const currentRow = yield* find(id);
          if (currentRow === undefined) return yield* Effect.fail(sessionError("unknown-session"));
          if (Number(currentRow.supervisor_lease_until) > time)
            return yield* Effect.fail(sessionError("supervisor-already-active"));
          const supervisorIdentity = randomBytes(32).toString("base64url");
          // Incrementing the durable generation fences every write from the previous supervisor.
          const rows =
            yield* sql`UPDATE preview_sessions SET generation=generation+1, phase='pending', supervisor_identity_digest=${digestIdentity(supervisorIdentity)}, supervisor_lease_until=${time + previewSupervisorLeaseMs} WHERE id=${id} AND identity_digest=${digestIdentity(ownerIdentity)} AND generation=${current.generation} AND supervisor_lease_until <= ${time} AND ended_at IS NULL AND lease_deadline > ${time} RETURNING *`;
          if (rows.length === 0) return yield* Effect.fail(sessionError("resume-raced-or-expired"));
          return {
            session: decodeRow(rows[0] as Record<string, unknown>),
            supervisorIdentity,
          };
        }),
      activate: (id, generation, supervisorIdentity, activeRevision) =>
        Effect.gen(function* () {
          const current = yield* valid(id, undefined, generation);
          if (current.phase !== "pending" && current.phase !== "starting")
            return yield* Effect.fail(sessionError("invalid-lifecycle-transition"));
          const time = now();
          const rows =
            yield* sql`UPDATE preview_sessions SET phase='active', active_revision=${activeRevision}, supervisor_lease_until=${time + previewSupervisorLeaseMs} WHERE id=${id} AND supervisor_identity_digest=${digestIdentity(supervisorIdentity)} AND generation=${generation} AND phase IN ('pending','starting') AND ended_at IS NULL AND lease_deadline > ${time} RETURNING *`;
          if (rows.length === 0) return yield* Effect.fail(sessionError("stale-supervisor"));
          return decodeRow(rows[0] as Record<string, unknown>);
        }),
      stop: (id, ownerIdentity) =>
        Effect.gen(function* () {
          const current = yield* valid(id, ownerIdentity, undefined, true);
          if (current.endedAt !== null) return current;
          const time = now();
          const rows =
            yield* sql`UPDATE preview_sessions SET phase='ended', supervisor_lease_until=0, ended_at=${time} WHERE id=${id} AND identity_digest=${digestIdentity(ownerIdentity)} AND ended_at IS NULL RETURNING *`;
          if (rows.length === 0) return yield* valid(id, ownerIdentity, undefined, true);
          return decodeRow(rows[0] as Record<string, unknown>);
        }),
      admit: (id, generation) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* valid(id, undefined, generation);
            const time = now();
            const rows =
              yield* sql`UPDATE preview_sessions SET unsettled=unsettled+1 WHERE id=${id} AND generation=${generation} AND phase='active' AND ended_at IS NULL AND lease_deadline > ${time} RETURNING *`;
            if (rows.length === 0)
              return yield* Effect.fail(sessionError("session-not-active-or-expired"));
            yield* sql`INSERT INTO preview_session_admissions (session_id, generation, outstanding) VALUES (${id}, ${generation}, 1) ON CONFLICT(session_id, generation) DO UPDATE SET outstanding=outstanding+1`;
            return decodeRow(rows[0] as Record<string, unknown>);
          }),
        ),
      settle: (id, generation) =>
        sql.withTransaction(
          Effect.gen(function* () {
            // Accepted work can settle after closure so the session's outstanding count can drain.
            const admitted =
              yield* sql`UPDATE preview_session_admissions SET outstanding=outstanding-1 WHERE session_id=${id} AND generation=${generation} AND outstanding > 0 RETURNING session_id`;
            if (admitted.length === 0)
              return yield* Effect.fail(sessionError("no-settlement-authority"));
            yield* sql`UPDATE preview_sessions SET unsettled=unsettled-1 WHERE id=${id} AND unsettled > 0`;
          }),
        ),
    };
    return api;
  });

export const PreviewSessionControllerLive = (now: () => number) =>
  Layer.effect(PreviewSessionController, makePreviewSessionController(now));

export const PreviewSessionRuntimeLive = Layer.effect(
  PreviewSessionRuntime,
  Effect.map(
    PreviewSessionController,
    (controller): PreviewSessionRuntimeApi => ({
      admit: controller.admit,
      settle: controller.settle,
    }),
  ),
);

/** Supervisor loop. Fiber interruption cancels its future renewals. */
export const supervisePreviewSessionLease = (
  id: string,
  supervisorIdentity: string,
  generation: number,
) =>
  Effect.gen(function* () {
    const controller = yield* PreviewSessionController;
    while (true) {
      yield* Effect.sleep(Duration.millis(previewSessionHeartbeatMs));
      yield* controller.heartbeat(id, supervisorIdentity, generation);
    }
  });
