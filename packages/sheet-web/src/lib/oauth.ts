import { createHash, randomBytes } from "node:crypto";
import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import { createServerFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
  getRequestHeaders,
  setCookie,
} from "@tanstack/react-start/server";
import {
  Cause,
  Data,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Match,
  Metric,
  Option,
  Predicate,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { createSheetAuthClient, getSession } from "sheet-auth/client";
import { dotEnvConfigProviderLayer } from "typhoon-core/config";
import {
  appBaseUrlConfig,
  authBaseUrlConfig,
  sheetWebOAuthClientIdConfig,
  sheetWebOAuthRedirectPathConfig,
  sheetWebOAuthScopesConfig,
} from "#/lib/config";

const oauthCookieName = "sheet-web-oauth";
const pkceCookieName = "sheet-web-oauth-pkce";
const sheetWebOAuthResource = "sheet-ingress";
const refreshSkewSeconds = 60;
const oauthTokenRequestTimeout = Duration.seconds(5);

type SheetWebOAuthTokenSet = {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly tokenType: "Bearer";
  readonly expiresAt: number;
  readonly scope: string;
};

type SheetWebOAuthPkceState = {
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
};

const SheetWebOAuthTokenSet = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  tokenType: Schema.Literal("Bearer"),
  expiresAt: Schema.Number,
  scope: Schema.String,
});

const SheetWebOAuthPkceState = Schema.Struct({
  state: Schema.String,
  nonce: Schema.String,
  codeVerifier: Schema.String,
});

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  token_type: Schema.Literal("Bearer"),
  expires_at: Schema.optional(Schema.Number),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
});

export const SheetWebOAuthCompletionInput = Schema.Struct({
  code: Schema.optionalKey(Schema.NonEmptyString),
  state: Schema.optionalKey(Schema.NonEmptyString),
});

type OAuthOperation = "authorization_code" | "refresh";
type OAuthRequestOutcome = "failure" | "success" | "timeout";
type OAuthRefreshErrorReason =
  | "authorization"
  | "invalid_response"
  | "missing_refresh_token"
  | "request_failure"
  | "timeout";

const sheetWebOAuthTokenRequests = Metric.counter("sheet_web_oauth_token_requests_total", {
  description: "Sheet web OAuth token endpoint requests",
  incremental: true,
});

const sheetWebOAuthRefreshErrors = Metric.counter("sheet_web_oauth_refresh_errors_total", {
  description: "Sheet web OAuth refresh errors that require reauthorization or retry",
  incremental: true,
});

export const oauthTokenRequestMetric = (operation: OAuthOperation, outcome: OAuthRequestOutcome) =>
  Metric.withAttributes(sheetWebOAuthTokenRequests, { operation, outcome });

export const oauthRefreshErrorMetric = (reason: OAuthRefreshErrorReason) =>
  Metric.withAttributes(sheetWebOAuthRefreshErrors, { reason });

const serverConfigLayer = dotEnvConfigProviderLayer().pipe(Layer.provide(NodeFileSystem.layer));

const loadOAuthConfig = () =>
  Effect.runPromise(
    Effect.all({
      authBaseUrl: authBaseUrlConfig,
      appBaseUrl: appBaseUrlConfig,
      clientId: sheetWebOAuthClientIdConfig,
      redirectPath: sheetWebOAuthRedirectPathConfig,
      scopes: sheetWebOAuthScopesConfig,
    }).pipe(Effect.provide(serverConfigLayer)),
  );

const cookieOptions = (appBaseUrl: URL, maxAge: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: appBaseUrl.protocol === "https:",
  path: "/",
  maxAge,
});

const encodeCookieValue = (value: unknown) => encodeURIComponent(JSON.stringify(value));

const decodeCookieValue = <A>(
  schema: Schema.Decoder<A>,
  value: string | undefined,
): Promise<Option.Option<A>> => {
  if (!value) {
    return Promise.resolve(Option.none());
  }

  try {
    const decoded = Schema.decodeUnknownOption(schema)(JSON.parse(decodeURIComponent(value)));
    return Promise.resolve(decoded);
  } catch {
    return Promise.resolve(Option.none());
  }
};

