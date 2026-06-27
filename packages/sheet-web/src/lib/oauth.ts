import { createHash, randomBytes } from "node:crypto";
import { NodeFileSystem } from "@effect/platform-node";
import { createServerFn } from "@tanstack/react-start";
import {
  deleteCookie,
  getCookie,
  getRequestHeaders,
  setCookie,
} from "@tanstack/react-start/server";
import { Effect, Layer, Option, Schema } from "effect";
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

class OAuthTokenRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

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

const tokenResponseToTokenSet = (response: unknown): SheetWebOAuthTokenSet => {
  const token = Schema.decodeUnknownSync(OAuthTokenResponse)(response);

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    tokenType: token.token_type,
    expiresAt: tokenResponseExpiresAt(token),
    scope: token.scope ?? "",
  };
};

const isAuthorizationFailure = (error: unknown) =>
  error instanceof OAuthTokenRequestError && (error.status === 401 || error.status === 403);

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

const fetchToken = async (authBaseUrl: URL, body: URLSearchParams) => {
  const response = await fetch(new URL("/oauth2/token", authBaseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new OAuthTokenRequestError(
      `OAuth token request failed with HTTP ${response.status}`,
      response.status,
    );
  }

  return tokenResponseToTokenSet(await response.json());
};

const refreshToken = async (tokenSet: SheetWebOAuthTokenSet) => {
  if (!tokenSet.refreshToken) {
    return Option.none<SheetWebOAuthTokenSet>();
  }

  const config = await loadOAuthConfig();
  try {
    const refreshed = await fetchToken(
      config.authBaseUrl,
      refreshTokenRequestBody(tokenSet, config.clientId),
    );
    const merged = mergeRefreshTokenSet(tokenSet, refreshed);
    await setTokenCookie(merged, config.appBaseUrl);
    return Option.some(merged);
  } catch (error) {
    if (isAuthorizationFailure(error)) {
      await clearTokenCookie();
    }
    return Option.none<SheetWebOAuthTokenSet>();
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
  .inputValidator((input: { readonly code?: string; readonly state?: string }) => input)
  .handler(async ({ data }) => {
    const config = await loadOAuthConfig();
    const pkce = await getPkceCookie();
    await clearPkceCookie();

    const callback = validOAuthCallback(pkce, data);
    if (Option.isNone(callback)) {
      return { ok: false };
    }

    try {
      const tokenSet = await fetchToken(
        config.authBaseUrl,
        authorizationCodeRequestBody(config, callback.value),
      );
      await setTokenCookie(tokenSet, config.appBaseUrl);
      return { ok: true };
    } catch (error) {
      if (error instanceof OAuthTokenRequestError) {
        return { ok: false };
      }
      throw error;
    }
  });
