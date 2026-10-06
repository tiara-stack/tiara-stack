import { createHash } from "node:crypto";
import { Context, Deferred, Effect, Layer, Predicate, Schema, Scope } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Socket } from "effect/unstable/socket";
import {
  previewRelayHostRoles,
  relayNameFor,
  RelayResourceReferenceSchema,
} from "./preview-relay-provider";
import type { PreviewSession, PreviewSessionControllerApi } from "./preview-sessions";

const identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
export const PreviewGatewayTargetSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Schema.Literals(previewRelayHostRoles),
  processId: identifier,
  revision: identifier,
  stateGroup: identifier,
  serviceFqdn: identifier,
  serviceResourceId: identifier,
  attachmentResourceId: identifier,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  kind: Schema.Literal("disposable-probe"),
});
export type PreviewGatewayTarget = typeof PreviewGatewayTargetSchema.Type;
export const PreviewGatewayRouteSchema = Schema.Struct({
  hostname: identifier,
  target: PreviewGatewayTargetSchema,
});
export type PreviewGatewayRoute = typeof PreviewGatewayRouteSchema.Type;

export class PreviewGatewayError extends Schema.TaggedErrorClass<PreviewGatewayError>()(
  "PreviewGatewayError",
  {
    reason: Schema.Literals([
      "unavailable",
      "denied",
      "invalid-request",
      "identity-mismatch",
      "owner-mismatch",
      "route-conflict",
      "live-session",
      "unsupported",
    ]),
  },
) {}
const failure = (reason: PreviewGatewayError["reason"]) => new PreviewGatewayError({ reason });
const unavailable = () => failure("unavailable");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => failure("invalid-request")));

/** Result of independent gateway authentication, never an application token or routing header. */
export const PreviewGatewayPrincipalSchema = Schema.Struct({
  userId: identifier,
  sessionId: identifier,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Schema.Literals(previewRelayHostRoles),
  expiresAt: Schema.Finite,
});
export type PreviewGatewayPrincipal = typeof PreviewGatewayPrincipalSchema.Type;
export type PreviewGatewayRequest = {
  readonly hostname: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
};

/** The adapter must authenticate the relay and attest the process on this same connection.
 * An application-supplied identity header or an earlier health probe is insufficient.
 */
export interface PreviewGatewayRelayConnection {
  readonly identity: unknown;
  readonly connected: Effect.Effect<boolean, PreviewGatewayError>;
  readonly http: (
    headers: Readonly<Record<string, string>>,
  ) => Effect.Effect<string, PreviewGatewayError>;
  readonly socket: Effect.Effect<Socket.Socket, PreviewGatewayError, Scope.Scope>;
  readonly close: Effect.Effect<void>;
}
export const PreviewGatewaySetupSchema = Schema.Struct({
  domain: Schema.NonEmptyString,
  observedAt: Schema.Finite,
  wildcardDns: Schema.Literal(true),
  wildcardCertificate: Schema.Literal(true),
  independentGatewayAuthentication: Schema.Literal(true),
  singleControllerFenceDelivery: Schema.Literal(true),
});
export interface PreviewGatewayAdapters {
  /** Operator observation, not launcher configuration intent. Fail when unverifiable. */
  readonly checkSetup: Effect.Effect<typeof PreviewGatewaySetupSchema.Type, PreviewGatewayError>;
  readonly authenticate: (
    request: PreviewGatewayRequest,
  ) => Effect.Effect<PreviewGatewayPrincipal, PreviewGatewayError>;
  readonly connect: (
    target: PreviewGatewayTarget,
  ) => Effect.Effect<PreviewGatewayRelayConnection, PreviewGatewayError, Scope.Scope>;
}

/** Probe traffic uses a positive header list. Cookies, authorization, forwarding headers,
 * routing metadata, WebSocket subprotocol credentials and hop-by-hop fields never reach it.
 */
export const previewGatewayProbeHeaders = (headers: PreviewGatewayRequest["headers"]) => {
  const safe: Record<string, string> = {};
  for (const name of ["accept", "accept-language"]) {
    const value = headers[name];
    if (value !== undefined && value.length <= 1024 && !/[\r\n]/.test(value)) safe[name] = value;
  }
  return safe;
};
const sameTarget = (a: PreviewGatewayTarget, b: PreviewGatewayTarget) =>
  Object.keys(PreviewGatewayTargetSchema.fields).every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  );