class OAuthTokenRequestError extends Data.TaggedError("OAuthTokenRequestError")<{
  readonly status: number;
}> {}

class OAuthMissingRefreshTokenError extends Data.TaggedError("OAuthMissingRefreshTokenError") {}

const setTokenCookie = async (tokenSet: SheetWebOAuthTokenSet, appBaseUrl: URL) => {
  const maxAge = Math.max(tokenSet.expiresAt - Math.floor(Date.now() / 1000), 60);
  setCookie(oauthCookieName, encodeCookieValue(tokenSet), cookieOptions(appBaseUrl, maxAge));
};

const clearTokenCookie = async () => {
  const { appBaseUrl } = await loadOAuthConfig();
  deleteCookie(oauthCookieName, cookieOptions(appBaseUrl, 0));
};

const getTokenCookie = async () =>
  decodeCookieValue(SheetWebOAuthTokenSet, getCookie(oauthCookieName));

const setPkceCookie = (state: SheetWebOAuthPkceState, appBaseUrl: URL) => {
  setCookie(pkceCookieName, encodeCookieValue(state), cookieOptions(appBaseUrl, 5 * 60));
};

const getPkceCookie = async () =>
  decodeCookieValue(SheetWebOAuthPkceState, getCookie(pkceCookieName));

const clearPkceCookie = async () => {
  const { appBaseUrl } = await loadOAuthConfig();
  deleteCookie(pkceCookieName, cookieOptions(appBaseUrl, 0));
};

const randomUrlSafe = (bytes = 32) => randomBytes(bytes).toString("base64url");

const codeChallenge = (codeVerifier: string) =>
  createHash("sha256").update(codeVerifier).digest("base64url");

const tokenResponseExpiresAt = (token: Schema.Schema.Type<typeof OAuthTokenResponse>) =>
  token.expires_at ?? Math.floor(Date.now() / 1000) + (token.expires_in ?? 3600);

const tokenResponseToTokenSet = (
  token: Schema.Schema.Type<typeof OAuthTokenResponse>,
): SheetWebOAuthTokenSet => ({
  accessToken: token.access_token,
  refreshToken: token.refresh_token,
  tokenType: token.token_type,
  expiresAt: tokenResponseExpiresAt(token),
  scope: token.scope ?? "",
});

const isOAuthTokenRequestError = (error: unknown): error is OAuthTokenRequestError =>
  Predicate.isTagged(error, "OAuthTokenRequestError") &&
  Predicate.hasProperty(error, "status") &&
  Predicate.isNumber(error.status);

const isAuthorizationFailure = (error: unknown) =>
  isOAuthTokenRequestError(error) && (error.status === 401 || error.status === 403);

export const isExpectedOAuthFailure = (error: unknown) =>
  Cause.isTimeoutError(error) ||
  isOAuthTokenRequestError(error) ||
  Predicate.isTagged(error, "SchemaError") ||
  HttpClientError.isHttpClientError(error);

export const isJwtAccessToken = (token: string) => {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
};

export const refreshTokenRequestBody = (tokenSet: SheetWebOAuthTokenSet, clientId: string) =>
  new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokenSet.refreshToken ?? "",
    resource: sheetWebOAuthResource,
  });

const mergeRefreshTokenSet = (
  tokenSet: SheetWebOAuthTokenSet,
  refreshed: SheetWebOAuthTokenSet,
) => ({
  ...refreshed,
  refreshToken: refreshed.refreshToken ?? tokenSet.refreshToken,
});

const validOAuthCallback = (
  pkce: Option.Option<SheetWebOAuthPkceState>,
  data: { readonly code?: string; readonly state?: string },
) =>
  Option.flatMap(pkce, (state) =>
    data.code && data.state === state.state
      ? Option.some({ code: data.code, codeVerifier: state.codeVerifier })
      : Option.none<{ readonly code: string; readonly codeVerifier: string }>(),
  );

