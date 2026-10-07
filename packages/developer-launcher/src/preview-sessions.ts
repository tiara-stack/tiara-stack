import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Context, Duration, Effect, Layer, Match, Schema, Scope } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import {
  connectedPreviewGroups,
  connectedPreviewRoles,
  type ConnectedPreviewGroup,
  type ConnectedPreviewRole,
} from "./types";

export const previewSessionLeaseMs = 120_000;
export const previewSessionHeartbeatMs = 15_000;
export const previewSupervisorLeaseMs = 30_000;
const previewCredentialIssueReservationMs = 10 * 60_000;

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
  groups: Schema.optionalKey(Schema.Array(Schema.Literals(connectedPreviewGroups))),
  endpoints: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  targets: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});
export const SessionCredentialsSchema = Schema.Struct({
  ownerIdentity: Schema.String,
  supervisorIdentity: Schema.String,
});
export const PreviewWorkloadAdmissionSchema = Schema.Struct({
  admissionId: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  generation: Schema.Number.check(Schema.isGreaterThan(0)),
  role: Schema.Literals(connectedPreviewRoles),
  oauthClientId: Schema.NonEmptyString,
  groupId: Schema.NonEmptyString,
  invocationId: Schema.NonEmptyString,
  continuationId: Schema.NullOr(Schema.NonEmptyString),
  endpoint: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
});
export type PreviewWorkloadAdmission = typeof PreviewWorkloadAdmissionSchema.Type;

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
  Schema.TaggedStruct("AuthorizeCredential", {
    id: Schema.String,
    generation: Schema.Number,
    role: Schema.Literals(connectedPreviewRoles),
  }),
  Schema.TaggedStruct("AuthorizeWorkload", {
    id: Schema.String,
    generation: Schema.Number,
    role: Schema.Literals(connectedPreviewRoles),
    oauthClientId: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("ClientRequiresPreviewBinding", { oauthClientId: Schema.NonEmptyString }),
  Schema.TaggedStruct("AdmitWorkload", {
    sessionId: Schema.NonEmptyString,
    generation: Schema.Number.check(Schema.isGreaterThan(0)),
    role: Schema.Literals(connectedPreviewRoles),
    oauthClientId: Schema.NonEmptyString,
    groupId: Schema.NonEmptyString,
    invocationId: Schema.NonEmptyString,
    continuationId: Schema.NullOr(Schema.NonEmptyString),
    endpoint: Schema.NonEmptyString,
    target: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("SettleWorkload", { admission: PreviewWorkloadAdmissionSchema }),
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
  Schema.TaggedStruct("CredentialAuthorized", { session: PreviewSessionSchema }),
  Schema.TaggedStruct("WorkloadAuthorized", { session: PreviewSessionSchema }),
  Schema.TaggedStruct("PreviewClientBindingRequired", { required: Schema.Boolean }),
  Schema.TaggedStruct("WorkloadAdmitted", { admission: PreviewWorkloadAdmissionSchema }),
  Schema.TaggedStruct("WorkloadSettled", { admissionId: Schema.NonEmptyString }),
]);
export type PreviewSessionProtocolResponse = typeof PreviewSessionProtocolResponse.Type;

export type CreatePreviewSession = {
  readonly owner: string;
  readonly checkout: string;
  readonly manifests: Readonly<Record<string, string>>;
  readonly requestedRevision: string;
  readonly groups?: readonly ConnectedPreviewGroup[];
  readonly endpoints?: readonly string[];
  readonly targets?: readonly string[];
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
  /** Scoped local transport fences. Remote gateways require a verified revocation adapter. */
  readonly watchFences: (
    id: string,
    fence: Effect.Effect<void>,
  ) => Effect.Effect<void, never, Scope.Scope>;
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
  readonly authorizeCredential: (
    id: string,
    generation: number,
    role: ConnectedPreviewRole,
  ) => Effect.Effect<PreviewSession, ControllerError>;
  readonly authorizeCredentialIssue: (
    id: string,
    generation: number,
    role: ConnectedPreviewRole,
  ) => Effect.Effect<
    { readonly session: PreviewSession; readonly reservationId: string },
    ControllerError
  >;
  readonly releaseCredentialIssue: (input: {
    readonly id: string;
    readonly generation: number;
    readonly role: ConnectedPreviewRole;
    readonly reservationId: string;
  }) => Effect.Effect<void, ControllerError>;
  readonly registerCredentialIdentity: (input: {
    readonly id: string;
    readonly generation: number;
    readonly role: ConnectedPreviewRole;
    readonly reservationId: string;
    readonly credentialName: string;
    readonly serviceAccount: string;
    readonly oauthClientId: string;
    readonly credentialFile: string;
  }) => Effect.Effect<void, ControllerError>;
  readonly authorizeWorkload: (
    id: string,
    generation: number,
    role: ConnectedPreviewRole,
    oauthClientId: string,
  ) => Effect.Effect<PreviewSession, ControllerError>;
  readonly isPreviewOAuthClient: (oauthClientId: string) => Effect.Effect<boolean, ControllerError>;
  readonly authorizeCredentialRemoval: (input: {
    readonly id: string;
    readonly generation: number;
    readonly role: ConnectedPreviewRole;
    readonly oauthClientId: string;
    readonly serviceAccount: string;
  }) => Effect.Effect<void, ControllerError>;
  readonly removeCredentialIdentity: (input: {
    readonly id: string;
    readonly generation: number;
    readonly role: ConnectedPreviewRole;
    readonly oauthClientId: string;
    readonly serviceAccount: string;
  }) => Effect.Effect<void, ControllerError>;
  readonly isCredentialIdentityRegistered: (
    id: string,
    generation: number,
    role: ConnectedPreviewRole,
  ) => Effect.Effect<boolean, ControllerError>;
  readonly admitWorkload: (
    input: Omit<PreviewWorkloadAdmission, "admissionId">,
  ) => Effect.Effect<PreviewWorkloadAdmission, ControllerError>;
  readonly settleWorkload: (
    admission: PreviewWorkloadAdmission,
  ) => Effect.Effect<void, ControllerError>;
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
    Match.tag("AuthorizeCredential", ({ id, generation, role }) =>
      Effect.map(controller.authorizeCredential(id, generation, role), (session) => ({
        _tag: "CredentialAuthorized" as const,
        session,
      })),
    ),
    Match.tag("AuthorizeWorkload", ({ id, generation, role, oauthClientId }) =>
      Effect.map(controller.authorizeWorkload(id, generation, role, oauthClientId), (session) => ({
        _tag: "WorkloadAuthorized" as const,
        session,
      })),
    ),
    Match.tag("ClientRequiresPreviewBinding", ({ oauthClientId }) =>
      Effect.map(controller.isPreviewOAuthClient(oauthClientId), (required) => ({
        _tag: "PreviewClientBindingRequired" as const,
        required,
      })),
    ),
    Match.tag("AdmitWorkload", (input) =>
      Effect.map(controller.admitWorkload(input), (admission) => ({
        _tag: "WorkloadAdmitted" as const,
        admission,
      })),
    ),
    Match.tag("SettleWorkload", ({ admission }) =>
      Effect.map(controller.settleWorkload(admission), () => ({
        _tag: "WorkloadSettled" as const,
        admissionId: admission.admissionId,
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
  readonly authorizeCredential: PreviewSessionControllerApi["authorizeCredential"];
  readonly admitWorkload: PreviewSessionControllerApi["admitWorkload"];
  readonly settleWorkload: PreviewSessionControllerApi["settleWorkload"];
}

/** Narrow authority for runtime consumers: no create, heartbeat, resume, or stop operations. */
export class PreviewSessionRuntime extends Context.Service<
  PreviewSessionRuntime,
  PreviewSessionRuntimeApi
>()("developer-launcher/PreviewSessionRuntime") {}

export const digestIdentity = (identity: string) =>
  createHash("sha256").update(identity).digest("hex");
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
    const fences = new Map<string, Set<Effect.Effect<void>>>();
    const fenceSession = (id: string) =>
      Effect.forEach([...(fences.get(id) ?? [])], (fence) => Effect.forkDetach(fence), {
        discard: true,
        concurrency: "unbounded",
      });
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
    yield* sql`
      CREATE TABLE IF NOT EXISTS preview_session_workload_identities (
        session_id TEXT NOT NULL REFERENCES preview_sessions(id),
        generation INTEGER NOT NULL,
        role TEXT NOT NULL,
        credential_name TEXT NOT NULL,
        service_account TEXT NOT NULL,
        oauth_client_id TEXT NOT NULL,
        credential_file TEXT NOT NULL,
        PRIMARY KEY (session_id, generation, role)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS preview_session_credential_issuances (
        session_id TEXT NOT NULL REFERENCES preview_sessions(id),
        generation INTEGER NOT NULL,
        role TEXT NOT NULL,
        reservation_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, generation, role)
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS preview_session_work_items (
        admission_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES preview_sessions(id),
        generation INTEGER NOT NULL,
        role TEXT NOT NULL,
        oauth_client_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        continuation_id TEXT,
        endpoint TEXT NOT NULL,
        target TEXT NOT NULL,
        settled_at INTEGER
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS preview_session_allowed_work (
        session_id TEXT NOT NULL REFERENCES preview_sessions(id),
        kind TEXT NOT NULL CHECK (kind IN ('group','endpoint','target')),
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, kind, value)
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
        yield* fenceSession(id);
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

    const requireActiveWorkloadSession = (id: string, generation: number, time: number) =>
      Effect.gen(function* () {
        const session = yield* valid(id, undefined, generation);
        if (session.phase !== "active" || session.leaseDeadline <= time)
          return yield* Effect.fail(sessionError("session-not-active-or-expired"));
      });
    const authorizeSelectedCredential = (
      id: string,
      generation: number,
      role: ConnectedPreviewRole,
    ) =>
      Effect.gen(function* () {
        const session = yield* valid(id, undefined, generation);
        if (session.manifests[role] === undefined)
          return yield* Effect.fail(sessionError("role-not-selected"));
        return session;
      });
    const requireWorkloadIdentity = (input: Omit<PreviewWorkloadAdmission, "admissionId">) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT oauth_client_id FROM preview_session_workload_identities WHERE session_id=${input.sessionId} AND generation=${input.generation} AND role=${input.role}`;
        if (rows.length !== 1 || rows[0]?.oauth_client_id !== input.oauthClientId)
          return yield* Effect.fail(sessionError("workload-identity-mismatch"));
      });
    const requireAllowedWork = (input: Omit<PreviewWorkloadAdmission, "admissionId">) =>
      Effect.gen(function* () {
        for (const [kind, value] of [
          ["group", input.groupId],
          ["endpoint", input.endpoint],
          ["target", input.target],
        ] as const) {
          const rows =
            yield* sql`SELECT value FROM preview_session_allowed_work WHERE session_id=${input.sessionId} AND kind=${kind} AND value=${value}`;
          if (rows.length !== 1) return yield* Effect.fail(sessionError(`unapproved-work-${kind}`));
        }
      });
    const requireOriginalContinuation = (input: Omit<PreviewWorkloadAdmission, "admissionId">) =>
      Effect.gen(function* () {
        if (input.continuationId === null) return;
        const rows =
          yield* sql`SELECT admission_id FROM preview_session_work_items WHERE admission_id=${input.continuationId} AND session_id=${input.sessionId} AND generation=${input.generation} AND role=${input.role} AND oauth_client_id=${input.oauthClientId} AND group_id=${input.groupId} AND invocation_id=${input.invocationId} AND endpoint=${input.endpoint} AND target=${input.target}`;
        if (rows.length !== 1)
          return yield* Effect.fail(sessionError("continuation-not-bound-to-original-work"));
      });
    const reserveWorkloadAdmission = (
      input: Omit<PreviewWorkloadAdmission, "admissionId">,
      time: number,
    ) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE preview_sessions SET unsettled=unsettled+1 WHERE id=${input.sessionId} AND generation=${input.generation} AND phase='active' AND ended_at IS NULL AND lease_deadline > ${time} RETURNING id`;
        if (rows.length !== 1)
          return yield* Effect.fail(sessionError("session-not-active-or-expired"));
      });

    const api: PreviewSessionControllerApi = {
      watchFences: (id, fence) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listeners = fences.get(id) ?? new Set<Effect.Effect<void>>();
            listeners.add(fence);
            fences.set(id, listeners);
          }),
          () =>
            Effect.sync(() => {
              const listeners = fences.get(id);
              listeners?.delete(fence);
              if (listeners?.size === 0) fences.delete(id);
            }),
        ),
      create: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const time = now();
            const id = randomUUID();
            const ownerIdentity = randomBytes(32).toString("base64url");
            const supervisorIdentity = randomBytes(32).toString("base64url");
            // Allocation IDs are written only after the allocation ledger confirms ownership.
            const resourceIds: Record<string, string> = {};
            yield* sql`INSERT INTO preview_sessions (id, owner, checkout, resource_ids, manifests, requested_revision, phase, generation, identity_digest, supervisor_identity_digest, lease_deadline, last_renewed_at, supervisor_lease_until) VALUES (${id}, ${input.owner}, ${input.checkout}, ${JSON.stringify(resourceIds)}, ${JSON.stringify(input.manifests)}, ${input.requestedRevision}, 'pending', 1, ${digestIdentity(ownerIdentity)}, ${digestIdentity(supervisorIdentity)}, ${time + previewSessionLeaseMs}, ${time}, ${time + previewSupervisorLeaseMs})`;
            for (const group of new Set(input.groups ?? []))
              yield* sql`INSERT INTO preview_session_allowed_work (session_id, kind, value) VALUES (${id}, 'group', ${group})`;
            for (const endpoint of new Set(input.endpoints ?? []))
              yield* sql`INSERT INTO preview_session_allowed_work (session_id, kind, value) VALUES (${id}, 'endpoint', ${endpoint})`;
            for (const target of new Set(input.targets ?? []))
              yield* sql`INSERT INTO preview_session_allowed_work (session_id, kind, value) VALUES (${id}, 'target', ${target})`;
            return { ownerIdentity, supervisorIdentity, session: yield* valid(id) };
          }),
        ),
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
          yield* fenceSession(id);
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
          if (current.endedAt !== null) {
            yield* fenceSession(id);
            return current;
          }
          const time = now();
          const rows =
            yield* sql`UPDATE preview_sessions SET phase='ended', supervisor_lease_until=0, ended_at=${time} WHERE id=${id} AND identity_digest=${digestIdentity(ownerIdentity)} AND ended_at IS NULL RETURNING *`;
          yield* fenceSession(id);
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
      authorizeCredential: (id, generation, role) =>
        authorizeSelectedCredential(id, generation, role),
      authorizeCredentialIssue: (id, generation, role) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const session = yield* authorizeSelectedCredential(id, generation, role);
            const time = now();
            const registered =
              yield* sql`SELECT 1 FROM preview_session_workload_identities WHERE session_id=${id} AND generation=${generation} AND role=${role}`;
            if (registered.length > 0)
              return yield* Effect.fail(sessionError("workload-identity-already-bound"));
            const reservationId = randomBytes(32).toString("base64url");
            const reserved =
              yield* sql`INSERT INTO preview_session_credential_issuances (session_id, generation, role, reservation_id, expires_at) VALUES (${id}, ${generation}, ${role}, ${reservationId}, ${time + previewCredentialIssueReservationMs}) ON CONFLICT(session_id, generation, role) DO UPDATE SET reservation_id=excluded.reservation_id, expires_at=excluded.expires_at WHERE preview_session_credential_issuances.expires_at <= ${time} RETURNING reservation_id`;
            if (reserved.length !== 1)
              return yield* Effect.fail(sessionError("workload-identity-issuance-in-progress"));
            return { session, reservationId };
          }),
        ),
      releaseCredentialIssue: ({ id, generation, role, reservationId }) =>
        sql`DELETE FROM preview_session_credential_issuances WHERE session_id=${id} AND generation=${generation} AND role=${role} AND reservation_id=${reservationId}`.pipe(
          Effect.asVoid,
        ),
      registerCredentialIdentity: ({
        id,
        generation,
        role,
        reservationId,
        credentialName,
        serviceAccount,
        oauthClientId,
        credentialFile,
      }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const session = yield* valid(id, undefined, generation);
            if (session.manifests[role] === undefined)
              return yield* Effect.fail(sessionError("role-not-selected"));
            const reservations =
              yield* sql`SELECT reservation_id FROM preview_session_credential_issuances WHERE session_id=${id} AND generation=${generation} AND role=${role} AND reservation_id=${reservationId} AND expires_at > ${now()}`;
            if (reservations.length !== 1)
              return yield* Effect.fail(sessionError("workload-identity-issuance-not-reserved"));
            const existing =
              yield* sql`SELECT credential_name, service_account, oauth_client_id, credential_file FROM preview_session_workload_identities WHERE session_id=${id} AND generation=${generation} AND role=${role}`;
            if (existing.length > 0) {
              const row = existing[0] as Record<string, unknown>;
              if (
                row.credential_name !== credentialName ||
                row.service_account !== serviceAccount ||
                row.oauth_client_id !== oauthClientId ||
                row.credential_file !== credentialFile
              )
                return yield* Effect.fail(sessionError("workload-identity-already-bound"));
              yield* sql`DELETE FROM preview_session_credential_issuances WHERE session_id=${id} AND generation=${generation} AND role=${role} AND reservation_id=${reservationId}`;
              return;
            }
            yield* sql`INSERT INTO preview_session_workload_identities (session_id, generation, role, credential_name, service_account, oauth_client_id, credential_file) VALUES (${id}, ${generation}, ${role}, ${credentialName}, ${serviceAccount}, ${oauthClientId}, ${credentialFile})`;
            yield* sql`DELETE FROM preview_session_credential_issuances WHERE session_id=${id} AND generation=${generation} AND role=${role} AND reservation_id=${reservationId}`;
          }),
        ),
      authorizeWorkload: (id, generation, role, oauthClientId) =>
        Effect.gen(function* () {
          const session = yield* valid(id, undefined, generation);
          const time = now();
          if (session.phase !== "active" || session.leaseDeadline <= time)
            return yield* Effect.fail(sessionError("session-not-active-or-expired"));
          const rows =
            yield* sql`SELECT oauth_client_id FROM preview_session_workload_identities WHERE session_id=${id} AND generation=${generation} AND role=${role}`;
          if (
            session.manifests[role] === undefined ||
            rows.length !== 1 ||
            rows[0]?.oauth_client_id !== oauthClientId
          )
            return yield* Effect.fail(sessionError("workload-identity-mismatch"));
          return session;
        }),
      isPreviewOAuthClient: (oauthClientId) =>
        Effect.map(
          sql`SELECT oauth_client_id FROM preview_session_workload_identities WHERE oauth_client_id=${oauthClientId} LIMIT 1`,
          (rows) => rows.length > 0,
        ),
      admitWorkload: (input) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const nowMs = now();
            yield* requireActiveWorkloadSession(input.sessionId, input.generation, nowMs);
            yield* requireWorkloadIdentity(input);
            yield* requireAllowedWork(input);
            yield* requireOriginalContinuation(input);
            yield* reserveWorkloadAdmission(input, nowMs);
            const admissionId = randomBytes(32).toString("base64url");
            yield* sql`INSERT INTO preview_session_work_items (admission_id, session_id, generation, role, oauth_client_id, group_id, invocation_id, continuation_id, endpoint, target) VALUES (${admissionId}, ${input.sessionId}, ${input.generation}, ${input.role}, ${input.oauthClientId}, ${input.groupId}, ${input.invocationId}, ${input.continuationId}, ${input.endpoint}, ${input.target})`;
            return { ...input, admissionId };
          }),
        ),
      settleWorkload: (admission) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const settled =
              yield* sql`UPDATE preview_session_work_items SET settled_at=${now()} WHERE admission_id=${admission.admissionId} AND session_id=${admission.sessionId} AND generation=${admission.generation} AND role=${admission.role} AND oauth_client_id=${admission.oauthClientId} AND group_id=${admission.groupId} AND invocation_id=${admission.invocationId} AND continuation_id IS ${admission.continuationId} AND endpoint=${admission.endpoint} AND target=${admission.target} AND settled_at IS NULL RETURNING session_id`;
            if (settled.length !== 1)
              return yield* Effect.fail(sessionError("settlement-authority-mismatch"));
            const decremented =
              yield* sql`UPDATE preview_sessions SET unsettled=unsettled-1 WHERE id=${admission.sessionId} AND unsettled > 0 RETURNING id`;
            if (decremented.length !== 1)
              return yield* Effect.fail(sessionError("settlement-count-invariant-failed"));
          }),
        ),
      authorizeCredentialRemoval: ({ id, generation, role, oauthClientId, serviceAccount }) =>
        Effect.gen(function* () {
          const session = yield* valid(id, undefined, undefined, true);
          if (session.endedAt === null || session.unsettled !== 0)
            return yield* Effect.fail(
              sessionError("credential-removal-requires-ended-settled-session"),
            );
          const rows =
            yield* sql`SELECT oauth_client_id, service_account FROM preview_session_workload_identities WHERE session_id=${id} AND generation=${generation} AND role=${role}`;
          if (
            rows.length !== 1 ||
            rows[0]?.oauth_client_id !== oauthClientId ||
            rows[0]?.service_account !== serviceAccount
          )
            return yield* Effect.fail(sessionError("workload-identity-mismatch"));
        }),
      isCredentialIdentityRegistered: (id, generation, role) =>
        Effect.map(
          sql`SELECT 1 FROM preview_session_workload_identities WHERE session_id=${id} AND generation=${generation} AND role=${role}`,
          (rows) => rows.length > 0,
        ),
      removeCredentialIdentity: ({ id, generation, role, oauthClientId, serviceAccount }) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const ended =
              yield* sql`SELECT id FROM preview_sessions WHERE id=${id} AND ended_at IS NOT NULL AND unsettled=0`;
            if (ended.length === 0)
              return yield* Effect.fail(
                sessionError("credential-removal-requires-ended-settled-session"),
              );
            const rows =
              yield* sql`DELETE FROM preview_session_workload_identities WHERE session_id=${id} AND generation=${generation} AND role=${role} AND oauth_client_id=${oauthClientId} AND service_account=${serviceAccount} RETURNING session_id`;
            if (rows.length !== 1)
              return yield* Effect.fail(sessionError("workload-identity-mismatch"));
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

/** Promise adapter for sheet-auth's per-exchange and per-resource authorization port. */
export const makePreviewSessionAuthority = (
  controller: PreviewSessionControllerApi,
): {
  readonly requiresBinding: (oauthClientId: string) => Promise<boolean>;
  readonly authorize: (input: {
    readonly binding: {
      readonly sessionId: string;
      readonly generation: number;
      readonly role: string;
    };
    readonly clientId: string | undefined;
  }) => Promise<boolean>;
} => ({
  requiresBinding: async (oauthClientId) => {
    try {
      return await Effect.runPromise(
        dispatchPreviewSessionProtocol(controller, {
          _tag: "ClientRequiresPreviewBinding",
          oauthClientId,
        }).pipe(
          Effect.map(
            (response) => response._tag === "PreviewClientBindingRequired" && response.required,
          ),
        ),
      );
    } catch {
      return true;
    }
  },
  authorize: async ({ binding, clientId }) => {
    const role = connectedPreviewRoles.find((candidate) => candidate === binding.role);
    if (!clientId || !role) return false;
    try {
      const response = await Effect.runPromise(
        dispatchPreviewSessionProtocol(controller, {
          _tag: "AuthorizeWorkload",
          id: binding.sessionId,
          generation: binding.generation,
          role,
          oauthClientId: clientId,
        }),
      );
      return response._tag === "WorkloadAuthorized";
    } catch {
      return false;
    }
  },
});

export const PreviewSessionRuntimeLive = Layer.effect(
  PreviewSessionRuntime,
  Effect.map(
    PreviewSessionController,
    (controller): PreviewSessionRuntimeApi => ({
      admit: controller.admit,
      settle: controller.settle,
      authorizeCredential: controller.authorizeCredential,
      admitWorkload: controller.admitWorkload,
      settleWorkload: controller.settleWorkload,
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