const matchesOwnedRelayReference = (
  reference: typeof RelayResourceReferenceSchema.Type,
  target: PreviewGatewayTarget,
  kind: "service" | "attachment",
  ownerToken: string,
) => {
  const expectedResourceIds = {
    service: target.serviceResourceId,
    attachment: target.attachmentResourceId,
  } satisfies Record<"service" | "attachment", string>;
  const expectedResourceId = expectedResourceIds[kind];
  return (
    reference.sessionId === target.sessionId &&
    reference.role === target.role &&
    reference.processId === target.processId &&
    reference.kind === kind &&
    reference.ownerTokenDigest === digest(ownerToken).slice(0, 63) &&
    reference.providerResourceId === expectedResourceId
  );
};

const matchesLiveSession = (session: PreviewSession, target: PreviewGatewayTarget, now: number) =>
  session.endedAt === null &&
  session.leaseDeadline > now &&
  session.generation === target.generation &&
  session.manifests[target.role] !== undefined &&
  session.requestedRevision === target.revision;

const canReplaceRoute = (previous: PreviewGatewayTarget, target: PreviewGatewayTarget) =>
  previous.sessionId === target.sessionId &&
  previous.role === target.role &&
  (previous.generation < target.generation || sameTarget(previous, target));

export interface PreviewGatewayApi {
  readonly configured: boolean;
  readonly register: (
    target: PreviewGatewayTarget,
    ownerIdentity: string,
  ) => Effect.Effect<PreviewGatewayRoute, PreviewGatewayError>;
  readonly grant: (
    hostname: string,
    ownerIdentity: string,
    userId: string,
    allowed: boolean,
  ) => Effect.Effect<void, PreviewGatewayError>;
  readonly cleanupSession: (
    sessionId: string,
    ownerIdentity: string,
  ) => Effect.Effect<void, PreviewGatewayError>;
  readonly cleanup: (
    hostname: string,
    ownerIdentity: string,
  ) => Effect.Effect<void, PreviewGatewayError>;
  readonly open: (
    request: PreviewGatewayRequest,
  ) => Effect.Effect<PreviewGatewayAdmission, PreviewGatewayError, Scope.Scope>;
}
export interface PreviewGatewayAdmission {
  readonly route: PreviewGatewayRoute;
  readonly principal: PreviewGatewayPrincipal;
  readonly readiness: {
    readonly gateway: "ready";
    readonly relay: "ready";
    readonly application: "unsupported";
  };
  readonly connection: PreviewGatewayRelayConnection;
  readonly headers: Readonly<Record<string, string>>;
  /** Every HTTP operation and each WebSocket frame must use guard; no admission cache. */
  readonly guard: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PreviewGatewayError, R>;
  readonly fenced: Effect.Effect<void>;
}
export class PreviewGateway extends Context.Service<PreviewGateway, PreviewGatewayApi>()(
  "developer-launcher/PreviewGateway",
) {}
export const PreviewGatewayLayer = (gateway: PreviewGatewayApi) =>
  Layer.succeed(PreviewGateway, gateway);

/** Embedded single-authority gateway. SQL is the existing controller/allocator database.
 * No live adapter is inferred from environment or from a successful local test.
 */