export const authorizationCodeRequestBody = (
  config: Awaited<ReturnType<typeof loadOAuthConfig>>,
  callback: { readonly code: string; readonly codeVerifier: string },
) =>
  new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code: callback.code,
    redirect_uri: new URL(config.redirectPath, config.appBaseUrl).href,
    code_verifier: callback.codeVerifier,
    resource: sheetWebOAuthResource,
  });

const oauthErrorStatus = (error: unknown) =>
  isOAuthTokenRequestError(error) ? error.status : undefined;

const oauthErrorReason = (error: unknown): OAuthRefreshErrorReason =>
  Match.value(error).pipe(
    Match.when(Cause.isTimeoutError, () => "timeout" as const),
    Match.when(isAuthorizationFailure, () => "authorization" as const),
    Match.when(
      (candidate: unknown) => Predicate.isTagged(candidate, "OAuthMissingRefreshTokenError"),
      () => "missing_refresh_token" as const,
    ),
    Match.when(
      (candidate: unknown) => Predicate.isTagged(candidate, "SchemaError"),
      () => "invalid_response" as const,
    ),
    Match.orElse(() => "request_failure" as const),
  );

const recordOAuthTokenRequest = (
  operation: OAuthOperation,
  outcome: OAuthRequestOutcome,
  status?: number,
) =>
  Effect.all([
    Metric.update(oauthTokenRequestMetric(operation, outcome), 1),
    Effect.logInfo("Sheet web OAuth token request completed").pipe(
      Effect.annotateLogs({
        oauth_operation: operation,
        oauth_outcome: outcome,
        ...(status === undefined ? {} : { http_status: status }),
      }),
    ),
  ]).pipe(Effect.asVoid);

const recordOAuthRefreshError = (error: unknown) => {
  const reason = oauthErrorReason(error);
  const status = oauthErrorStatus(error);
  return Effect.all([
    Metric.update(oauthRefreshErrorMetric(reason), 1),
    Effect.logError("Sheet web OAuth token refresh failed; reauthorization is required").pipe(
      Effect.annotateLogs({
        oauth_operation: "refresh",
        oauth_error_reason: reason,
        ...(status === undefined ? {} : { http_status: status }),
      }),
    ),
  ]).pipe(Effect.asVoid);
};

const fetchToken = (
  authBaseUrl: URL,
  body: URLSearchParams,
  timeout: Duration.Input = oauthTokenRequestTimeout,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.post(new URL("/oauth2/token", authBaseUrl)).pipe(
      HttpClientRequest.bodyUrlParams(body),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError((error) => {
        if (
          HttpClientError.isHttpClientError(error) &&
          Predicate.isTagged(error.reason, "StatusCodeError")
        ) {
          return new OAuthTokenRequestError({ status: error.reason.response.status });
        }
        return error;
      }),
    );
    const token = yield* HttpClientResponse.schemaBodyJson(OAuthTokenResponse)(response);
    return tokenResponseToTokenSet(token);
  }).pipe(Effect.timeout(timeout));

const requestOAuthToken = (
  operation: OAuthOperation,
  authBaseUrl: URL,
  body: URLSearchParams,
  timeout: Duration.Input = oauthTokenRequestTimeout,
) =>
  fetchToken(authBaseUrl, body, timeout).pipe(
    Effect.tap(() => recordOAuthTokenRequest(operation, "success")),
    Effect.tapError((error) =>
      recordOAuthTokenRequest(
        operation,
        Cause.isTimeoutError(error) ? "timeout" : "failure",
        oauthErrorStatus(error),
      ),
    ),
  );

const oauthHttpRuntime = ManagedRuntime.make(NodeHttpClient.layerNodeHttp);

