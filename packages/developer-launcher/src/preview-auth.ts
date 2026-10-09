import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Cause, Context, Effect, Exit, Layer, Predicate, Schema, Semaphore } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import {
  digestIdentity,
  PreviewSessionError,
  type PreviewSessionControllerApi,
} from "./preview-sessions";

const text = Schema.NonEmptyString.check(Schema.isMaxLength(2048));
const Role = Schema.Literals(["sheet-web", "sheet-auth", "sheet-db-server"]);
export const PreviewAuthBindingSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  role: Role,
  endpoint: text,
});
export type PreviewAuthBinding = typeof PreviewAuthBindingSchema.Type;
export const PreviewEffectivePrincipalSchema = Schema.Struct({
  userId: text,
  accountId: text,
  scopes: Schema.Array(text),
  issuer: text,
  audience: text,
  actorProvenance: text,
});
export type PreviewEffectivePrincipal = typeof PreviewEffectivePrincipalSchema.Type;
export const PreviewAuthClientSchema = Schema.Struct({
  clientId: text,
  callbackUrl: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  issuer: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  audience: text,
  returnUrl: Schema.String.check(Schema.isPattern(/^https:\/\//)),
  ownerKey: text,
});
export type PreviewAuthClient = typeof PreviewAuthClientSchema.Type;

export class PreviewAuthError extends Schema.TaggedErrorClass<PreviewAuthError>()(
  "PreviewAuthError",
  {
    reason: Schema.Literals([
      "unavailable",
      "denied",
      "invalid-request",
      "unauthorized",
      "payload-too-large",
      "stale-session",
    ]),
  },
) {}
type PreviewAuthFailure = PreviewAuthError | PreviewSessionError | SqlError.SqlError;
const fail = (reason: PreviewAuthError["reason"]) => new PreviewAuthError({ reason });
const withAdapterTimeout = <A>(effect: Effect.Effect<A, PreviewAuthError>) =>
  effect.pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError((error) => (Cause.isTimeoutError(error) ? fail("unavailable") : error)),
  );
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const equalDigest = (left: string, right: string) => {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
const redactTextToken = (value: string, accessToken: string) =>
  accessToken.length === 0 ? value : value.split(accessToken).join("[redacted]");
type JsonRedaction = { readonly end: number; readonly text: string; readonly changed: boolean };
const skipJsonWhitespace = (body: string, start: number) => {
  let index = start;
  while (/[\t\n\r ]/.test(body[index] ?? "")) index += 1;
  return index;
};
const readJsonStringEnd = (body: string, start: number) => {
  let index = start + 1;
  while (index < body.length) {
    if (body[index] === '"') return index + 1;
    index += body[index] === "\\" ? 2 : 1;
  }
  throw new Error("invalid JSON string");
};
const isTokenProperty = (key: string) => /^(?:access|refresh)_?token$/i.test(key);
const shouldRedactJsonProperty = (key: string, accessToken: string) =>
  isTokenProperty(key) || (accessToken.length > 0 && key.includes(accessToken));
const redactJsonStringValue = (body: string, start: number, accessToken: string) => {
  const end = readJsonStringEnd(body, start);
  const raw = body.slice(start, end);
  const value = Schema.decodeUnknownSync(Schema.String)(JSON.parse(raw));
  if (accessToken.length > 0 && value.includes(accessToken))
    return { end, text: JSON.stringify(redactTextToken(value, accessToken)), changed: true };
  return { end, text: raw, changed: false };
};
const redactJsonPrimitiveValue = (body: string, start: number): JsonRedaction => {
  let end = start;
  while (end < body.length && !/[\t\n\r ,\]}]/.test(body[end]!)) end += 1;
  if (end === start) throw new Error("invalid JSON value");
  return { end, text: body.slice(start, end), changed: false };
};
function redactJsonValue(
  body: string,
  start: number,
  accessToken: string,
  depth = 0,
): JsonRedaction {
  if (depth > 128) throw new Error("JSON nesting exceeds redaction limit");
  const index = skipJsonWhitespace(body, start);
  if (body[index] === "{") return redactJsonObject(body, index, accessToken, depth + 1);
  if (body[index] === "[") return redactJsonArray(body, index, accessToken, depth + 1);
  if (body[index] === '"') return redactJsonStringValue(body, index, accessToken);
  return redactJsonPrimitiveValue(body, index);
}
function redactJsonObject(
  body: string,
  start: number,
  accessToken: string,
  depth: number,
): JsonRedaction {
  let index = skipJsonWhitespace(body, start + 1);
  if (body[index] === "}")
    return { end: index + 1, text: body.slice(start, index + 1), changed: false };
  const properties: Array<string> = [];
  let changed = false;
  while (index < body.length) {
    const keyStart = index;
    const keyEnd = readJsonStringEnd(body, keyStart);
    const key = Schema.decodeUnknownSync(Schema.String)(JSON.parse(body.slice(keyStart, keyEnd)));
    const colon = skipJsonWhitespace(body, keyEnd);
    if (body[colon] !== ":") throw new Error("invalid JSON object");
    const valueStart = skipJsonWhitespace(body, colon + 1);
    const value = redactJsonValue(body, valueStart, accessToken, depth + 1);
    if (shouldRedactJsonProperty(key, accessToken)) changed = true;
    else {
      properties.push(`${body.slice(keyStart, valueStart)}${value.text}`);
      changed ||= value.changed;
    }
    index = skipJsonWhitespace(body, value.end);
    if (body[index] === "}") {
      const end = index + 1;
      return {
        end,
        text: changed ? `{${properties.join(",")}}` : body.slice(start, end),
        changed,
      };
    }
    if (body[index] !== ",") throw new Error("invalid JSON object separator");
    index = skipJsonWhitespace(body, index + 1);
  }
  throw new Error("unterminated JSON object");
}
function redactJsonArray(
  body: string,
  start: number,
  accessToken: string,
  depth: number,
): JsonRedaction {
  let index = skipJsonWhitespace(body, start + 1);
  if (body[index] === "]")
    return { end: index + 1, text: body.slice(start, index + 1), changed: false };
  const values: Array<string> = [];
  let changed = false;
  while (index < body.length) {
    const value = redactJsonValue(body, index, accessToken, depth + 1);
    values.push(value.text);
    changed ||= value.changed;
    index = skipJsonWhitespace(body, value.end);
    if (body[index] === "]") {
      const end = index + 1;
      return { end, text: changed ? `[${values.join(",")}]` : body.slice(start, end), changed };
    }
    if (body[index] !== ",") throw new Error("invalid JSON array separator");
    index = skipJsonWhitespace(body, index + 1);
  }
  throw new Error("unterminated JSON array");
}
const redactTokenEcho = (body: string, accessToken: string) => {
  try {
    JSON.parse(body);
    const redacted = redactJsonValue(body, 0, accessToken);
    return redacted.changed ? redacted.text : body;
  } catch {
    return redactTextToken(body, accessToken);
  }
};

