import { createHash, randomUUID } from "node:crypto";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
  Scope,
} from "effect";
import * as Stream from "effect/Stream";
import { SqlClient } from "effect/unstable/sql";
import type { Socket } from "effect/unstable/socket";
import {
  previewRelayHostRoles,
  relayNameFor,
  RelayResourceReferenceSchema,
} from "./preview-relay-provider";
import type { PreviewSession, PreviewSessionControllerApi } from "./preview-sessions";
import {
  makeRetryableConnectionFence,
  type RetryableConnectionFenceAttempt,
} from "./preview-gateway-close";

const identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
export const previewGatewayMaxApplicationResponseBytes = 16 * 1024 * 1024;
export const previewGatewayMaxApplicationRequestBytes = 1024 * 1024;
export const PreviewGatewayTargetSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Schema.Literals(previewRelayHostRoles),
  processId: identifier,
  revision: identifier,
  artifactDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  catalogDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  stateGroup: identifier,
  serviceFqdn: identifier,
  serviceResourceId: identifier,
  attachmentResourceId: identifier,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  kind: Schema.Literals(["disposable-probe", "application"]),
});
export type PreviewGatewayTarget = typeof PreviewGatewayTargetSchema.Type;
export const PreviewGatewayApplicationTargetSchema = Schema.Struct({
  ...PreviewGatewayTargetSchema.fields,
  kind: Schema.Literal("application"),
});
export type PreviewGatewayApplicationTarget = typeof PreviewGatewayApplicationTargetSchema.Type;
export const PreviewGatewayProbeTargetSchema = Schema.Struct({
  ...PreviewGatewayTargetSchema.fields,
  kind: Schema.Literal("disposable-probe"),
});
export const PreviewGatewayDependencyGroupSchema = Schema.Literals([
  "application-zero",
  "workflow-execution",
  "auth",
  "bot-storage",
  "search",
]);
export type PreviewGatewayDependencyGroup = typeof PreviewGatewayDependencyGroupSchema.Type;
const PreviewGatewayDependencyFields = {
  group: PreviewGatewayDependencyGroupSchema,
  endpoint: Schema.NonEmptyString,
  stateIdentity: identifier,
  deployedManifestDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  catalogDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  credentialReference: Schema.NonEmptyString,
};
export const PreviewGatewayDependencyIdentitySchema = Schema.Struct({
  role: Schema.Literals(previewRelayHostRoles),
  ...PreviewGatewayDependencyFields,
});
export type PreviewGatewayDependencyIdentity = typeof PreviewGatewayDependencyIdentitySchema.Type;
export const PreviewGatewayDependencyTargetSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Schema.Literals(previewRelayHostRoles),
  revision: identifier,
  ...PreviewGatewayDependencyFields,
});
export type PreviewGatewayDependencyTarget = typeof PreviewGatewayDependencyTargetSchema.Type;
export const PreviewGatewayRouteSchema = Schema.Struct({
  hostname: identifier,
  target: PreviewGatewayTargetSchema,
});
export type PreviewGatewayRoute = typeof PreviewGatewayRouteSchema.Type;
const PreviewGatewayChannelIdSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
export const PreviewGatewayChannelIdentitySchema = Schema.Struct({
  channelId: PreviewGatewayChannelIdSchema,
  hostname: identifier,
  userId: identifier,
  target: PreviewGatewayTargetSchema,
});
export type PreviewGatewayChannelIdentity = typeof PreviewGatewayChannelIdentitySchema.Type;
export const PreviewGatewayChannelRecoveryProofSchema = Schema.Struct({
  identity: PreviewGatewayChannelIdentitySchema,
  channelAbsent: Schema.Literal(true),
  pendingCreatesFenced: Schema.Literal(true),
});
export type PreviewGatewayChannelRecoveryProof =
  typeof PreviewGatewayChannelRecoveryProofSchema.Type;

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
      "payload-too-large",
    ]),
  },
) {}
/** Extracts one recoverable typed gateway failure without discarding other cause members. */
export const previewGatewayFailureFromCause = (
  cause: Cause.Cause<unknown>,
): Option.Option<PreviewGatewayError> => {
  if (cause.reasons.length !== 1) return Option.none();
  const [reason] = cause.reasons;
  return reason !== undefined &&
    Cause.isFailReason(reason) &&
    reason.error instanceof PreviewGatewayError
    ? Option.some(reason.error)
    : Option.none();
};

/** Also recovers the one legacy timeout defect emitted before close errors were typed. */
export const previewGatewayCleanupFailureFromCause = (
  cause: Cause.Cause<unknown>,
): Option.Option<PreviewGatewayError> => {
  const typedFailure = previewGatewayFailureFromCause(cause);
  if (Option.isSome(typedFailure)) return typedFailure;
  const [reason] = cause.reasons;
  return cause.reasons.length === 1 &&
    reason !== undefined &&
    Cause.isDieReason(reason) &&
    reason.defect instanceof PreviewGatewayError &&
    reason.defect.reason === "unavailable"
    ? Option.some(reason.defect)
    : Option.none();
};

/** Runs every close fence before combining failures so one defect cannot cancel sibling outcomes. */
export const closePreviewGatewayFences = (
  fences: readonly Effect.Effect<void, PreviewGatewayError>[],
) =>
  Effect.gen(function* () {
    const exits = yield* Effect.forEach(fences, (fence) => Effect.exit(fence), {
      concurrency: "unbounded",
    });
    const causes = exits.flatMap((exit) =>
      Match.valueTags(exit, {
        Success: () => [],
        Failure: ({ cause }) => [cause],
      }),
    );
    const [firstCause, ...remainingCauses] = causes;
    if (firstCause !== undefined)
      return yield* Effect.failCause(
        remainingCauses.reduce((combined, next) => Cause.combine(combined, next), firstCause),
      );
  });

export interface PreviewGatewayApplicationRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Verified identity claims; the adapter must keep reusable upstream tokens server-side. */
  readonly principal?: PreviewGatewayPrincipal;
  readonly body?: Stream.Stream<Uint8Array, PreviewGatewayError>;
}
export interface PreviewGatewayApplicationResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Stream.Stream<Uint8Array, PreviewGatewayError>;
}
const failure = (reason: PreviewGatewayError["reason"]) => new PreviewGatewayError({ reason });
const unavailable = () => failure("unavailable");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const decode = <A>(schema: Schema.Decoder<A>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => failure("invalid-request")));
const isAllowedPreviewDependencyHostname = (hostname: string) => {
  const previewDomains = [
    /^(?:[a-z0-9-]+\.)*dev\.theerapakg\.moe$/,
    /^(?:[a-z0-9-]+\.)*dev\.tiara-stack\.moe$/,
    /^(?:[a-z0-9-]+\.)*tiara-stack-dev\.svc\.cluster\.local$/,
  ];
  return (
    previewDomains.some((pattern) => pattern.test(hostname)) &&
    !/(^|[.-])(prod|production|live)([.-]|$)/i.test(hostname)
  );
};
const isSafeDependencyEndpoint = (input: string) => {
  try {
    return isSafeDependencyUrl(new URL(input));
  } catch {
    return false;
  }
};
const isSafeDependencyUrl = (url: URL) =>
  url.protocol === "https:" &&
  url.username === "" &&
  url.password === "" &&
  url.search === "" &&
  url.hash === "" &&
  (url.pathname === "" || url.pathname === "/") &&
  isAllowedPreviewDependencyHostname(url.hostname);
const matchesDependencyAdmission = (
  target: PreviewGatewayApplicationTarget,
  dependency: PreviewGatewayDependencyTarget,
) =>
  dependency.sessionId === target.sessionId &&
  dependency.generation === target.generation &&
  dependency.role === target.role &&
  dependency.revision === target.revision &&
  isSafeDependencyEndpoint(dependency.endpoint);

