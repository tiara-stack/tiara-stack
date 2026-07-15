import { APIError } from "better-auth";
import { getSessionFromCtx } from "better-auth/api";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { Effect, Predicate } from "effect";
import { DISCORD_SERVICE_USER_ID_SENTINEL, UserTokenDefaultScopes } from "../../../oauth";
import { oauthResourceMetadataMappings } from "../../../oauth-resource-metadata";
import { getBearerToken } from "../../../utils/bearer-token";
import { findSubjectAccountForUser } from "../accounts";
import { isTrustedClient } from "../clients/trusted-client";
import { oauthError } from "../errors";
import type {
  SheetAuthResolvedIdentity,
  SheetOAuthEndpointContext,
  SheetOAuthOptions,
} from "../types";

export const splitScopes = (scope: unknown) =>
  Predicate.isString(scope) ? scope.split(" ").filter((value) => value.length > 0) : [];

export const sheetOAuthJwksUrl = (options: Pick<SheetOAuthOptions, "issuer" | "jwksUrl">) =>
  options.jwksUrl ?? `${options.issuer.replace(/\/$/, "")}/jwks`;

const isOAuthCredentialError = (error: unknown) => {
  const code = Predicate.hasProperty(error, "code") ? error.code : undefined;
  return (
    Predicate.isString(code) &&
    (code.startsWith("ERR_JWT") || code.startsWith("ERR_JWS") || code.startsWith("ERR_JOSE"))
  );
};

export const verifyOAuthAccessToken = async (
  token: string,
  options: SheetOAuthOptions,
): Promise<Record<string, unknown>> => {
  const verifier = oauthProviderResourceClient().getActions().verifyAccessToken;
  return await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        verifier(token, {
          jwksUrl: sheetOAuthJwksUrl(options),
          verifyOptions: {
            audience: [...options.validAudiences],
            issuer: options.issuer.replace(/\/$/, ""),
          },
          resourceMetadataMappings: oauthResourceMetadataMappings(
            options.issuer,
            options.validAudiences,
          ),
        }),
      catch: (error) => error,
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.catch((error) =>
        Effect.fail(
          isOAuthCredentialError(error)
            ? oauthError("UNAUTHORIZED", "invalid_request", "Invalid OAuth access token")
            : new APIError("SERVICE_UNAVAILABLE", {
                message: "OAuth token verification unavailable",
              }),
        ),
      ),
    ),
  );
};

export const makeSessionIdentity = async (
  ctx: SheetOAuthEndpointContext,
): Promise<SheetAuthResolvedIdentity | undefined> => {
  const session = await getSessionFromCtx(ctx);
  if (!session?.session) {
    return undefined;
  }

  const account = await findSubjectAccountForUser(ctx.context.internalAdapter, session.user.id);
  if (!account) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "No linked Discord account found");
  }

  return {
    tokenType: "session",
    userId: session.user.id,
    accountId: account.accountId,
    permissions: [],
    scopes: [...UserTokenDefaultScopes],
    expiresAt: session.session.expiresAt.toISOString(),
  };
};

const getSessionSubjectUserId = (session: Record<string, unknown> | undefined) =>
  Predicate.hasProperty(session, "userId") && Predicate.isString(session.userId)
    ? session.userId
    : undefined;

const getSessionSubjectExpiresAt = (session: Record<string, unknown> | undefined) => {
  if (!Predicate.hasProperty(session, "expiresAt")) {
    return undefined;
  }
  const { expiresAt } = session;
  if (Predicate.isDate(expiresAt)) {
    return expiresAt;
  }
  return Predicate.isString(expiresAt) ? new Date(expiresAt) : undefined;
};

const assertValidSessionSubject = (session: Record<string, unknown> | undefined) => {
  const userId = getSessionSubjectUserId(session);
  const expiresAt = getSessionSubjectExpiresAt(session);
  if (!userId || !expiresAt) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Invalid session subject token");
  }
  if (!Number.isFinite(expiresAt.getTime())) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Invalid session subject token");
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Expired session subject token");
  }
  return { userId, expiresAt };
};

export const resolveSessionByToken = async (
  ctx: SheetOAuthEndpointContext,
  token: string,
): Promise<{ readonly userId: string; readonly expiresAt: Date }> => {
  const result = await ctx.context.internalAdapter.findSession(token);
  return assertValidSessionSubject(result?.session);
};

const tokenExpiresAt = (payload: Record<string, unknown>) =>
  Predicate.isNumber(payload.exp) ? new Date(payload.exp * 1000).toISOString() : undefined;