/** OAuth and credential custody are adapters so live support requires verified operator setup. */
export interface PreviewAuthAdapters {
  /** Fresh operator evidence that exact session callbacks and owner-scoped cleanup are supported. */
  readonly checkSetup: Effect.Effect<void, PreviewAuthError>;
  /** Repeated calls for a binding must not create unbounded duplicate registrations. */
  readonly provisionClient: (input: {
    readonly binding: PreviewAuthBinding;
    readonly callbackUrl: string;
    readonly returnUrl: string;
  }) => Effect.Effect<PreviewAuthClient, PreviewAuthError>;
  /** Idempotently remove and fence this owner key, including any in-flight or late provisioning. */
  readonly removeClientRegistration: (
    binding: PreviewAuthBinding,
    ownerKey: string,
  ) => Effect.Effect<void, PreviewAuthError>;
  readonly removeClient: (client: PreviewAuthClient) => Effect.Effect<void, PreviewAuthError>;
  readonly authorizationUrl: (input: {
    readonly client: PreviewAuthClient;
    readonly state: string;
    readonly codeChallenge: string;
    readonly codeChallengeMethod: "S256";
  }) => Effect.Effect<string, PreviewAuthError>;
  /** Verifies the shared login server-side and resolves the same effective user identity. */
  readonly exchangeCallback: (input: {
    readonly client: PreviewAuthClient;
    readonly code: string;
    readonly verifier: string;
  }) => Effect.Effect<
    {
      readonly principal: PreviewEffectivePrincipal;
      readonly upstreamAccessToken: string;
      readonly upstreamRefreshToken?: string;
      readonly expiresAt: number;
    },
    PreviewAuthError
  >;
  readonly storeUpstreamTokens: (input: {
    readonly key: string;
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly expiresAt: number;
  }) => Effect.Effect<void, PreviewAuthError>;
  readonly readUpstreamToken: (key: string) => Effect.Effect<
    {
      readonly accessToken: string;
      readonly expiresAt: number;
    },
    PreviewAuthError
  >;
  readonly refreshUpstreamTokens: (key: string) => Effect.Effect<void, PreviewAuthError>;
  readonly removeUpstreamTokens: (key: string) => Effect.Effect<void, PreviewAuthError>;
  readonly mintPreviewCredential: (input: {
    readonly principal: PreviewEffectivePrincipal;
    readonly binding: PreviewAuthBinding;
    readonly expiresAt: number;
  }) => Effect.Effect<string, PreviewAuthError>;
  readonly verifyPreviewCredential: (credential: string) => Effect.Effect<
    {
      readonly principal: PreviewEffectivePrincipal;
      readonly binding: PreviewAuthBinding;
      readonly expiresAt: number;
    },
    PreviewAuthError
  >;
  /** Proxies one authorized request without returning upstream credentials to the caller. */
  readonly protectedRequest: (input: {
    readonly endpoint: string;
    readonly path: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly accessToken: string;
  }) => Effect.Effect<
    {
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    },
    PreviewAuthError
  >;
}