const dependencyIdentityFor = (
  target: PreviewGatewayDependencyTarget,
): PreviewGatewayDependencyIdentity => ({
  role: target.role,
  group: target.group,
  endpoint: target.endpoint,
  stateIdentity: target.stateIdentity,
  deployedManifestDigest: target.deployedManifestDigest,
  catalogDigest: target.catalogDigest,
  credentialReference: target.credentialReference,
});

/** Result of independent gateway authentication, never an application token or routing header. */
export const PreviewGatewayPrincipalSchema = Schema.Struct({
  userId: identifier,
  sessionId: identifier,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Schema.Literals(previewRelayHostRoles),
  expiresAt: Schema.Finite,
  effectivePrincipal: Schema.optional(
    Schema.Struct({
      subject: identifier,
      issuer: Schema.NonEmptyString,
      audiences: Schema.Array(identifier).check(Schema.isMinLength(1)),
      scopes: Schema.Array(identifier),
    }),
  ),
});
export type PreviewGatewayPrincipal = typeof PreviewGatewayPrincipalSchema.Type;
export type PreviewGatewayRequest = {
  readonly hostname: string;
  readonly path?: string;
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
  /** Application requests are session-bound and contain no browser credentials or forwarding headers. */
  readonly applicationRequest?: (
    input: PreviewGatewayApplicationRequest & {
      readonly maxResponseBytes: typeof previewGatewayMaxApplicationResponseBytes;
    },
  ) => Effect.Effect<PreviewGatewayApplicationResponse, PreviewGatewayError>;
  readonly applicationSocket?: (input: {
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly principal: PreviewGatewayPrincipal;
  }) => Effect.Effect<Socket.Socket, PreviewGatewayError, Scope.Scope>;
  readonly socket: Effect.Effect<Socket.Socket, PreviewGatewayError, Scope.Scope>;
  /** Idempotent; the gateway retries this effect if interruption leaves closure unconfirmed. */
  readonly close: Effect.Effect<void, PreviewGatewayError>;
}