const getAccessTokenClientId = (payload: Record<string, unknown>) =>
  Predicate.isString(payload.client_id)
    ? payload.client_id
    : Predicate.isString(payload.azp)
      ? payload.azp
      : undefined;

const InternalOnlyScopes = new Set([
  "service",
  "ingress.forward",
  "bot.impersonate",
  "token.exchange",
]);

const tokenHasInternalScope = (scopes: readonly string[]) =>
  scopes.some((scope) => InternalOnlyScopes.has(scope));

const rejectUnauthorized = (message: string): never => {
  throw oauthError("UNAUTHORIZED", "invalid_request", message);
};

const assertInternalScopesAllowed = (scopes: readonly string[], isTrusted: boolean) => {
  if (!isTrusted && tokenHasInternalScope(scopes)) {
    rejectUnauthorized("Untrusted OAuth client requested an internal scope");
  }
};

const makeServiceIdentity = (
  payload: Record<string, unknown>,
  clientId: string | undefined,
  scopes: readonly string[],
): SheetAuthResolvedIdentity => ({
  tokenType: "oauth_access_token",
  userId: DISCORD_SERVICE_USER_ID_SENTINEL,
  accountId: DISCORD_SERVICE_USER_ID_SENTINEL,
  clientId,
  permissions: ["service"],
  scopes,
  expiresAt: tokenExpiresAt(payload),
});

const makeTokenExchangeActorIdentity = (
  payload: Record<string, unknown>,
  clientId: string | undefined,
  scopes: readonly string[],
): SheetAuthResolvedIdentity => ({
  tokenType: "oauth_access_token",
  userId: clientId ?? "oauth_client",
  accountId: clientId ?? "oauth_client",
  clientId,
  permissions: [],
  scopes,
  expiresAt: tokenExpiresAt(payload),
});

const makeUserAccessTokenIdentity = async (
  ctx: SheetOAuthEndpointContext,
  payload: Record<string, unknown>,
  clientId: string | undefined,
  scopes: readonly string[],
): Promise<SheetAuthResolvedIdentity> => {
  const subject = Predicate.isString(payload.sub) ? payload.sub : undefined;
  if (!subject) {
    throw oauthError(
      "UNAUTHORIZED",
      "invalid_request",
      "OAuth token is not associated with a user",
    );
  }

  const account = await findSubjectAccountForUser(ctx.context.internalAdapter, subject);
  if (!account) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "No linked Discord account found");
  }

  return {
    tokenType: "oauth_access_token",
    userId: subject,
    accountId: account.accountId,
    clientId,
    permissions: [],
    scopes,
    expiresAt: tokenExpiresAt(payload),
  };
};

export const makeAccessTokenIdentity = async (
  ctx: SheetOAuthEndpointContext,
  token: string,
  options: SheetOAuthOptions,
  optionsOverride?: { readonly allowTokenExchangeActor?: boolean },
): Promise<SheetAuthResolvedIdentity> => {
  const payload = await verifyOAuthAccessToken(token, options);
  const scopes = splitScopes(payload.scope);
  const clientId = getAccessTokenClientId(payload);
  const trusted = await isTrustedClient(ctx, clientId, options);

  assertInternalScopesAllowed(scopes, trusted);

  if (scopes.includes("service")) {
    return makeServiceIdentity(payload, clientId, scopes);
  }
  if (
    optionsOverride?.allowTokenExchangeActor === true &&
    trusted &&
    scopes.includes("token.exchange") &&
    !Predicate.isString(payload.sub)
  ) {
    return makeTokenExchangeActorIdentity(payload, clientId, scopes);
  }

  return await makeUserAccessTokenIdentity(ctx, payload, clientId, scopes);
};

export const requireBearerToken = (ctx: SheetOAuthEndpointContext) => {
  const token = getBearerToken(ctx.request?.headers.get("authorization"));
  if (!token) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Missing bearer token");
  }
  return token;
};

export const requireUserOAuthIdentity = async (
  ctx: SheetOAuthEndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetAuthResolvedIdentity> => {
  const token = requireBearerToken(ctx);
  const identity = await makeAccessTokenIdentity(ctx, token, options);
  if (identity.tokenType !== "oauth_access_token" || identity.permissions.includes("service")) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "OAuth token must resolve to a user");
  }

  if (!identity.scopes.includes("sheet.read")) {
    throw oauthError("UNAUTHORIZED", "insufficient_scope", "OAuth token requires sheet.read scope");
  }

  return identity;
};