export interface PreviewAuthApi {
  readonly configured: boolean;
  readonly provision: (input: {
    readonly binding: PreviewAuthBinding;
    readonly returnUrl: string;
    readonly ownerKey: string;
  }) => Effect.Effect<PreviewAuthClient, PreviewAuthFailure>;
  readonly start: (input: {
    readonly binding: PreviewAuthBinding;
    readonly origin: string;
    readonly returnUrl: string;
  }) => Effect.Effect<
    { readonly authorizationUrl: string; readonly stateCookie: string },
    PreviewAuthFailure
  >;
  readonly callback: (input: {
    readonly binding: PreviewAuthBinding;
    readonly stateCookie: string;
    readonly state: string;
    readonly code: string;
    readonly origin: string;
  }) => Effect.Effect<
    {
      readonly credential: string;
      readonly principal: PreviewEffectivePrincipal;
      readonly returnUrl: string;
    },
    PreviewAuthFailure
  >;
  readonly request: (input: {
    readonly binding: PreviewAuthBinding;
    readonly credential: string;
    readonly origin: string;
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly body?: string;
  }) => Effect.Effect<
    {
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    },
    PreviewAuthFailure
  >;
  readonly cleanupSession: (
    sessionId: string,
    ownerIdentity: string,
  ) => Effect.Effect<void, PreviewAuthFailure>;
}
export class PreviewAuth extends Context.Service<PreviewAuth, PreviewAuthApi>()(
  "developer-launcher/PreviewAuth",
) {}
export const PreviewAuthLayer = (api: PreviewAuthApi) => Layer.succeed(PreviewAuth, api);