export interface PreviewGatewayDependencyAdapter {
  /** Verify current endpoint, state identity, manifest/catalog digests and credential reference. */
  readonly checkTarget: (
    target: PreviewGatewayDependencyIdentity,
  ) => Effect.Effect<void, PreviewGatewayError>;
  /**
   * Routes one session-fenced browser request to the exact selected shared dependency.
   * Implementations must keep upstream tokens server-side, redact token-bearing response fields,
   * and use the group's own durable acceptance adapter for Zero/workflow writes. Generic forwarding
   * is not sufficient.
   */
  readonly request: (
    target: PreviewGatewayDependencyTarget,
    input: PreviewGatewayApplicationRequest & {
      readonly principal: PreviewGatewayPrincipal;
      readonly maxResponseBytes: typeof previewGatewayMaxApplicationResponseBytes;
    },
  ) => Effect.Effect<PreviewGatewayApplicationResponse, PreviewGatewayError>;
  /** Zero sync uses WSS and needs protocol-specific auth/acceptance with server-held tokens. */
  readonly socket: (input: {
    readonly target: PreviewGatewayDependencyTarget;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly principal: PreviewGatewayPrincipal;
  }) => Effect.Effect<Socket.Socket, PreviewGatewayError, Scope.Scope>;
}
export const PreviewGatewaySetupSchema = Schema.Struct({
  domain: Schema.NonEmptyString,
  observedAt: Schema.Finite,
  wildcardDns: Schema.Literal(true),
  wildcardCertificate: Schema.Literal(true),
  independentGatewayAuthentication: Schema.Literal(true),
  /** Operator-observed mediation of the authenticated Effective Principal to application adapters. */
  applicationIdentityMediation: Schema.optional(Schema.Literal(true)),
  /** Operator-observed request admission for every browser-visible shared dependency route. */
  browserDependencyMediation: Schema.optional(Schema.Literal(true)),
  singleControllerFenceDelivery: Schema.Literal(true),
});
export interface PreviewGatewayAdapters {
  /** Operator observation, not launcher configuration intent. Fail when unverifiable. */
  readonly checkSetup: Effect.Effect<typeof PreviewGatewaySetupSchema.Type, PreviewGatewayError>;
  readonly authenticate: (
    request: PreviewGatewayRequest,
  ) => Effect.Effect<PreviewGatewayPrincipal, PreviewGatewayError>;
  /** Short-lived readiness connection. It does not own a persisted channel row. */
  readonly connect: (
    target: PreviewGatewayTarget,
  ) => Effect.Effect<PreviewGatewayRelayConnection, PreviewGatewayError, Scope.Scope>;
  /**
   * Opens a long-lived channel under the durable identity recorded by the gateway. Once exact
   * recovery succeeds, a pending or later connect using that identity must remain fenced.
   */
  readonly connectChannel: (
    channel: PreviewGatewayChannelIdentity,
  ) => Effect.Effect<PreviewGatewayRelayConnection, PreviewGatewayError, Scope.Scope>;
  /**
   * Idempotently closes or confirms absence of this exact channel. Success must prove that no
   * channel for channelId remains and fence any in-flight or late connect using the same ID.
   * Implementations must reject mismatched target/session/generation/hostname/user identity.
   * Return unavailable when the external state cannot be proved; callers then retain the durable
   * channel row and keep cleanup fenced.
   */
  readonly recoverChannel: (
    channel: PreviewGatewayChannelIdentity,
  ) => Effect.Effect<PreviewGatewayChannelRecoveryProof, PreviewGatewayError>;
  readonly applicationDependency?: PreviewGatewayDependencyAdapter;
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
const sameTargetExceptRevision = (a: PreviewGatewayTarget, b: PreviewGatewayTarget) =>
  Object.keys(PreviewGatewayTargetSchema.fields)
    .filter((key) => key !== "revision")
    .every((key) => Reflect.get(a, key) === Reflect.get(b, key));
const sameChannelIdentity = (
  left: PreviewGatewayChannelIdentity,
  right: PreviewGatewayChannelIdentity,
) =>
  left.channelId === right.channelId &&
  left.hostname === right.hostname &&
  left.userId === right.userId &&
  sameTarget(left.target, right.target);
const recoverPreviewGatewayChannel = (
  recover: PreviewGatewayAdapters["recoverChannel"],
  identity: PreviewGatewayChannelIdentity,
) =>
  recover(identity).pipe(
    Effect.flatMap((rawProof) =>
      Schema.decodeUnknownEffect(PreviewGatewayChannelRecoveryProofSchema)(rawProof).pipe(
        Effect.mapError(() => unavailable()),
      ),
    ),
    Effect.flatMap((proof) =>
      sameChannelIdentity(proof.identity, identity) &&
      proof.channelAbsent &&
      proof.pendingCreatesFenced
        ? Effect.void
        : Effect.fail(unavailable()),
    ),
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

const matchesLiveSession = (
  session: PreviewSession,
  target: PreviewGatewayTarget,
  now: number,
  allowRevisionTransition = false,
) =>
  session.endedAt === null &&
  session.leaseDeadline > now &&
  session.generation === target.generation &&
  session.manifests[target.role] !== undefined &&
  (allowRevisionTransition || session.requestedRevision === target.revision);

const hasApplicationIdentityMediation = (
  target: PreviewGatewayTarget,
  mediationAvailable: boolean,
  principal?: PreviewGatewayPrincipal,
) =>
  target.kind !== "application" ||
  (mediationAvailable && (principal === undefined || principal.effectivePrincipal !== undefined));

const routeTargetMatches = (
  current: PreviewGatewayTarget,
  captured: PreviewGatewayTarget,
  allowRevisionTransition: boolean,
) =>
  allowRevisionTransition
    ? sameTargetExceptRevision(current, captured)
    : sameTarget(current, captured);
const principalIdentityMatches = (
  target: PreviewGatewayTarget,
  principal: PreviewGatewayPrincipal,
) =>
  principal.sessionId === target.sessionId &&
  principal.generation === target.generation &&
  principal.role === target.role;
const routeRevisionMatchesSession = (current: PreviewGatewayTarget, session: PreviewSession) =>
  current.revision === session.requestedRevision || current.revision === session.activeRevision;
const isViteHmrSocketRequest = (request: PreviewGatewayRequest, target: PreviewGatewayTarget) =>
  target.kind === "application" &&
  request.path?.split("?")[0] === "/_preview/app/__vite_hmr" &&
  request.headers.upgrade?.toLowerCase() === "websocket";

const canReplaceRoute = (previous: PreviewGatewayTarget, target: PreviewGatewayTarget) =>
  previous.sessionId === target.sessionId &&
  previous.role === target.role &&
  (previous.generation < target.generation ||
    sameTarget(previous, target) ||
    (previous.kind === "application" &&
      target.kind === "application" &&
      previous.generation === target.generation &&
      sameTargetExceptRevision(previous, target)));

export interface PreviewGatewayApi {
  readonly configured: boolean;
  readonly checkApplicationSetup: () => Effect.Effect<void, PreviewGatewayError>;
  readonly checkApplicationDependencies: (
    targets: readonly PreviewGatewayDependencyIdentity[],
  ) => Effect.Effect<void, PreviewGatewayError>;
  readonly checkRegisteredApplicationDependencies: (
    sessionId: string,
    role: (typeof previewRelayHostRoles)[number],
    ownerIdentity: string,
  ) => Effect.Effect<void, PreviewGatewayError>;
  readonly applicationOrigin: (
    sessionId: string,
    role: (typeof previewRelayHostRoles)[number],
  ) => string | undefined;
  readonly applicationDependencyOrigin: (
    sessionId: string,
    role: (typeof previewRelayHostRoles)[number],
    group: PreviewGatewayDependencyGroup,
  ) => string | undefined;
  readonly register: (
    target: PreviewGatewayTarget,
    ownerIdentity: string,
  ) => Effect.Effect<PreviewGatewayRoute, PreviewGatewayError>;
  readonly resumeApplication: (
    sessionId: string,
    role: (typeof previewRelayHostRoles)[number],
    ownerIdentity: string,
  ) => Effect.Effect<PreviewGatewayRoute, PreviewGatewayError>;
  readonly registerApplicationDependencies: (
    target: PreviewGatewayTarget,
    dependencies: readonly PreviewGatewayDependencyTarget[],
    ownerIdentity: string,
  ) => Effect.Effect<void, PreviewGatewayError>;
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
    readonly application: "ready" | "unsupported";
  };
  readonly connection: PreviewGatewayRelayConnection;
  readonly headers: Readonly<Record<string, string>>;
  /** Every HTTP operation and each WebSocket frame must use guard; no admission cache. */
  readonly guard: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PreviewGatewayError, R>;
  /** HMR frames may cross compatible source revisions while preserving session/generation fencing. */
  readonly guardApplicationSocket: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | PreviewGatewayError, R>;
  readonly applicationRequest: (
    input: PreviewGatewayApplicationRequest,
  ) => Effect.Effect<PreviewGatewayApplicationResponse, PreviewGatewayError>;
  readonly applicationDependencyRequest: (
    group: PreviewGatewayDependencyGroup,
    input: PreviewGatewayApplicationRequest,
  ) => Effect.Effect<PreviewGatewayApplicationResponse, PreviewGatewayError>;
  readonly applicationDependencySocket: (
    group: PreviewGatewayDependencyGroup,
    input: {
      readonly path: string;
      readonly headers: Readonly<Record<string, string>>;
    },
  ) => Effect.Effect<Socket.Socket, PreviewGatewayError, Scope.Scope>;
  readonly applicationSocket: NonNullable<PreviewGatewayRelayConnection["applicationSocket"]>;
  readonly fenced: Effect.Effect<void>;
}
export class PreviewGateway extends Context.Service<PreviewGateway, PreviewGatewayApi>()(
  "developer-launcher/PreviewGateway",
) {}
export const PreviewGatewayLayer = (gateway: PreviewGatewayApi) =>
  Layer.succeed(PreviewGateway, gateway);

const ensurePreviewGatewayChannelRegistry = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS preview_gateway_channels (
      channel_id TEXT PRIMARY KEY, hostname TEXT NOT NULL, session_id TEXT NOT NULL,
      generation INTEGER NOT NULL, user_id TEXT NOT NULL,
      target_json TEXT, state TEXT NOT NULL CHECK (state IN ('opening', 'open'))
    )`;
    const columns = yield* sql`PRAGMA table_info(preview_gateway_channels)`;
    if (!columns.some((column) => String(column.name) === "target_json"))
      yield* sql`ALTER TABLE preview_gateway_channels ADD COLUMN target_json TEXT`;
    yield* sql`CREATE INDEX IF NOT EXISTS preview_gateway_channels_host_user
      ON preview_gateway_channels(hostname, user_id)`;
  });

const registerPreviewGatewayChannel = <E>(input: {
  readonly sql: SqlClient.SqlClient;
  readonly route: PreviewGatewayRoute;
  readonly userId: string;
  readonly authorize: () => Effect.Effect<PreviewSession, E>;
}) =>
  Effect.gen(function* () {
    const channelId = randomUUID();
    const targetJson = JSON.stringify(input.route.target);
    yield* input.sql.withTransaction(
      Effect.gen(function* () {
        yield* input.authorize();
        yield* ensurePreviewGatewayChannelRegistry(input.sql);
        yield* input.sql`INSERT INTO preview_gateway_channels
          (channel_id, hostname, session_id, generation, user_id, target_json, state)
          VALUES (${channelId}, ${input.route.hostname}, ${input.route.target.sessionId}, ${input.route.target.generation}, ${input.userId}, ${targetJson}, 'opening')`;
      }),
    );
    return { channelId, targetJson };
  });

const PreviewGatewayChannelRowSchema = Schema.Struct({
  channel_id: PreviewGatewayChannelIdSchema,
  hostname: identifier,
  session_id: PreviewGatewayTargetSchema.fields.sessionId,
  generation: PreviewGatewayTargetSchema.fields.generation,
  user_id: identifier,
  target_json: Schema.NullOr(Schema.String),
  state: Schema.Literals(["opening", "open"]),
});
type PreviewGatewayChannelRow = Omit<typeof PreviewGatewayChannelRowSchema.Type, "target_json"> & {
  readonly target_json: string;
  readonly target: PreviewGatewayTarget;
};
const decodePreviewGatewayChannelRow = (value: unknown) =>
  Schema.decodeUnknownEffect(PreviewGatewayChannelRowSchema)(value).pipe(
    Effect.mapError(() => unavailable()),
    Effect.flatMap((row) => {
      if (row.target_json === null) return Effect.fail(unavailable());
      const targetJson = row.target_json;
      return Schema.decodeUnknownEffect(Schema.fromJsonString(PreviewGatewayTargetSchema))(
        targetJson,
      ).pipe(
        Effect.mapError(() => unavailable()),
        Effect.flatMap((target) =>
          target.sessionId === row.session_id && target.generation === row.generation
            ? Effect.succeed({ ...row, target_json: targetJson, target })
            : Effect.fail(unavailable()),
        ),
      );
    }),
  );

const deletePreviewGatewayChannel = (
  sql: SqlClient.SqlClient,
  channel: PreviewGatewayChannelIdentity,
  targetJson: string,
) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM preview_gateway_channels
      WHERE channel_id=${channel.channelId} AND hostname=${channel.hostname}
      AND session_id=${channel.target.sessionId} AND generation=${channel.target.generation}
      AND user_id=${channel.userId} AND target_json=${targetJson}
      AND state IN ('opening', 'open')`;
    const remaining = yield* sql`SELECT channel_id FROM preview_gateway_channels
      WHERE channel_id=${channel.channelId}`;
    if (remaining.length > 0) return yield* Effect.fail(unavailable());
  });

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
      return setup;
    });
    yield* sql`CREATE TABLE IF NOT EXISTS preview_gateway_routes (
    hostname TEXT PRIMARY KEY, session_id TEXT NOT NULL, generation INTEGER NOT NULL,
    target TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id, generation, hostname)
  )`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_gateway_grants (
    hostname TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(hostname, user_id)
  )`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_gateway_dependency_routes (
    session_id TEXT NOT NULL, role TEXT NOT NULL, group_id TEXT NOT NULL,
    target TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(session_id, role, group_id)
  )`;
    const channels = new Map<
      string,
      Set<{
        readonly channelId: string;
        readonly userId: string;
        readonly fence: Effect.Effect<void, PreviewGatewayError>;
      }>
    >();
    const loadDependency = (
      sessionId: string,
      role: PreviewGatewayDependencyTarget["role"],
      group: PreviewGatewayDependencyGroup,
    ) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT target FROM preview_gateway_dependency_routes WHERE session_id=${sessionId} AND role=${role} AND group_id=${group} AND removed=0`;
        if (rows.length !== 1) return yield* Effect.fail(unavailable());
        const target = yield* decode(
          Schema.fromJsonString(PreviewGatewayDependencyTargetSchema),
          rows[0]?.target,
        );
        if (
          target.sessionId !== sessionId ||
          target.role !== role ||
          target.group !== group ||
          !isSafeDependencyEndpoint(target.endpoint)
        )
          return yield* Effect.fail(failure("identity-mismatch"));
        return target;
      });
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
    const validSession = (
      target: PreviewGatewayTarget,
      active: boolean,
      allowRevisionTransition = false,
    ) =>
      Effect.gen(function* () {
        const session = yield* options.controller.status(target.sessionId);
        if (!matchesLiveSession(session, target, options.now(), allowRevisionTransition))
          return yield* Effect.fail(unavailable());
        if (active) {
          const activeRevision = allowRevisionTransition
            ? session.phase === "starting" || session.phase === "active"
            : session.phase === "active" && session.activeRevision === target.revision;
          if (!activeRevision) return yield* Effect.fail(unavailable());
        }
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
    const authorize = (
      route: PreviewGatewayRoute,
      principal: PreviewGatewayPrincipal,
      applicationIdentityMediation: boolean,
      allowRevisionTransition = false,
    ) =>
      Effect.gen(function* () {
        const current = yield* load(route.hostname);
        if (
          !routeTargetMatches(current.target, route.target, allowRevisionTransition) ||
          !principalIdentityMatches(route.target, principal) ||
          principal.expiresAt <= options.now() ||
          !hasApplicationIdentityMediation(route.target, applicationIdentityMediation, principal)
        )
          return yield* Effect.fail(failure("denied"));
        const session = yield* validSession(route.target, true, allowRevisionTransition);
        if (allowRevisionTransition && !routeRevisionMatchesSession(current.target, session))
          return yield* Effect.fail(failure("identity-mismatch"));
        if (session.owner !== principal.userId) {
          const grants =
            yield* sql`SELECT user_id FROM preview_gateway_grants WHERE hostname=${route.hostname} AND user_id=${principal.userId}`;
          if (grants.length !== 1) return yield* Effect.fail(failure("denied"));
        }
        return session;
      });
    // Normalize one typed boundary error, but retain every reason in a compound cause.
    const protect = <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, PreviewGatewayError, R> =>
      effect.pipe(
        Effect.exit,
        Effect.flatMap(
          (exit): Effect.Effect<A, PreviewGatewayError> =>
            Match.valueTags(exit, {
              Success: ({ value }) => Effect.succeed(value),
              Failure: ({ cause }) =>
                Effect.failCause(
                  Cause.map<E, PreviewGatewayError>(cause, (error) =>
                    error instanceof PreviewGatewayError ? error : unavailable(),
                  ),
                ),
            }),
        ),
      );
    const matchesChannelRoute = (
      row: PreviewGatewayChannelRow,
      hostname: string,
      userId: string | undefined,
      target: PreviewGatewayTarget,
    ) =>
      row.hostname === hostname &&
      row.session_id === target.sessionId &&
      row.generation === target.generation &&
      (userId === undefined || row.user_id === userId) &&
      sameTargetExceptRevision(row.target, target);
    const readRecoverableChannelRows = (hostname: string, userId: string | undefined) =>
      Effect.gen(function* () {
        yield* ensurePreviewGatewayChannelRegistry(sql);
        const rawRows =
          userId === undefined
            ? yield* sql`SELECT channel_id, hostname, session_id, generation, user_id, target_json, state
                FROM preview_gateway_channels WHERE hostname=${hostname}`
            : yield* sql`SELECT channel_id, hostname, session_id, generation, user_id, target_json, state
                FROM preview_gateway_channels WHERE hostname=${hostname} AND user_id=${userId}`;
        const rows = yield* Effect.forEach(rawRows, decodePreviewGatewayChannelRow);
        if (rows.length === 0) return rows;
        const route = yield* load(hostname, true);
        if (!rows.every((row) => matchesChannelRoute(row, hostname, userId, route.target)))
          return yield* Effect.fail(unavailable());
        return rows;
      });
    const recoverChannelRows = (hostname: string, userId: string | undefined) =>
      Effect.gen(function* () {
        const rows = yield* readRecoverableChannelRows(hostname, userId);
        if (rows.length === 0) return rows;
        const adapters = options.adapters;
        if (adapters === undefined) return yield* Effect.fail(unavailable());
        const identities = rows.map(
          (row): PreviewGatewayChannelIdentity => ({
            channelId: row.channel_id,
            hostname: row.hostname,
            userId: row.user_id,
            target: row.target,
          }),
        );
        yield* closePreviewGatewayFences(
          identities.map((identity) =>
            protect(recoverPreviewGatewayChannel(adapters.recoverChannel, identity)),
          ),
        );
        return rows;
      });
    const persistRecoveredChannelRows = (
      rows: readonly PreviewGatewayChannelRow[],
      hostname: string,
      userId: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (rows.length > 0) {
          const route = yield* load(hostname, true);
          if (!rows.every((row) => matchesChannelRoute(row, hostname, userId, route.target)))
            return yield* Effect.fail(unavailable());
          yield* Effect.forEach(
            rows,
            (row) =>
              protect(
                deletePreviewGatewayChannel(
                  sql,
                  {
                    channelId: row.channel_id,
                    hostname: row.hostname,
                    userId: row.user_id,
                    target: row.target,
                  },
                  row.target_json,
                ),
              ),
            { discard: true },
          );
        }
        const remaining =
          userId === undefined
            ? yield* sql`SELECT channel_id FROM preview_gateway_channels WHERE hostname=${hostname}`
            : yield* sql`SELECT channel_id FROM preview_gateway_channels WHERE hostname=${hostname} AND user_id=${userId}`;
        if (remaining.length > 0) return yield* Effect.fail(unavailable());
      });
    const closeChannels = (hostname: string, userId?: string) =>
      Effect.gen(function* () {
        const selected = [...(channels.get(hostname) ?? [])].filter(
          (channel) => userId === undefined || channel.userId === userId,
        );
        yield* closePreviewGatewayFences(
          selected.map((channel) =>
            channel.fence.pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  const records = channels.get(hostname);
                  records?.delete(channel);
                  if (records?.size === 0) channels.delete(hostname);
                }),
              ),
            ),
          ),
        );
        const reconciledRows: PreviewGatewayChannelRow[] = [];
        const closed = yield* Deferred.make<void>();
        const recoveryFence = makeRetryableConnectionFence(
          () =>
            recoverChannelRows(hostname, userId).pipe(
              Effect.tap((rows) =>
                Effect.sync(() => {
                  reconciledRows.push(...rows);
                }),
              ),
              Effect.asVoid,
            ),
          closed,
          () => Effect.fail(unavailable()),
          persistRecoveredChannelRows(reconciledRows, hostname, userId),
        );
        yield* protect(recoveryFence);
      });
    const cleanupOfflineRouteMetadata = (
      sessionId: string,
      ownerIdentity: string,
      expectedHostname?: string,
    ) =>
      Effect.gen(function* () {
        yield* ensurePreviewGatewayChannelRegistry(sql);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const session = yield* owner(sessionId, ownerIdentity);
            if (session.endedAt === null) return yield* Effect.fail(failure("live-session"));
            const routeRows =
              yield* sql`SELECT hostname FROM preview_gateway_routes WHERE session_id=${sessionId}`;
            const routes = yield* Effect.forEach(routeRows, (row) =>
              Effect.gen(function* () {
                const hostname = yield* decode(identifier, row.hostname);
                const route = yield* load(hostname, true);
                if (route.target.sessionId !== sessionId) return yield* Effect.fail(unavailable());
                return route;
              }),
            );
            if (
              expectedHostname !== undefined &&
              !routes.some((route) => route.hostname === expectedHostname)
            )
              return yield* Effect.fail(unavailable());

            // Any channel row for this session or one of its routes needs adapter recovery.
            // Keep the full preflight and metadata writes in one transaction so an opener
            // either commits its channel first or observes the removed route afterward.
            const sessionChannels =
              yield* sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${sessionId}`;
            if (sessionChannels.length > 0) return yield* Effect.fail(unavailable());
            for (const route of routes) {
              const hostChannels =
                yield* sql`SELECT channel_id FROM preview_gateway_channels WHERE hostname=${route.hostname}`;
              if (hostChannels.length > 0) return yield* Effect.fail(unavailable());
            }

            const routesToRemove =
              expectedHostname === undefined
                ? routes
                : routes.filter((route) => route.hostname === expectedHostname);
            for (const route of routesToRemove) {
              yield* sql`UPDATE preview_gateway_routes SET removed=1
                WHERE hostname=${route.hostname} AND session_id=${sessionId}
                AND generation=${route.target.generation}`;
              yield* sql`DELETE FROM preview_gateway_grants WHERE hostname=${route.hostname}`;
              yield* sql`DELETE FROM preview_gateway_dependency_routes
                WHERE session_id=${sessionId} AND role=${route.target.role}`;
            }
          }),
        );
      });
    const checkApplicationDependencyTargets = (
      target: PreviewGatewayApplicationTarget,
      dependencies: readonly PreviewGatewayDependencyTarget[],
    ) => {
      const adapter = options.adapters?.applicationDependency;
      if (adapter === undefined) return Effect.fail(failure("unsupported"));
      return Effect.forEach(
        dependencies,
        (dependency) =>
          Effect.gen(function* () {
            if (!matchesDependencyAdmission(target, dependency))
              return yield* Effect.fail(failure("identity-mismatch"));
            const groups =
              yield* sql`SELECT value FROM preview_session_allowed_work WHERE session_id=${target.sessionId} AND kind='group' AND value=${dependency.group}`;
            const endpoints =
              yield* sql`SELECT value FROM preview_session_allowed_work WHERE session_id=${target.sessionId} AND kind='endpoint' AND value=${dependency.endpoint}`;
            if (groups.length !== 1 || endpoints.length !== 1)
              return yield* Effect.fail(failure("identity-mismatch"));
            yield* adapter
              .checkTarget(dependencyIdentityFor(dependency))
              .pipe(Effect.timeout("5 seconds"), Effect.mapError(unavailable));
          }),
        { discard: true, concurrency: "unbounded" },
      );
    };
    const replaceApplicationDependencyRoutes = (
      target: PreviewGatewayApplicationTarget,
      dependencies: readonly PreviewGatewayDependencyTarget[],
      ownerIdentity: string,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* owner(target.sessionId, ownerIdentity);
          yield* validSession(target, false);
          yield* sql`DELETE FROM preview_gateway_dependency_routes WHERE session_id=${target.sessionId} AND role=${target.role}`;
          for (const dependency of dependencies)
            yield* sql`INSERT INTO preview_gateway_dependency_routes (session_id, role, group_id, target) VALUES (${target.sessionId}, ${target.role}, ${dependency.group}, ${JSON.stringify(dependency)})`;
        }),
      );
    const readRegisteredApplicationDependencies = (
      sessionId: string,
      role: (typeof previewRelayHostRoles)[number],
      ownerIdentity: string,
    ) =>
      Effect.gen(function* () {
        const hostname = `p-${sessionId}-${role}.${options.domain}`;
        yield* owner(sessionId, ownerIdentity);
        const route = yield* load(hostname);
        const target = yield* decode(PreviewGatewayApplicationTargetSchema, route.target);
        if (target.role !== role) return yield* Effect.fail(failure("unsupported"));
        yield* validSession(target, true);
        const rows =
          yield* sql`SELECT target FROM preview_gateway_dependency_routes WHERE session_id=${sessionId} AND role=${role} AND removed=0`;
        if (rows.length === 0) return yield* Effect.fail(unavailable());
        const dependencies = yield* Effect.forEach(rows, (row) =>
          decode(Schema.fromJsonString(PreviewGatewayDependencyTargetSchema), row.target),
        );
        if (
          !dependencies.every(
            (dependency) =>
              dependency.generation === target.generation &&
              dependency.revision === target.revision,
          )
        )
          return yield* Effect.fail(failure("identity-mismatch"));
        return { target, dependencies };
      });
    const api: PreviewGatewayApi = {
      configured,
      checkApplicationSetup: () =>
        protect(
          Effect.gen(function* () {
            const setup = yield* requireSetup;
            if (
              setup.applicationIdentityMediation !== true ||
              setup.browserDependencyMediation !== true ||
              options.adapters?.applicationDependency === undefined
            )
              return yield* Effect.fail(failure("unsupported"));
          }),
        ),
      checkApplicationDependencies: (targets) =>
        protect(
          Effect.gen(function* () {
            const setup = yield* requireSetup;
            const adapter = options.adapters?.applicationDependency;
            if (
              setup.applicationIdentityMediation !== true ||
              setup.browserDependencyMediation !== true ||
              adapter === undefined ||
              targets.length === 0
            )
              return yield* Effect.fail(failure("unsupported"));
            yield* Effect.forEach(
              targets,
              (target) => {
                if (!isSafeDependencyEndpoint(target.endpoint))
                  return Effect.fail(failure("identity-mismatch"));
                return adapter
                  .checkTarget(target)
                  .pipe(Effect.timeout("5 seconds"), Effect.mapError(unavailable));
              },
              { discard: true, concurrency: "unbounded" },
            );
          }),
        ),
      checkRegisteredApplicationDependencies: (sessionId, role, ownerIdentity) =>
        protect(
          Effect.gen(function* () {
            const setup = yield* requireSetup;
            if (
              setup.applicationIdentityMediation !== true ||
              setup.browserDependencyMediation !== true ||
              options.adapters?.applicationDependency === undefined
            )
              return yield* Effect.fail(failure("unsupported"));
            const registered = yield* readRegisteredApplicationDependencies(
              sessionId,
              role,
              ownerIdentity,
            );
            yield* checkApplicationDependencyTargets(registered.target, registered.dependencies);
          }),
        ),
      applicationOrigin: (sessionId, role) =>
        configured ? `https://p-${sessionId}-${role}.${options.domain}` : undefined,
      applicationDependencyOrigin: (sessionId, role, group) => {
        const origin = api.applicationOrigin(sessionId, role);
        return origin === undefined ? undefined : `${origin}/_preview/dependencies/${group}/`;
      },
      register: (rawTarget, ownerIdentity) =>
        protect(
          Effect.gen(function* () {
            if (!configured || options.adapters === undefined)
              return yield* Effect.fail(failure("unsupported"));
            const setup = yield* requireSetup;
            const target = yield* decode(PreviewGatewayTargetSchema, rawTarget);
            if (
              !hasApplicationIdentityMediation(target, setup.applicationIdentityMediation === true)
            )
              return yield* Effect.fail(failure("unsupported"));
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
                (connection) =>
                  Effect.gen(function* () {
                    yield* verify(connection, target);
                    if (target.kind === "application") {
                      if (
                        connection.applicationRequest === undefined ||
                        connection.applicationSocket === undefined
                      )
                        return yield* Effect.fail(failure("unsupported"));
                      const readiness = yield* connection
                        .applicationRequest({
                          method: "GET",
                          path: "/ready",
                          headers: {},
                          maxResponseBytes: previewGatewayMaxApplicationResponseBytes,
                        })
                        .pipe(Effect.timeout("10 seconds"), Effect.mapError(unavailable));
                      if (readiness.status < 200 || readiness.status >= 300)
                        return yield* Effect.fail(unavailable());
                    }
                  }),
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
                  } else if (previous.target.revision !== target.revision) {
                    yield* sql`UPDATE preview_gateway_routes SET target=${JSON.stringify(target)} WHERE hostname=${hostname}`;
                  }
                } else {
                  yield* sql`INSERT INTO preview_gateway_routes (hostname, session_id, generation, target) VALUES (${hostname}, ${target.sessionId}, ${target.generation}, ${JSON.stringify(target)})`;
                }
                return { hostname, target };
              }),
            );
          }),
        ),
      resumeApplication: (sessionId, role, ownerIdentity) =>
        protect(
          Effect.gen(function* () {
            const hostname = `p-${sessionId}-${role}.${options.domain}`;
            const current = yield* load(hostname);
            if (current.target.kind !== "application" || current.target.role !== role)
              return yield* Effect.fail(failure("unsupported"));
            const session = yield* owner(sessionId, ownerIdentity);
            const target = {
              ...current.target,
              generation: session.generation,
              revision: session.requestedRevision,
            };
            const route = yield* api.register(target, ownerIdentity);
            const rows =
              yield* sql`SELECT target FROM preview_gateway_dependency_routes WHERE session_id=${sessionId} AND role=${role} AND removed=0`;
            if (rows.length > 0) {
              const dependencies = yield* Effect.forEach(rows, (row) =>
                decode(
                  Schema.fromJsonString(PreviewGatewayDependencyTargetSchema),
                  row.target,
                ).pipe(
                  Effect.map((dependency) => ({
                    ...dependency,
                    generation: target.generation,
                    revision: target.revision,
                  })),
                ),
              );
              yield* api.registerApplicationDependencies(target, dependencies, ownerIdentity);
            }
            return route;
          }),
        ),
      registerApplicationDependencies: (rawTarget, rawDependencies, ownerIdentity) =>
        protect(
          Effect.gen(function* () {
            if (!configured || options.adapters?.applicationDependency === undefined)
              return yield* Effect.fail(failure("unsupported"));
            const setup = yield* requireSetup;
            if (
              setup.applicationIdentityMediation !== true ||
              setup.browserDependencyMediation !== true
            )
              return yield* Effect.fail(failure("unsupported"));
            const target = yield* decode(PreviewGatewayApplicationTargetSchema, rawTarget);
            const dependencies = yield* decode(
              Schema.Array(PreviewGatewayDependencyTargetSchema),
              rawDependencies,
            );
            if (dependencies.length === 0) return yield* Effect.fail(failure("invalid-request"));
            const groups = dependencies.map((dependency) => dependency.group);
            if (new Set(groups).size !== groups.length)
              return yield* Effect.fail(failure("invalid-request"));
            const hostname = `p-${target.sessionId}-${target.role}.${options.domain}`;
            yield* owner(target.sessionId, ownerIdentity);
            yield* validSession(target, false);
            const route = yield* load(hostname);
            if (!sameTarget(route.target, target))
              return yield* Effect.fail(failure("identity-mismatch"));
            yield* checkApplicationDependencyTargets(target, dependencies);
            yield* replaceApplicationDependencyRoutes(target, dependencies, ownerIdentity);
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
            if (options.adapters === undefined)
              return yield* cleanupOfflineRouteMetadata(sessionId, ownerIdentity);
            const session = yield* owner(sessionId, ownerIdentity);
            if (session.endedAt === null) return yield* Effect.fail(failure("live-session"));
            yield* ensurePreviewGatewayChannelRegistry(sql);
            const rows =
              yield* sql`SELECT hostname FROM preview_gateway_routes WHERE session_id=${sessionId}`;
            for (const row of rows) {
              const hostname = yield* decode(identifier, row.hostname);
              yield* api.cleanup(hostname, ownerIdentity);
            }
            const remaining =
              yield* sql`SELECT channel_id FROM preview_gateway_channels WHERE session_id=${sessionId}`;
            if (remaining.length > 0) return yield* Effect.fail(unavailable());
          }),
        ),
      cleanup: (hostname, ownerIdentity) =>
        protect(
          Effect.gen(function* () {
            if (options.adapters === undefined) {
              const route = yield* load(hostname, true);
              return yield* cleanupOfflineRouteMetadata(
                route.target.sessionId,
                ownerIdentity,
                hostname,
              );
            }
            yield* sql.withTransaction(
              Effect.gen(function* () {
                const route = yield* load(hostname, true);
                const session = yield* owner(route.target.sessionId, ownerIdentity);
                if (session.endedAt === null) return yield* Effect.fail(failure("live-session"));
                yield* sql`UPDATE preview_gateway_routes SET removed=1 WHERE hostname=${hostname} AND session_id=${session.id}`;
                yield* sql`DELETE FROM preview_gateway_grants WHERE hostname=${hostname}`;
                yield* sql`DELETE FROM preview_gateway_dependency_routes WHERE session_id=${session.id} AND role=${route.target.role}`;
              }),
            );
            yield* closeChannels(hostname);
          }),
        ),
      open: (request) =>
        protect(
          Effect.gen(function* () {
            const adapters = options.adapters;
            if (!configured || adapters === undefined)
              return yield* Effect.fail(failure("unsupported"));
            const setup = yield* requireSetup;
            const route = yield* load(request.hostname);
            const principal = yield* decode(
              PreviewGatewayPrincipalSchema,
              yield* adapters
                .authenticate(request)
                .pipe(Effect.timeout("5 seconds"), Effect.mapError(unavailable)),
            );
            const initialSession = yield* authorize(
              route,
              principal,
              setup.applicationIdentityMediation === true,
            );
            const allowHmrRevisionTransition = isViteHmrSocketRequest(request, route.target);
            const registeredChannel = yield* registerPreviewGatewayChannel({
              sql,
              route,
              userId: principal.userId,
              authorize: () =>
                authorize(
                  route,
                  principal,
                  setup.applicationIdentityMediation === true,
                  allowHmrRevisionTransition,
                ),
            }).pipe(protect);
            const { channelId, targetJson } = registeredChannel;
            const channelIdentity: PreviewGatewayChannelIdentity = {
              channelId,
              hostname: route.hostname,
              userId: principal.userId,
              target: route.target,
            };
            const closed = yield* Deferred.make<void>();
            // Adapter acquisitions belong to the gateway, not the HTTP caller's scope. Closing
            // this child scope is started once and observed through a bounded Deferred wait.
            const adapterScope = yield* Scope.make();
            const adapterScopeCloseFiberScope = yield* Scope.make();
            const adapterScopeCloseStarted = yield* Ref.make(false);
            const adapterScopeCloseResult = yield* Deferred.make<Exit.Exit<void, never>>();
            const connectionRef = yield* Ref.make<PreviewGatewayRelayConnection | undefined>(
              undefined,
            );
            const lastCloseCause = yield* Ref.make<Cause.Cause<PreviewGatewayError> | undefined>(
              undefined,
            );
            const startAdapterScopeClose = Effect.gen(function* () {
              if (!(yield* Ref.get(adapterScopeCloseStarted))) {
                yield* Effect.forkIn(
                  Effect.gen(function* () {
                    const scopeExit = yield* Effect.exit(Scope.close(adapterScope, Exit.void));
                    yield* Deferred.succeed(adapterScopeCloseResult, scopeExit).pipe(Effect.asVoid);
                  }),
                  adapterScopeCloseFiberScope,
                ).pipe(Effect.asVoid);
                yield* Ref.set(adapterScopeCloseStarted, true);
              }
            });
            const recoverChannel = recoverPreviewGatewayChannel(
              adapters.recoverChannel,
              channelIdentity,
            ).pipe(Effect.interruptible);
            // Keep time for exact reconciliation inside the outer five-second fence attempt.
            const recoverAfterUnconfirmedClose = (
              attempt: RetryableConnectionFenceAttempt<PreviewGatewayError>,
              closeCause: Cause.Cause<PreviewGatewayError>,
            ) =>
              Effect.gen(function* () {
                attempt.setCloseCause(closeCause);
                yield* Ref.set(lastCloseCause, closeCause);
                const recoveryExit = yield* Effect.exit(recoverChannel);
                yield* Match.valueTags(recoveryExit, {
                  Success: () => Ref.set(lastCloseCause, undefined),
                  Failure: ({ cause }) => {
                    const combinedCause = Cause.combine(closeCause, cause);
                    attempt.setCloseCause(combinedCause);
                    return Ref.set(lastCloseCause, combinedCause).pipe(
                      Effect.andThen(Effect.failCause(combinedCause)),
                    );
                  },
                });
              });
            const recoverWithoutCloseCause = (
              attempt: RetryableConnectionFenceAttempt<PreviewGatewayError>,
            ) =>
              Effect.gen(function* () {
                const recoveryExit = yield* Effect.exit(recoverChannel);
                yield* Match.valueTags(recoveryExit, {
                  Success: () => Ref.set(lastCloseCause, undefined),
                  Failure: ({ cause }) => {
                    attempt.setCloseCause(cause);
                    return Ref.set(lastCloseCause, cause).pipe(
                      Effect.andThen(Effect.failCause(cause)),
                    );
                  },
                });
              });
            const combineCloseCauses = (
              ...causes: ReadonlyArray<Cause.Cause<PreviewGatewayError> | undefined>
            ) => {
              const [first, ...remaining] = causes.filter(
                (cause): cause is Cause.Cause<PreviewGatewayError> => cause !== undefined,
              );
              return first === undefined
                ? undefined
                : remaining.reduce((combined, cause) => Cause.combine(combined, cause), first);
            };
            const scopeExitCause = (scopeExit: Exit.Exit<void, never>) =>
              Exit.isFailure(scopeExit)
                ? Cause.map<never, PreviewGatewayError>(scopeExit.cause, () => unavailable())
                : undefined;
            const attemptConnectionClose = (
              connection: PreviewGatewayRelayConnection,
              timeoutMs: number,
            ) =>
              Effect.gen(function* () {
                const closeResult = yield* Effect.exit(
                  connection.close.pipe(Effect.interruptible),
                ).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
                if (Option.isNone(closeResult)) return Cause.fail(unavailable());
                return yield* Match.valueTags(closeResult.value, {
                  Success: () => Effect.succeed(undefined),
                  Failure: ({ cause }) =>
                    Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(cause),
                });
              });
            const waitForAdapterScopeClose = (timeoutMs: number) =>
              Effect.gen(function* () {
                const result =
                  timeoutMs > 0
                    ? yield* Deferred.await(adapterScopeCloseResult).pipe(
                        Effect.timeoutOption(Duration.millis(timeoutMs)),
                      )
                    : Option.none<Exit.Exit<void, never>>();
                if (Option.isSome(result)) return scopeExitCause(result.value);
                if (yield* Deferred.isDone(adapterScopeCloseResult))
                  return scopeExitCause(yield* Deferred.await(adapterScopeCloseResult));
                return Cause.fail(unavailable());
              });
            const recoverWithCloseCause = (
              attempt: RetryableConnectionFenceAttempt<PreviewGatewayError>,
              closeCause: Cause.Cause<PreviewGatewayError> | undefined,
            ) =>
              closeCause === undefined
                ? recoverWithoutCloseCause(attempt)
                : recoverAfterUnconfirmedClose(attempt, closeCause);
            const retryCompletedAdapterScope = (
              attempt: RetryableConnectionFenceAttempt<PreviewGatewayError>,
              connection: PreviewGatewayRelayConnection | undefined,
            ) =>
              Effect.gen(function* () {
                const scopeExit = yield* Deferred.await(adapterScopeCloseResult);
                let closeCause = combineCloseCauses(
                  scopeExitCause(scopeExit),
                  yield* Ref.get(lastCloseCause),
                );
                const remaining = yield* attempt.closeStageRemainingMs();
                if (connection !== undefined && remaining > 0)
                  closeCause = combineCloseCauses(
                    closeCause,
                    yield* attemptConnectionClose(connection, remaining),
                  );
                yield* recoverWithCloseCause(attempt, closeCause);
              });
            const beginAdapterCloseAttempt = (
              attempt: RetryableConnectionFenceAttempt<PreviewGatewayError>,
              connection: PreviewGatewayRelayConnection | undefined,
            ) =>
              Effect.gen(function* () {
                let closeCause = yield* Ref.get(lastCloseCause);
                const remaining = yield* attempt.closeStageRemainingMs();
                if (
                  connection !== undefined &&
                  !(yield* Ref.get(adapterScopeCloseStarted)) &&
                  remaining > 0
                )
                  closeCause = combineCloseCauses(
                    closeCause,
                    yield* attemptConnectionClose(connection, remaining),
                  );
                if (closeCause !== undefined) {
                  attempt.setCloseCause(closeCause);
                  yield* Ref.set(lastCloseCause, closeCause);
                }
                yield* startAdapterScopeClose;
                const remainingAfterStart = yield* attempt.closeStageRemainingMs();
                closeCause = combineCloseCauses(
                  closeCause,
                  yield* waitForAdapterScopeClose(remainingAfterStart),
                );
                yield* recoverWithCloseCause(attempt, closeCause);
              });
            const close = (attempt: RetryableConnectionFenceAttempt<PreviewGatewayError>) =>
              Effect.gen(function* () {
                const connection = yield* Ref.get(connectionRef);
                const scopeCloseWasStarted = yield* Ref.get(adapterScopeCloseStarted);
                const scopeCloseWasDone =
                  scopeCloseWasStarted && (yield* Deferred.isDone(adapterScopeCloseResult));
                if (scopeCloseWasDone)
                  return yield* retryCompletedAdapterScope(attempt, connection);
                yield* beginAdapterCloseAttempt(attempt, connection);
              });
            const fence = makeRetryableConnectionFence(
              close,
              closed,
              (attempt) =>
                Effect.gen(function* () {
                  let closeCause = attempt.getCloseCause();
                  closeCause = combineCloseCauses(closeCause, yield* Ref.get(lastCloseCause));
                  if (yield* Deferred.isDone(adapterScopeCloseResult)) {
                    const scopeExit = yield* Deferred.await(adapterScopeCloseResult);
                    if (Exit.isFailure(scopeExit))
                      closeCause = combineCloseCauses(
                        closeCause,
                        Cause.map<never, PreviewGatewayError>(scopeExit.cause, () => unavailable()),
                      );
                  }
                  if (closeCause === undefined) return yield* Effect.fail(unavailable());
                  const [reason] = closeCause.reasons;
                  const onlyUnavailableFailure =
                    closeCause.reasons.length === 1 &&
                    reason !== undefined &&
                    Cause.isFailReason(reason) &&
                    reason.error instanceof PreviewGatewayError &&
                    reason.error.reason === "unavailable";
                  return yield* Effect.failCause(
                    onlyUnavailableFailure
                      ? closeCause
                      : Cause.combine(closeCause, Cause.fail(unavailable())),
                  );
                }),
              protect(deletePreviewGatewayChannel(sql, channelIdentity, targetJson)).pipe(
                Effect.tap(() => Ref.set(lastCloseCause, undefined)),
              ),
            );
            const record = {
              channelId,
              userId: principal.userId,
              fence: protect(fence),
            };
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const records = channels.get(route.hostname) ?? new Set<typeof record>();
                records.add(record);
                channels.set(route.hostname, records);
              }),
              () =>
                record.fence.pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      const records = channels.get(route.hostname);
                      records?.delete(record);
                      if (records?.size === 0) channels.delete(route.hostname);
                    }),
                  ),
                  // Scope finalizers cannot expose typed errors; keep every original cause member.
                  Effect.catchCause((cause) =>
                    Effect.failCause(
                      Cause.fromReasons<never>(
                        cause.reasons.map((reason) =>
                          Cause.isFailReason(reason) ? Cause.makeDieReason(reason.error) : reason,
                        ),
                      ),
                    ),
                  ),
                ),
            );
            const connectionExit = yield* Effect.exit(
              adapters
                .connectChannel(channelIdentity)
                .pipe(Effect.provideService(Scope.Scope, adapterScope))
                .pipe(Effect.timeout("5 seconds"), Effect.mapError(unavailable)),
            );
            const connection = yield* Match.valueTags(connectionExit, {
              Success: ({ value }) => Effect.succeed(value),
              Failure: ({ cause }) => Effect.failCause(cause),
            });
            yield* Ref.set(connectionRef, connection);
            yield* Effect.gen(function* () {
              yield* verify(connection, route.target);
              if (
                route.target.kind === "application" &&
                (connection.applicationRequest === undefined ||
                  connection.applicationSocket === undefined)
              )
                return yield* Effect.fail(failure("unsupported"));
              const opened = yield* protect(
                sql`UPDATE preview_gateway_channels SET state='open'
                  WHERE channel_id=${channelId} AND hostname=${route.hostname}
                    AND session_id=${route.target.sessionId}
                    AND generation=${route.target.generation} AND user_id=${principal.userId}
                    AND state='opening' RETURNING channel_id`,
              );
              if (opened.length !== 1) return yield* Effect.fail(unavailable());
            });
            yield* options.controller.watchFences(
              route.target.sessionId,
              record.fence.pipe(
                Effect.catchCause((cause) =>
                  Option.isSome(previewGatewayFailureFromCause(cause))
                    ? Effect.void
                    : Effect.failCause(cause),
                ),
              ),
            );
            let lastValidDeadline = Math.min(initialSession.leaseDeadline, principal.expiresAt);
            const check = (allowRevisionTransition = false) =>
              protect(
                Effect.gen(function* () {
                  if (yield* Deferred.isDone(closed)) return yield* Effect.fail(unavailable());
                  yield* verify(connection, route.target);
                  const session = yield* sql.withTransaction(
                    authorize(
                      route,
                      principal,
                      setup.applicationIdentityMediation === true,
                      allowRevisionTransition,
                    ),
                  );
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
                const deadline = yield* check(allowHmrRevisionTransition);
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
            yield* check(); // Closes the stop/open race after the fence subscription.
            const makeGuard =
              (checkAuthority: () => Effect.Effect<number, PreviewGatewayError>) =>
              <A, E, R>(operation: Effect.Effect<A, E, R>) =>
                Effect.gen(function* () {
                  const deadline = yield* checkAuthority();
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
                );
            const guard = makeGuard(() => check());
            const guardApplicationSocket = makeGuard(() => check(allowHmrRevisionTransition));
            return {
              route,
              principal,
              connection,
              headers: previewGatewayProbeHeaders(request.headers),
              readiness: {
                gateway: "ready",
                relay: "ready",
                application:
                  route.target.kind === "application" &&
                  connection.applicationRequest !== undefined &&
                  connection.applicationSocket !== undefined
                    ? "ready"
                    : "unsupported",
              },
              fenced: Deferred.await(closed),
              guard,
              guardApplicationSocket,
              applicationRequest: (input) => {
                const applicationRequest = connection.applicationRequest;
                if (applicationRequest === undefined || route.target.kind !== "application")
                  return Effect.fail(failure("unsupported"));
                return Effect.gen(function* () {
                  const body =
                    input.body === undefined
                      ? undefined
                      : input.body.pipe(Stream.mapEffect((chunk) => guard(Effect.succeed(chunk))));
                  const response = yield* guard(
                    applicationRequest({
                      ...input,
                      principal,
                      ...(body === undefined ? {} : { body }),
                      maxResponseBytes: previewGatewayMaxApplicationResponseBytes,
                    }),
                  );
                  return {
                    ...response,
                    body: response.body.pipe(
                      Stream.mapEffect((chunk) => guard(Effect.succeed(chunk))),
                    ),
                  };
                });
              },
              applicationDependencyRequest: (group, input) => {
                const adapter = options.adapters?.applicationDependency;
                return protect(
                  adapter === undefined || route.target.kind !== "application"
                    ? Effect.fail(failure("unsupported"))
                    : Effect.gen(function* () {
                        const target = yield* loadDependency(
                          route.target.sessionId,
                          route.target.role,
                          group,
                        );
                        if (
                          target.generation !== route.target.generation ||
                          target.revision !== route.target.revision
                        )
                          return yield* Effect.fail(failure("identity-mismatch"));
                        const allowed = yield* sql.withTransaction(
                          Effect.gen(function* () {
                            const groups =
                              yield* sql`SELECT value FROM preview_session_allowed_work WHERE session_id=${target.sessionId} AND kind='group' AND value=${target.group}`;
                            const endpoints =
                              yield* sql`SELECT value FROM preview_session_allowed_work WHERE session_id=${target.sessionId} AND kind='endpoint' AND value=${target.endpoint}`;
                            return groups.length === 1 && endpoints.length === 1;
                          }),
                        );
                        if (!allowed) return yield* Effect.fail(failure("identity-mismatch"));
                        const body = input.body?.pipe(
                          Stream.mapEffect((chunk) => guard(Effect.succeed(chunk))),
                        );
                        const response = yield* guard(
                          adapter.request(target, {
                            ...input,
                            principal,
                            ...(body === undefined ? {} : { body }),
                            maxResponseBytes: previewGatewayMaxApplicationResponseBytes,
                          }),
                        );
                        return {
                          ...response,
                          body: response.body.pipe(
                            Stream.mapEffect((chunk) => guard(Effect.succeed(chunk))),
                          ),
                        };
                      }),
                );
              },
              applicationDependencySocket: (group, input) => {
                const adapter = options.adapters?.applicationDependency;
                return protect(
                  adapter === undefined || route.target.kind !== "application"
                    ? Effect.fail(failure("unsupported"))
                    : Effect.gen(function* () {
                        const target = yield* loadDependency(
                          route.target.sessionId,
                          route.target.role,
                          group,
                        );
                        if (
                          target.generation !== route.target.generation ||
                          target.revision !== route.target.revision
                        )
                          return yield* Effect.fail(failure("identity-mismatch"));
                        const allowed = yield* sql.withTransaction(
                          Effect.gen(function* () {
                            const groups =
                              yield* sql`SELECT value FROM preview_session_allowed_work WHERE session_id=${target.sessionId} AND kind='group' AND value=${target.group}`;
                            const endpoints =
                              yield* sql`SELECT value FROM preview_session_allowed_work WHERE session_id=${target.sessionId} AND kind='endpoint' AND value=${target.endpoint}`;
                            return groups.length === 1 && endpoints.length === 1;
                          }),
                        );
                        if (!allowed) return yield* Effect.fail(failure("identity-mismatch"));
                        return yield* guard(adapter.socket({ target, ...input, principal }));
                      }),
                );
              },
              applicationSocket: (input) => {
                const applicationSocket = connection.applicationSocket;
                if (
                  applicationSocket === undefined ||
                  route.target.kind !== "application" ||
                  principal.effectivePrincipal === undefined
                )
                  return Effect.fail(failure("unsupported"));
                const guardSocket = allowHmrRevisionTransition ? guardApplicationSocket : guard;
                return guardSocket(applicationSocket({ ...input, principal }));
              },
            } satisfies PreviewGatewayAdmission;
          }),
        ),
    };
    return api;
  });