export const runOAuthTokenRequest = (
  operation: OAuthOperation,
  authBaseUrl: URL,
  body: URLSearchParams,
  timeout: Duration.Input = oauthTokenRequestTimeout,
  runtime: ManagedRuntime.ManagedRuntime<HttpClient.HttpClient, never> = oauthHttpRuntime,
) => runtime.runPromise(requestOAuthToken(operation, authBaseUrl, body, timeout));

export const handleOAuthRefreshError = async (
  error: unknown,
  clearCookie: () => Promise<void> = clearTokenCookie,
) => {
  await Effect.runPromise(recordOAuthRefreshError(error));
  if (isAuthorizationFailure(error)) {
    await clearCookie();
  }
  return Option.none<SheetWebOAuthTokenSet>();
};

const refreshToken = async (tokenSet: SheetWebOAuthTokenSet) => {
  if (!tokenSet.refreshToken) {
    return handleOAuthRefreshError(new OAuthMissingRefreshTokenError());
  }

  const config = await loadOAuthConfig();
  try {
    const refreshed = await runOAuthTokenRequest(
      "refresh",
      config.authBaseUrl,
      refreshTokenRequestBody(tokenSet, config.clientId),
    );
    const merged = mergeRefreshTokenSet(tokenSet, refreshed);
    await setTokenCookie(merged, config.appBaseUrl);
    return Option.some(merged);
  } catch (error) {
    return handleOAuthRefreshError(error);
  }
};

const ensureSheetWebOAuthAccessTokenServerFn = createServerFn({ method: "GET" }).handler(
  async (_ctx) => {
    const maybeToken = await getTokenCookie();
    if (Option.isNone(maybeToken)) {
      return null;
    }

    const tokenSet = maybeToken.value;
    if (
      isJwtAccessToken(tokenSet.accessToken) &&
      tokenSet.expiresAt - Math.floor(Date.now() / 1000) > refreshSkewSeconds
    ) {
      return tokenSet.accessToken;
    }

    return Option.match(await refreshToken(tokenSet), {
      onNone: () => null,
      onSome: (refreshed) => refreshed.accessToken,
    });
  },
);

export const ensureSheetWebOAuthAccessToken = () =>
  Effect.tryPromise(() => ensureSheetWebOAuthAccessTokenServerFn()).pipe(
    Effect.map(Option.fromNullishOr),
  );

export const createSheetWebOAuthAuthorizationUrl = createServerFn({ method: "POST" }).handler(
  async (_ctx) => {
    const config = await loadOAuthConfig();
    const session = await Effect.runPromise(
      getSession(createSheetAuthClient(config.authBaseUrl.href), getRequestHeaders()),
    );

    if (Option.isNone(session)) {
      return { redirectTo: "/" };
    }

    const codeVerifier = randomUrlSafe(64);
    const state = randomUrlSafe(32);
    const nonce = randomUrlSafe(32);
    const redirectUri = new URL(config.redirectPath, config.appBaseUrl).href;

    setPkceCookie({ state, nonce, codeVerifier }, config.appBaseUrl);

    const url = new URL("/oauth2/authorize", config.authBaseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", config.scopes);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", codeChallenge(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", sheetWebOAuthResource);

    return { redirectTo: url.href };
  },
);

export const completeSheetWebOAuthAuthorization = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => Schema.decodeUnknownSync(SheetWebOAuthCompletionInput)(input))
  .handler(async ({ data }) => {
    const config = await loadOAuthConfig();
    const pkce = await getPkceCookie();
    await clearPkceCookie();

    const callback = validOAuthCallback(pkce, data);
    if (Option.isNone(callback)) {
      return { ok: false };
    }

    let tokenSet: SheetWebOAuthTokenSet;
    try {
      tokenSet = await runOAuthTokenRequest(
        "authorization_code",
        config.authBaseUrl,
        authorizationCodeRequestBody(config, callback.value),
      );
    } catch (error) {
      if (isExpectedOAuthFailure(error)) {
        return { ok: false };
      }
      throw error;
    }

    await setTokenCookie(tokenSet, config.appBaseUrl);
    return { ok: true };
  });