export const makePreviewGateway = (options: {
  readonly domain: string;
  readonly controller: PreviewSessionControllerApi;
  readonly adapters?: PreviewGatewayAdapters;
  readonly now: () => number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const domainValid =
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*dev\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        options.domain,
      ) &&
      options.domain.length < 190 &&
      !/(^|[.-])(prod|production|live)([.-]|$)/.test(options.domain);
    const configured = domainValid && options.adapters !== undefined;
    const requireSetup = Effect.gen(function* () {
      if (!configured || options.adapters === undefined)
        return yield* Effect.fail(failure("unsupported"));
      const setup = yield* decode(
        PreviewGatewaySetupSchema,
        yield* options.adapters.checkSetup.pipe(
          Effect.timeout("5 seconds"),
          Effect.mapError(unavailable),
        ),
      );
      if (
        setup.domain !== options.domain ||
        setup.observedAt > options.now() ||
        options.now() - setup.observedAt > 60_000
      )
        return yield* Effect.fail(failure("identity-mismatch"));
    });
    yield* sql`CREATE TABLE IF NOT EXISTS preview_gateway_routes (
    hostname TEXT PRIMARY KEY, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    target TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id, generation, hostname)
  )`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_gateway_grants (
    hostname TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(hostname, user_id)
  )`;
    const channels = new Map<
      string,
      Set<{ readonly userId: string; readonly fence: Effect.Effect<void> }>
    >();
    const closeChannels = (hostname: string, userId?: string) =>
      Effect.forEach(
        [...(channels.get(hostname) ?? [])].filter(
          (channel) => userId === undefined || channel.userId === userId,
        ),
        (channel) => channel.fence,
        { discard: true, concurrency: "unbounded" },
      );
    const load = (hostname: string, includeRemoved = false) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM preview_gateway_routes WHERE hostname=${hostname}`;
        const row = rows[0];
        if (row === undefined || (!includeRemoved && row.removed !== 0))
          return yield* Effect.fail(unavailable());
        const route = yield* decode(Schema.fromJsonString(PreviewGatewayTargetSchema), row.target);
        if (row.session_id !== route.sessionId || row.generation !== route.generation)
          return yield* Effect.fail(unavailable());
        return { hostname, target: route };
      });
    const owner = (sessionId: string, ownerIdentity: string) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT identity_digest FROM preview_sessions WHERE id=${sessionId}`;
        if (rows[0]?.identity_digest !== digest(ownerIdentity))
          return yield* Effect.fail(failure("owner-mismatch"));
        return yield* options.controller.status(sessionId);
      });
    const ownedRelay = (target: PreviewGatewayTarget) =>
      Effect.gen(function* () {
        for (const kind of ["service", "attachment"] as const) {
          const resource = `preview-relay-${kind}-${target.role}`;
          const rows =
            yield* sql`SELECT owner_token, provider_resource_id FROM preview_allocation_ledger WHERE session_id=${target.sessionId} AND resource=${resource} AND state='owned'`;
          const row = rows[0];
          if (row === undefined || !Predicate.isString(row.owner_token))
            return yield* Effect.fail(unavailable());
          const reference = yield* decode(
            Schema.fromJsonString(RelayResourceReferenceSchema),
            row.provider_resource_id,
          );
          if (!matchesOwnedRelayReference(reference, target, kind, row.owner_token))
            return yield* Effect.fail(failure("identity-mismatch"));
        }
      });
    const validSession = (target: PreviewGatewayTarget, active: boolean) =>
      Effect.gen(function* () {
        const session = yield* options.controller.status(target.sessionId);
        if (!matchesLiveSession(session, target, options.now()))
          return yield* Effect.fail(unavailable());
        if (active && (session.phase !== "active" || session.activeRevision !== target.revision))
          return yield* Effect.fail(unavailable());
        const groups =
          yield* sql`SELECT value FROM preview_session_allowed_work WHERE session_id=${target.sessionId} AND kind='group' AND value=${target.stateGroup}`;
        if (groups.length !== 1) return yield* Effect.fail(failure("identity-mismatch"));
        yield* ownedRelay(target);
        return session;
      });
    const verify = (connection: PreviewGatewayRelayConnection, target: PreviewGatewayTarget) =>
      Effect.gen(function* () {
        const identity = yield* decode(PreviewGatewayTargetSchema, connection.identity);
        if (
          !sameTarget(identity, target) ||
          !(yield* connection.connected.pipe(
            Effect.timeout("5 seconds"),
            Effect.mapError(unavailable),
          ))
        )
          return yield* Effect.fail(failure("identity-mismatch"));
      });
    const authorize = (route: PreviewGatewayRoute, principal: PreviewGatewayPrincipal) =>
      Effect.gen(function* () {
        const current = yield* load(route.hostname);
        if (
          !sameTarget(current.target, route.target) ||
          principal.sessionId !== route.target.sessionId ||
          principal.generation !== route.target.generation ||
          principal.role !== route.target.role ||
          principal.expiresAt <= options.now()
        )
          return yield* Effect.fail(failure("denied"));
        const session = yield* validSession(route.target, true);
        if (session.owner !== principal.userId) {
          const grants =
            yield* sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${route.hostname} AND user_id=${principal.userId}`;
          if (grants.length !== 1) return yield* Effect.fail(failure("denied"));
        }
        return session;
      });
    const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((error) => (error instanceof PreviewGatewayError ? error : unavailable())),
      );
    const api: PreviewGatewayApi = {
      configured,
      register: (rawTarget, ownerIdentity) =>
        protect(
          Effect.gen(function* () {
            if (!configured || options.adapters === undefined)
              return yield* Effect.fail(failure("unsupported"));
            yield* requireSetup;
            const target = yield* decode(PreviewGatewayTargetSchema, rawTarget);
            const hostname = `p-${target.sessionId}-${target.role}.${options.domain}`;
            if (
              target.serviceFqdn !==
                `${relayNameFor(target.sessionId, target.role)}.preview-relays.svc.cluster.local` ||
              (hostname.split(".")[0]?.length ?? 64) > 63
            )
              return yield* Effect.fail(failure("identity-mismatch"));
            yield* owner(target.sessionId, ownerIdentity);
            yield* validSession(target, false);
            // Readiness proof uses a freshly authenticated connection to the recorded target.
            yield* Effect.scoped(
              Effect.flatMap(
                options.adapters
                  .connect(target)
                  .pipe(Effect.timeout("5 seconds"), Effect.mapError(unavailable)),
                (connection) => verify(connection, target),
              ),
            );
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* owner(target.sessionId, ownerIdentity);
                yield* validSession(target, false);
                const rows =
                  yield* sql`SELECT target, removed FROM preview_gateway_routes WHERE hostname=${hostname}`;
                if (rows.length > 0) {
                  const previous = yield* load(hostname, true);
                  if (rows[0]?.removed !== 0 || !canReplaceRoute(previous.target, target))
                    return yield* Effect.fail(failure("route-conflict"));
                  if (previous.target.generation < target.generation) {
                    yield* sql`UPDATE preview_gateway_routes SET target=${JSON.stringify(target)}, generation=${target.generation} WHERE hostname=${hostname}`;
                    yield* sql`DELETE FROM preview_gateway_grants WHERE hostname=${hostname}`;
                  }
                } else {
                  yield* sql`INSERT INTO preview_gateway_routes (hostname, session_id, generation, target) VALUES (${hostname}, ${target.sessionId}, ${target.generation}, ${JSON.stringify(target)})`;
                }
                return { hostname, target };
              }),
            );
          }),
        ),
      grant: (hostname, ownerIdentity, userId, allowed) =>
        protect(
          Effect.gen(function* () {
            yield* decode(identifier, userId);
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const route = yield* load(hostname);
                const ownedSession = yield* owner(route.target.sessionId, ownerIdentity);
                if (userId === ownedSession.owner)
                  return yield* Effect.fail(failure("invalid-request"));
                if (allowed) {
                  yield* validSession(route.target, false);
                  yield* sql`INSERT INTO preview_gateway_grants (hostname, user_id) VALUES (${hostname}, ${userId}) ON CONFLICT DO NOTHING`;
                } else {
                  yield* sql`DELETE FROM preview_gateway_grants WHERE hostname=${hostname} AND user_id=${userId}`;
                }
              }),
            );
            if (!allowed) yield* closeChannels(hostname, userId);
          }),
        ),
      cleanupSession: (sessionId, ownerIdentity) =>
        protect(
          Effect.gen(function* () {
            const session = yield* owner(sessionId, ownerIdentity);
            if (session.endedAt === null) return yield* Effect.fail(failure("live-session"));
            const rows =
              yield* sql`SELECT hostname FROM preview_gateway_routes WHERE session_id=${sessionId}`;
            for (const row of rows) {
              const hostname = yield* decode(identifier, row.hostname);
              yield* api.cleanup(hostname, ownerIdentity);
            }
          }),
        ),
      cleanup: (hostname, ownerIdentity) =>
        protect(
          Effect.gen(function* () {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const route = yield* load(hostname, true);
                const session = yield* owner(route.target.sessionId, ownerIdentity);
                if (session.endedAt === null) return yield* Effect.fail(failure("live-session"));
                yield* sql`UPDATE preview_gateway_routes SET removed=1 WHERE hostname=${hostname} AND session_id=${session.id}`;
                yield* sql`DELETE FROM preview_gateway_grants WHERE hostname=${hostname}`;
              }),
            );
            yield* closeChannels(hostname);
          }),
        ),
      open: (request) =>
        protect(
          Effect.gen(function* () {
            if (!configured || options.adapters === undefined)
              return yield* Effect.fail(failure("unsupported"));
            yield* requireSetup;
            const route = yield* load(request.hostname);
            const principal = yield* decode(
              PreviewGatewayPrincipalSchema,
              yield* options.adapters
                .authenticate(request)
                .pipe(Effect.timeout("5 seconds"), Effect.mapError(unavailable)),
            );
            const initialSession = yield* authorize(route, principal);
            const connection = yield* options.adapters
              .connect(route.target)
              .pipe(Effect.timeout("5 seconds"), Effect.mapError(unavailable));
            yield* verify(connection, route.target);
            const closed = yield* Deferred.make<void>();
            const fence = Deferred.succeed(closed, undefined).pipe(
              Effect.flatMap((first) => (first ? connection.close : Effect.void)),
            );
            const record = { userId: principal.userId, fence };
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const records = channels.get(route.hostname) ?? new Set<typeof record>();
                records.add(record);
                channels.set(route.hostname, records);
              }),
              () =>
                Effect.gen(function* () {
                  const records = channels.get(route.hostname);
                  records?.delete(record);
                  if (records?.size === 0) channels.delete(route.hostname);
                  yield* fence;
                }),
            );
            yield* options.controller.watchFences(route.target.sessionId, fence);
            let lastValidDeadline = Math.min(initialSession.leaseDeadline, principal.expiresAt);
            const check = protect(
              Effect.gen(function* () {
                if (yield* Deferred.isDone(closed)) return yield* Effect.fail(unavailable());
                yield* verify(connection, route.target);
                const session = yield* sql.withTransaction(authorize(route, principal));
                const deadline = Math.min(session.leaseDeadline, principal.expiresAt);
                if (deadline <= options.now() || (yield* Deferred.isDone(closed)))
                  return yield* Effect.fail(unavailable());
                lastValidDeadline = deadline;
                return deadline;
              }),
            );
            // No cached authority beyond the last deadline. Idle connections close on loss of
            // authority; every forwarded frame independently checks the durable record.
            const monitor = Effect.gen(function* () {
              while (true) {
                const deadline = yield* check;
                yield* Effect.sleep(Math.max(0, Math.min(100, deadline - options.now())));
              }
            }).pipe(Effect.catch(() => fence));
            yield* monitor.pipe(Effect.forkScoped);
            yield* Effect.gen(function* () {
              while (true) {
                yield* Effect.sleep(Math.max(0, lastValidDeadline - options.now()));
                if (options.now() >= lastValidDeadline) {
                  yield* fence;
                  return;
                }
              }
            }).pipe(Effect.forkScoped);
            yield* check; // Closes the stop/open race after the fence subscription.
            return {
              route,
              principal,
              connection,
              headers: previewGatewayProbeHeaders(request.headers),
              readiness: { gateway: "ready", relay: "ready", application: "unsupported" },
              fenced: Deferred.await(closed),
              guard: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
                Effect.gen(function* () {
                  const deadline = yield* check;
                  return yield* Effect.raceFirst(
                    operation,
                    Effect.raceFirst(
                      Deferred.await(closed),
                      Effect.sleep(Math.max(0, deadline - options.now())).pipe(
                        Effect.andThen(fence),
                      ),
                    ).pipe(Effect.andThen(Effect.fail(unavailable()))),
                  );
                }).pipe(
                  Effect.catchIf(
                    (error) => error instanceof PreviewGatewayError,
                    (error) => Effect.andThen(fence, Effect.fail(error)),
                  ),
                ),
            } satisfies PreviewGatewayAdmission;
          }),
        ),
    };
    return api;
  });