/** Durable OAuth state and token references share the existing controller database. */
export const makePreviewAuth = (options: {
  readonly domain: string;
  readonly callbackPath: string;
  readonly allowedReturnOrigins: ReadonlySet<string>;
  readonly controller: PreviewSessionControllerApi;
  readonly adapters?: PreviewAuthAdapters;
  readonly now: () => number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const keyedEffectLocks = new Map<
      string,
      { readonly semaphore: Semaphore.Semaphore; users: number }
    >();
    const withKeyedLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const lock = yield* Effect.sync(() => {
          let existing = keyedEffectLocks.get(key);
          if (!existing) {
            existing = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
            keyedEffectLocks.set(key, existing);
          }
          existing.users += 1;
          return existing;
        });
        return yield* lock.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              lock.users -= 1;
              if (lock.users === 0) keyedEffectLocks.delete(key);
            }),
          ),
        );
      });
    const configured =
      options.adapters !== undefined &&
      options.domain.length > 0 &&
      options.callbackPath.startsWith("/") &&
      !options.callbackPath.includes("?");
    yield* sql`CREATE TABLE IF NOT EXISTS preview_auth_clients (session_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL, endpoint TEXT NOT NULL, owner_key TEXT NOT NULL, client TEXT NOT NULL, PRIMARY KEY(session_id,generation,role))`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_auth_client_owners (session_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL, endpoint TEXT NOT NULL, owner_key TEXT NOT NULL, PRIMARY KEY(session_id,generation,role))`;
    yield* sql`INSERT OR IGNORE INTO preview_auth_client_owners (session_id,generation,role,endpoint,owner_key) SELECT session_id,generation,role,endpoint,owner_key FROM preview_auth_clients`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_auth_pending (state_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL, endpoint TEXT NOT NULL, verifier TEXT NOT NULL, client_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_auth_sessions (session_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL, endpoint TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL, issuer TEXT NOT NULL, audience TEXT NOT NULL, actor_provenance TEXT NOT NULL, token_key TEXT NOT NULL, credential_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(session_id,generation,role,user_id))`;
    const previewAuthSessionColumns = yield* sql`PRAGMA table_info(preview_auth_sessions)`;
    if (!previewAuthSessionColumns.some((column) => String(column.name) === "account_id"))
      yield* sql`ALTER TABLE preview_auth_sessions ADD COLUMN account_id TEXT NOT NULL DEFAULT ''`;
    yield* sql`CREATE TABLE IF NOT EXISTS preview_auth_token_keys (session_id TEXT NOT NULL, generation INTEGER NOT NULL, role TEXT NOT NULL, token_key TEXT NOT NULL PRIMARY KEY)`;
    yield* sql`INSERT OR IGNORE INTO preview_auth_token_keys (session_id,generation,role,token_key) SELECT session_id,generation,role,token_key FROM preview_auth_sessions`;
    const unsupported = () => Effect.fail(fail("unavailable"));
    const requireSetup = () =>
      options.adapters?.checkSetup.pipe(
        Effect.timeout("5 seconds"),
        Effect.mapError(() => fail("unavailable")),
      ) ?? unsupported();
    const validOrigin = (origin: string, binding: PreviewAuthBinding) => {
      try {
        const value = new URL(origin);
        const endpoint = new URL(binding.endpoint);
        return Predicate.and(
          (candidate: URL) => candidate.protocol === "https:",
          (candidate: URL) => candidate.host === endpoint.host,
        )(value);
      } catch {
        return false;
      }
    };
    const live = (binding: PreviewAuthBinding) =>
      options.controller
        .authorizeCredential(binding.sessionId, binding.generation, binding.role)
        .pipe(Effect.mapError(() => fail("stale-session")));
    const prepareSession = (binding: PreviewAuthBinding) =>
      Effect.gen(function* () {
        const adapters = options.adapters;
        if (!configured || adapters === undefined) return yield* unsupported();
        yield* requireSetup();
        yield* live(binding);
        return adapters;
      });
    const isApprovedReturnUrl = (binding: PreviewAuthBinding, returnUrl: string) => {
      try {
        const endpoint = new URL(binding.endpoint);
        const isApprovedOrigin = Predicate.and(
          (url: URL) => url.origin === endpoint.origin,
          (url: URL) => options.allowedReturnOrigins.has(url.origin),
        );
        return isApprovedOrigin(new URL(returnUrl));
      } catch {
        return false;
      }
    };
    const isPermittedRequestPath = (path: string, endpoint: string) => {
      const hasSafeSyntax = Predicate.and(
        (value: string) => !value.startsWith("//"),
        Predicate.and(
          (value: string) => !value.includes("\\"),
          (value: string) => !/[\r\n]/.test(value),
        ),
      );
      if (!hasSafeSyntax(path)) return false;
      try {
        const endpointUrl = new URL(endpoint);
        const destination = new URL(path, endpoint);
        const isAllowedDestination = Predicate.and(
          (url: URL) => url.origin === endpointUrl.origin,
          (url: URL) =>
            !Array.from(url.searchParams.keys()).some((key) =>
              /^(?:access_token|refresh_token|authorization)$/i.test(key),
            ),
        );
        return isAllowedDestination(destination);
      } catch {
        return false;
      }
    };
    const lifecycleSensitivePathPattern =
      /^\/(?:zero(?:\/|$)|workflows(?:\/|$)|internal\/rollout-gates(?:\/|$))/i;
    const isLifecycleSensitivePath = (path: string, endpoint: string) => {
      try {
        const url = new URL(path, endpoint);
        // URL.pathname preserves escapes; downstream routers may decode them before matching.
        const decodedPathname = decodeURIComponent(url.pathname);
        if (decodedPathname.startsWith("//") || /[?#]/.test(decodedPathname)) return true;
        const pathname = new URL(decodedPathname, "https://preview.invalid").pathname;
        return lifecycleSensitivePathPattern.test(pathname);
      } catch {
        return true;
      }
    };
    // Zero mutations/queries and workflow APIs have durable acceptance points.
    // The generic HTTP proxy cannot make the controller's lifecycle check
    // atomic with those backend commits, so these routes stay unavailable until
    // their owning adapters implement that acceptance protocol.
    const requiresLifecycleAcceptance = (method: string, path: string, endpoint: string) =>
      method !== "GET" || isLifecycleSensitivePath(path, endpoint);
    type PrincipalPair = readonly [PreviewEffectivePrincipal, PreviewEffectivePrincipal];
    const matchesPrincipal = Predicate.and(
      (pair: PrincipalPair) => pair[0].userId === pair[1].userId,
      Predicate.and(
        (pair: PrincipalPair) => pair[0].accountId === pair[1].accountId,
        Predicate.and(
          (pair: PrincipalPair) => pair[0].scopes.join(" ") === pair[1].scopes.join(" "),
          Predicate.and(
            (pair: PrincipalPair) => pair[0].issuer === pair[1].issuer,
            Predicate.and(
              (pair: PrincipalPair) => pair[0].audience === pair[1].audience,
              (pair: PrincipalPair) => pair[0].actorProvenance === pair[1].actorProvenance,
            ),
          ),
        ),
      ),
    );
    type BindingPair = readonly [PreviewAuthBinding, PreviewAuthBinding];
    const matchesBinding = Predicate.and(
      (pair: BindingPair) => pair[0].sessionId === pair[1].sessionId,
      Predicate.and(
        (pair: BindingPair) => pair[0].generation === pair[1].generation,
        Predicate.and(
          (pair: BindingPair) => pair[0].role === pair[1].role,
          (pair: BindingPair) => pair[0].endpoint === pair[1].endpoint,
        ),
      ),
    );
    const readCredentialSession = (
      binding: PreviewAuthBinding,
      credential: string,
      userId: string,
    ) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT token_key,credential_hash,expires_at,user_id,account_id,scopes,issuer,audience,actor_provenance FROM preview_auth_sessions WHERE session_id=${binding.sessionId} AND generation=${binding.generation} AND role=${binding.role} AND endpoint=${binding.endpoint} AND user_id=${userId}`;
        const session = rows[0];
        if (
          !session ||
          Number(session.expires_at) <= options.now() ||
          !equalDigest(String(session.credential_hash), digest(credential))
        )
          return yield* fail("denied");
        return session;
      });
    const verifyCredentialPrincipal = (
      session: Record<string, unknown>,
      principal: PreviewEffectivePrincipal,
    ) =>
      Schema.decodeUnknownEffect(PreviewEffectivePrincipalSchema)({
        userId: session.user_id,
        accountId: session.account_id,
        scopes: JSON.parse(String(session.scopes)),
        issuer: session.issuer,
        audience: session.audience,
        actorProvenance: session.actor_provenance,
      }).pipe(
        Effect.mapError(() => fail("denied")),
        Effect.flatMap((stored) =>
          matchesPrincipal([stored, principal])
            ? Effect.succeed(stored)
            : Effect.fail(fail("denied")),
        ),
      );
    const persistSessionCredential = (
      adapters: PreviewAuthAdapters,
      binding: PreviewAuthBinding,
      principal: PreviewEffectivePrincipal,
      tokenKey: string,
      exchange: {
        readonly upstreamAccessToken: string;
        readonly upstreamRefreshToken?: string;
        readonly expiresAt: number;
      },
    ) =>
      Effect.gen(function* () {
        const operation = Effect.gen(function* () {
          const expiresAt = options.now() + 15 * 60_000;
          yield* sql`INSERT INTO preview_auth_token_keys (session_id,generation,role,token_key) VALUES (${binding.sessionId},${binding.generation},${binding.role},${tokenKey})`;
          yield* withAdapterTimeout(
            adapters.storeUpstreamTokens({
              key: tokenKey,
              accessToken: exchange.upstreamAccessToken,
              ...(exchange.upstreamRefreshToken === undefined
                ? {}
                : { refreshToken: exchange.upstreamRefreshToken }),
              expiresAt: exchange.expiresAt,
            }),
          );
          const credential = yield* withAdapterTimeout(
            adapters.mintPreviewCredential({
              principal,
              binding,
              expiresAt,
            }),
          );
          const credentialHash = digest(credential);
          const prior =
            yield* sql`SELECT token_key FROM preview_auth_sessions WHERE session_id=${binding.sessionId} AND generation=${binding.generation} AND role=${binding.role} AND user_id=${principal.userId}`;
          yield* sql`INSERT OR REPLACE INTO preview_auth_sessions (session_id,generation,role,endpoint,user_id,account_id,scopes,issuer,audience,actor_provenance,token_key,credential_hash,expires_at) VALUES (${binding.sessionId},${binding.generation},${binding.role},${binding.endpoint},${principal.userId},${principal.accountId},${JSON.stringify(principal.scopes)},${principal.issuer},${principal.audience},${principal.actorProvenance},${tokenKey},${credentialHash},${expiresAt})`;
          for (const row of prior) {
            const priorTokenKey = String(row.token_key);
            if (priorTokenKey !== tokenKey) {
              const removed = yield* Effect.exit(
                withAdapterTimeout(adapters.removeUpstreamTokens(priorTokenKey)),
              );
              if (Exit.isSuccess(removed))
                yield* sql`DELETE FROM preview_auth_token_keys WHERE token_key=${priorTokenKey}`;
            }
          }
          return credential;
        });
        const result = yield* Effect.exit(operation);
        if (Exit.isFailure(result)) {
          const removed = yield* Effect.exit(
            withAdapterTimeout(adapters.removeUpstreamTokens(tokenKey)),
          );
          if (Exit.isSuccess(removed))
            yield* sql`DELETE FROM preview_auth_token_keys WHERE token_key=${tokenKey}`;
          return yield* Effect.failCause(result.cause);
        }
        return result.value;
      });
    const removePersistedCredential = (
      adapters: PreviewAuthAdapters,
      binding: PreviewAuthBinding,
      userId: string,
      tokenKey: string,
    ) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM preview_auth_sessions WHERE session_id=${binding.sessionId} AND generation=${binding.generation} AND role=${binding.role} AND user_id=${userId} AND token_key=${tokenKey}`;
        const removed = yield* Effect.exit(
          withAdapterTimeout(adapters.removeUpstreamTokens(tokenKey)),
        );
        if (Exit.isSuccess(removed))
          yield* sql`DELETE FROM preview_auth_token_keys WHERE token_key=${tokenKey}`;
      });
    const readCurrentToken = (
      binding: PreviewAuthBinding,
      adapters: PreviewAuthAdapters,
      tokenKey: string,
    ) =>
      Effect.gen(function* () {
        let token = yield* withAdapterTimeout(adapters.readUpstreamToken(tokenKey));
        if (token.accessToken.length === 0) return yield* fail("unavailable");
        if (token.expiresAt <= options.now()) {
          token = yield* withKeyedLock(
            `upstream-refresh:${tokenKey}`,
            Effect.gen(function* () {
              const current = yield* withAdapterTimeout(adapters.readUpstreamToken(tokenKey));
              if (current.accessToken.length === 0) return yield* fail("unavailable");
              if (current.expiresAt > options.now()) return current;
              yield* live(binding);
              yield* withAdapterTimeout(adapters.refreshUpstreamTokens(tokenKey));
              yield* live(binding);
              return yield* withAdapterTimeout(adapters.readUpstreamToken(tokenKey));
            }),
          );
          if (token.accessToken.length === 0) return yield* fail("unavailable");
        }
        if (token.expiresAt <= options.now()) return yield* fail("stale-session");
        return token;
      });
    const proxyHeaders = (headers: Readonly<Record<string, string | undefined>>) => {
      const safe: Record<string, string> = {};
      for (const key of ["accept", "content-type", "if-none-match"]) {
        const value = headers[key];
        if (value && !/[\r\n]/.test(value)) safe[key] = value;
      }
      return safe;
    };
    const proxyResponse = (
      response: {
        readonly status: number;
        readonly headers: Readonly<Record<string, string>>;
        readonly body: string;
      },
      accessToken: string,
    ) => {
      const headers: Record<string, string> = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      for (const key of ["content-type", "etag"]) {
        const value = response.headers[key];
        if (value && !/[\r\n]/.test(value)) headers[key] = value;
      }
      return {
        status: response.status,
        headers,
        body: redactTokenEcho(response.body, accessToken),
      };
    };
    const loadClient = (binding: PreviewAuthBinding) =>
      Effect.gen(function* () {
        const rows =
          yield* sql`SELECT client FROM preview_auth_clients WHERE session_id=${binding.sessionId} AND generation=${binding.generation} AND role=${binding.role} AND endpoint=${binding.endpoint}`;
        if (!rows[0] || !options.adapters) return yield* fail("unavailable");
        return yield* Schema.decodeUnknownEffect(PreviewAuthClientSchema)(
          JSON.parse(String(rows[0].client)),
        ).pipe(Effect.mapError(() => fail("unavailable")));
      });
    const validateProvisionedClient = (
      client: PreviewAuthClient,
      expected: Pick<PreviewAuthClient, "ownerKey" | "callbackUrl" | "returnUrl">,
      adapters: PreviewAuthAdapters,
    ) =>
      Schema.decodeUnknownEffect(PreviewAuthClientSchema)(client).pipe(
        Effect.mapError(() => fail("unavailable")),
        Effect.flatMap((verified) => {
          if (verified.ownerKey !== expected.ownerKey) return Effect.fail(fail("denied"));
          return verified.callbackUrl === expected.callbackUrl &&
            verified.returnUrl === expected.returnUrl
            ? Effect.succeed(verified)
            : withAdapterTimeout(adapters.removeClient(verified)).pipe(
                Effect.andThen(Effect.fail(fail("denied"))),
              );
        }),
      );
    const persistClient = (
      binding: PreviewAuthBinding,
      ownerKey: string,
      client: PreviewAuthClient,
      adapters: PreviewAuthAdapters,
    ) =>
      Effect.gen(function* () {
        yield* sql`INSERT OR IGNORE INTO preview_auth_clients (session_id,generation,role,endpoint,owner_key,client) VALUES (${binding.sessionId},${binding.generation},${binding.role},${binding.endpoint},${ownerKey},${JSON.stringify(client)})`;
        const rows =
          yield* sql`SELECT endpoint,owner_key,client FROM preview_auth_clients WHERE session_id=${binding.sessionId} AND generation=${binding.generation} AND role=${binding.role}`;
        const row = rows[0];
        if (!row) return yield* fail("unavailable");
        const registered = yield* Schema.decodeUnknownEffect(PreviewAuthClientSchema)(
          JSON.parse(String(row.client)),
        ).pipe(Effect.mapError(() => fail("unavailable")));
        const matchesRequest =
          row.endpoint === binding.endpoint &&
          row.owner_key === ownerKey &&
          registered.ownerKey === ownerKey &&
          registered.callbackUrl === client.callbackUrl &&
          registered.returnUrl === client.returnUrl;
        if (client.ownerKey === ownerKey && registered.clientId !== client.clientId)
          yield* withAdapterTimeout(adapters.removeClient(client));
        if (!matchesRequest) return yield* fail("denied");
        return registered;
      });
    const recordClientOwner = (binding: PreviewAuthBinding, ownerKey: string) =>
      Effect.gen(function* () {
        yield* sql`INSERT OR IGNORE INTO preview_auth_client_owners (session_id,generation,role,endpoint,owner_key) VALUES (${binding.sessionId},${binding.generation},${binding.role},${binding.endpoint},${ownerKey})`;
        const rows =
          yield* sql`SELECT endpoint,owner_key FROM preview_auth_client_owners WHERE session_id=${binding.sessionId} AND generation=${binding.generation} AND role=${binding.role}`;
        if (!rows[0] || rows[0].endpoint !== binding.endpoint || rows[0].owner_key !== ownerKey)
          return yield* fail("denied");
      });
    const provisionAndPersistClient = (
      binding: PreviewAuthBinding,
      callbackUrl: string,
      returnUrl: string,
      ownerKey: string,
      adapters: PreviewAuthAdapters,
    ) =>
      Effect.gen(function* () {
        const provisioned = yield* Effect.exit(
          withAdapterTimeout(adapters.provisionClient({ binding, callbackUrl, returnUrl })),
        );
        if (Exit.isFailure(provisioned)) {
          const removed = yield* Effect.exit(
            withAdapterTimeout(adapters.removeClientRegistration(binding, ownerKey)),
          );
          if (Exit.isSuccess(removed))
            yield* sql`DELETE FROM preview_auth_client_owners WHERE session_id=${binding.sessionId} AND generation=${binding.generation} AND role=${binding.role} AND owner_key=${ownerKey}`;
          return yield* Effect.failCause(provisioned.cause);
        }
        const verified = yield* validateProvisionedClient(
          provisioned.value,
          { ownerKey, callbackUrl, returnUrl },
          adapters,
        );
        return yield* persistClient(binding, ownerKey, verified, adapters);
      });
    type RegisteredClientCheck = readonly [PreviewAuthClient, PreviewAuthBinding, string];
    const isRegisteredClient = Predicate.and(
      (check: RegisteredClientCheck) =>
        check[0].ownerKey === `${check[1].sessionId}:${check[1].generation}:${check[1].role}`,
      Predicate.and(
        (check: RegisteredClientCheck) =>
          check[0].callbackUrl ===
          `https://${new URL(check[1].endpoint).host}${options.callbackPath}`,
        (check: RegisteredClientCheck) => check[0].returnUrl === check[2],
      ),
    );
    const authorizeRequest = (
      input: Parameters<PreviewAuthApi["request"]>[0],
      adapters: PreviewAuthAdapters,
    ) =>
      Effect.gen(function* () {
        if (requiresLifecycleAcceptance(input.method, input.path, input.binding.endpoint))
          return yield* fail("unavailable");
        if (
          !validOrigin(input.origin, input.binding) ||
          !/^(GET|POST|PUT|PATCH|DELETE)$/.test(input.method) ||
          !isPermittedRequestPath(input.path, input.binding.endpoint)
        )
          return yield* fail("denied");
        const verified = yield* withAdapterTimeout(
          adapters.verifyPreviewCredential(input.credential),
        );
        if (
          !matchesBinding([verified.binding, input.binding]) ||
          verified.expiresAt <= options.now()
        )
          return yield* fail("denied");
        const session = yield* readCredentialSession(
          input.binding,
          input.credential,
          verified.principal.userId,
        );
        yield* verifyCredentialPrincipal(session, verified.principal);
        return { destination: new URL(input.path, input.binding.endpoint), session };
      });
    const verifyCleanupOwner = (sessionId: string, ownerIdentity: string) =>
      Effect.gen(function* () {
        const owner =
          yield* sql`SELECT identity_digest FROM preview_sessions WHERE id=${sessionId}`;
        if (!owner[0]) return yield* fail("denied");
        if (!equalDigest(String(owner[0].identity_digest), digestIdentity(ownerIdentity)))
          return yield* fail("denied");
      });
    const verifySessionEnded = (sessionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql`SELECT ended_at FROM preview_sessions WHERE id=${sessionId}`;
        if (!rows[0] || rows[0].ended_at === null) return yield* fail("denied");
      });
    const removeOwnedSessionClients = (sessionId: string, adapters: PreviewAuthAdapters) =>
      Effect.gen(function* () {
        const clients =
          yield* sql`SELECT generation,role,client FROM preview_auth_clients WHERE session_id=${sessionId}`;
        for (const row of clients) {
          const client = yield* Schema.decodeUnknownEffect(PreviewAuthClientSchema)(
            JSON.parse(String(row.client)),
          ).pipe(Effect.mapError(() => fail("unavailable")));
          if (client.ownerKey === `${sessionId}:${String(row.generation)}:${String(row.role)}`) {
            yield* withAdapterTimeout(adapters.removeClient(client));
            yield* sql`DELETE FROM preview_auth_clients WHERE session_id=${sessionId} AND generation=${Number(row.generation)} AND role=${String(row.role)} AND owner_key=${client.ownerKey}`;
          }
        }
      });
    const removeSessionClientRegistrations = (sessionId: string, adapters: PreviewAuthAdapters) =>
      Effect.gen(function* () {
        const registrations =
          yield* sql`SELECT generation,role,endpoint,owner_key FROM preview_auth_client_owners WHERE session_id=${sessionId}`;
        for (const row of registrations) {
          const binding = yield* Schema.decodeUnknownEffect(PreviewAuthBindingSchema)({
            sessionId,
            generation: Number(row.generation),
            role: row.role,
            endpoint: row.endpoint,
          }).pipe(Effect.mapError(() => fail("unavailable")));
          yield* withAdapterTimeout(
            adapters.removeClientRegistration(binding, String(row.owner_key)),
          );
          yield* sql`DELETE FROM preview_auth_client_owners WHERE session_id=${sessionId} AND generation=${binding.generation} AND role=${binding.role} AND owner_key=${String(row.owner_key)}`;
        }
      });
    const removeSessionTokenCopies = (sessionId: string, adapters: PreviewAuthAdapters) =>
      Effect.gen(function* () {
        const tokenRows =
          yield* sql`SELECT DISTINCT token_key FROM preview_auth_token_keys WHERE session_id=${sessionId}`;
        for (const row of tokenRows)
          yield* withAdapterTimeout(adapters.removeUpstreamTokens(String(row.token_key)));
      });
    const api: PreviewAuthApi = {
      configured,
      provision: (input) =>
        withKeyedLock(
          `preview-auth-client:${input.binding.sessionId}:${input.binding.generation}:${input.binding.role}`,
          Effect.gen(function* () {
            const adapters = yield* prepareSession(input.binding);
            const callbackUrl = `https://${new URL(input.binding.endpoint).host}${options.callbackPath}`;
            const expectedOwner = `${input.binding.sessionId}:${input.binding.generation}:${input.binding.role}`;
            if (
              input.ownerKey !== expectedOwner ||
              !isApprovedReturnUrl(input.binding, input.returnUrl)
            )
              return yield* fail("denied");
            yield* recordClientOwner(input.binding, expectedOwner);
            const registered =
              yield* sql`SELECT endpoint,owner_key,client FROM preview_auth_clients WHERE session_id=${input.binding.sessionId} AND generation=${input.binding.generation} AND role=${input.binding.role}`;
            if (registered[0]) {
              const client = yield* Schema.decodeUnknownEffect(PreviewAuthClientSchema)(
                JSON.parse(String(registered[0].client)),
              ).pipe(Effect.mapError(() => fail("unavailable")));
              if (
                registered[0].endpoint !== input.binding.endpoint ||
                registered[0].owner_key !== expectedOwner ||
                client.ownerKey !== expectedOwner ||
                client.callbackUrl !== callbackUrl ||
                client.returnUrl !== input.returnUrl
              )
                return yield* fail("denied");
              return client;
            }
            return yield* provisionAndPersistClient(
              input.binding,
              callbackUrl,
              input.returnUrl,
              expectedOwner,
              adapters,
            );
          }),
        ),
      start: (input) =>
        Effect.gen(function* () {
          const adapters = yield* prepareSession(input.binding);
          if (
            !validOrigin(input.origin, input.binding) ||
            !isApprovedReturnUrl(input.binding, input.returnUrl)
          )
            return yield* fail("denied");
          const client = yield* loadClient(input.binding).pipe(
            Effect.catch(() => Effect.fail(fail("unavailable"))),
          );
          if (!isRegisteredClient([client, input.binding, input.returnUrl]))
            return yield* fail("denied");
          const state = randomBytes(32).toString("base64url");
          const verifier = randomBytes(32).toString("base64url");
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          const now = options.now();
          const expiresAt = now + 5 * 60_000;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM preview_auth_pending WHERE expires_at<=${now}`;
              const pendingRows =
                yield* sql`SELECT COUNT(*) AS count FROM preview_auth_pending WHERE session_id=${input.binding.sessionId} AND generation=${input.binding.generation} AND role=${input.binding.role}`;
              if (Number(pendingRows[0]?.count ?? 0) >= 5) return yield* fail("unavailable");
              yield* sql`INSERT INTO preview_auth_pending (state_hash,session_id,generation,role,endpoint,verifier,client_id,expires_at) VALUES (${digest(state)},${input.binding.sessionId},${input.binding.generation},${input.binding.role},${input.binding.endpoint},${verifier},${client.clientId},${expiresAt})`;
            }),
          );
          return {
            authorizationUrl: yield* withAdapterTimeout(
              adapters.authorizationUrl({
                client,
                state,
                codeChallenge: challenge,
                codeChallengeMethod: "S256",
              }),
            ),
            stateCookie: state,
          };
        }),
      callback: (input) =>
        Effect.gen(function* () {
          const adapters = yield* prepareSession(input.binding);
          if (
            !validOrigin(input.origin, input.binding) ||
            !equalDigest(digest(input.state), digest(input.stateCookie))
          )
            return yield* fail("denied");
          const stateHash = digest(input.state);
          const rows =
            yield* sql`DELETE FROM preview_auth_pending WHERE state_hash=${stateHash} AND session_id=${input.binding.sessionId} AND generation=${input.binding.generation} AND role=${input.binding.role} AND endpoint=${input.binding.endpoint} AND expires_at>${options.now()} RETURNING verifier,client_id`;
          const pending = rows[0];
          if (!pending) return yield* fail("denied");
          const client = yield* loadClient(input.binding);
          if (pending.client_id !== client.clientId) return yield* fail("denied");
          const exchange = yield* withAdapterTimeout(
            adapters.exchangeCallback({
              client,
              code: input.code,
              verifier: String(pending.verifier),
            }),
          );
          yield* live(input.binding);
          const principal = yield* Schema.decodeUnknownEffect(PreviewEffectivePrincipalSchema)(
            exchange.principal,
          ).pipe(Effect.mapError(() => fail("denied")));
          if (exchange.upstreamAccessToken.length === 0) return yield* fail("unavailable");
          if (principal.issuer !== client.issuer || principal.audience !== client.audience)
            return yield* fail("denied");
          const tokenKey = `${input.binding.sessionId}:${input.binding.generation}:${input.binding.role}:${principal.userId}:${randomBytes(16).toString("hex")}`;
          const credential = yield* persistSessionCredential(
            adapters,
            input.binding,
            principal,
            tokenKey,
            exchange,
          );
          const sessionLive = yield* Effect.exit(live(input.binding));
          if (Exit.isFailure(sessionLive)) {
            yield* removePersistedCredential(adapters, input.binding, principal.userId, tokenKey);
            return yield* Effect.failCause(sessionLive.cause);
          }
          return { credential, principal, returnUrl: client.returnUrl };
        }),
      request: (input) =>
        Effect.gen(function* () {
          const adapters = yield* prepareSession(input.binding);
          const { destination, session } = yield* authorizeRequest(input, adapters);
          const token = yield* readCurrentToken(input.binding, adapters, String(session.token_key));
          // Token refresh and storage reads may take time. Recheck immediately
          // before dispatch so a stopped or expired session cannot begin a new
          // upstream operation. Durable routes are rejected above because this
          // check alone cannot fence their commit boundary.
          yield* live(input.binding);
          const response = yield* withAdapterTimeout(
            adapters.protectedRequest({
              endpoint: input.binding.endpoint,
              path: `${destination.pathname}${destination.search}`,
              method: input.method,
              headers: proxyHeaders(input.headers),
              ...(input.body === undefined ? {} : { body: input.body }),
              accessToken: token.accessToken,
            }),
          );
          yield* live(input.binding);
          return proxyResponse(response, token.accessToken);
        }),
      cleanupSession: (sessionId, ownerIdentity) =>
        Effect.gen(function* () {
          const adapters = options.adapters;
          if (!adapters) return yield* unsupported();
          yield* requireSetup();
          yield* verifyCleanupOwner(sessionId, ownerIdentity);
          yield* options.controller.status(sessionId).pipe(Effect.ignore);
          yield* verifySessionEnded(sessionId);
          yield* removeSessionTokenCopies(sessionId, adapters);
          yield* sql`DELETE FROM preview_auth_token_keys WHERE session_id=${sessionId}`;
          yield* removeOwnedSessionClients(sessionId, adapters);
          yield* removeSessionClientRegistrations(sessionId, adapters);
          yield* sql`DELETE FROM preview_auth_pending WHERE session_id=${sessionId}`;
          yield* sql`DELETE FROM preview_auth_sessions WHERE session_id=${sessionId}`;
          yield* sql`DELETE FROM preview_auth_clients WHERE session_id=${sessionId}`;
        }),
    } satisfies PreviewAuthApi;
    return api;
  });
