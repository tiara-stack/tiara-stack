import { signJWT } from "better-auth/plugins";
import { Match } from "effect";
import { AccessTokenType, SessionTokenType, UserTokenDefaultScopes } from "../../../oauth";
import { getBearerToken } from "../../../utils/bearer-token";
import { findSubjectAccountForUser } from "../accounts";
import { oauthError } from "../errors";
import type {
  SheetAuthResolvedIdentity,
  SheetOAuthEndpointContext,
  SheetOAuthOptions,
  SheetOAuthTokenExchangeResponse,
  SheetOAuthTokenExchangeSubject,
} from "../types";
import {
  makeAccessTokenIdentity,
  resolveSessionByToken,
  splitScopes,
} from "../verifiers/access-token";

const assertValidTokenType = (label: string, tokenType: string | undefined) => {
  if (tokenType !== undefined && tokenType !== AccessTokenType) {
    throw oauthError("BAD_REQUEST", "invalid_request", `Unsupported ${label} ${tokenType}`);
  }
};

const assertValidTokenExchangeAudience = (audience: string, options: SheetOAuthOptions) => {
  if (!options.validAudiences.includes(audience)) {
    throw oauthError("BAD_REQUEST", "invalid_target", "Requested audience is invalid");
  }
};

const requireTokenExchangeActor = async (
  ctx: SheetOAuthEndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetAuthResolvedIdentity> => {
  assertValidTokenType("actor_token_type", ctx.body.actor_token_type);
  const actorToken =
    ctx.body.actor_token ?? getBearerToken(ctx.request?.headers.get("authorization"));
  if (!actorToken) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Missing actor token");
  }

  const actor = await makeAccessTokenIdentity(ctx, actorToken, options, {
    allowTokenExchangeActor: true,
  });
  const actorScopes = options.tokenExchange?.actorScopes ?? ["token.exchange"];
  if (!actorScopes.some((scope) => actor.scopes.includes(scope))) {
    throw oauthError("UNAUTHORIZED", "insufficient_scope", "Actor token cannot exchange tokens");
  }

  return actor;
};

const assertScopesAllowedByActor = (
  requestedScopes: readonly string[],
  actor: SheetAuthResolvedIdentity,
) => {
  const missingScopes = requestedScopes.filter((scope) => !actor.scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw oauthError(
      "BAD_REQUEST",
      "invalid_scope",
      `Requested scope is not allowed for actor token: ${missingScopes.join(" ")}`,
    );
  }
};

export const requestedTokenExchangeScopes = (
  requestScope: string | undefined,
  subject: SheetOAuthTokenExchangeSubject,
  actor: SheetAuthResolvedIdentity,
) => {
  const requestedScopes = splitScopes(requestScope);
  if (requestedScopes.length > 0) {
    assertScopesAllowedByActor(requestedScopes, actor);
    const subjectScopes = subject.scopes ?? [];
    const resolvedScopes = requestedScopes.filter((scope) => subjectScopes.includes(scope));
    if (resolvedScopes.length === 0) {
      throw oauthError("BAD_REQUEST", "invalid_scope", "No requested scopes are allowed");
    }
    return resolvedScopes;
  }

  const subjectScopes = subject.scopes ?? [];
  const resolvedScopes = subjectScopes.filter((scope) => actor.scopes.includes(scope));
  if (resolvedScopes.length === 0) {
    throw oauthError("BAD_REQUEST", "invalid_scope", "No token exchange scopes are allowed");
  }
  return resolvedScopes;
};

const resolveAccessTokenSubject = async (
  ctx: SheetOAuthEndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetOAuthTokenExchangeSubject> => {
  const identity = await makeAccessTokenIdentity(ctx, ctx.body.subject_token, options);
  if (identity.permissions.includes("service")) {
    throw oauthError("BAD_REQUEST", "invalid_request", "Subject token must resolve to a user");
  }

  return {
    userId: identity.userId,
    accountId: identity.accountId,
    scopes: identity.scopes,
  };
};

const resolveSessionTokenSubject = async (
  ctx: SheetOAuthEndpointContext,
): Promise<SheetOAuthTokenExchangeSubject> => {
  const session = await resolveSessionByToken(ctx, ctx.body.subject_token);
  const account = await findSubjectAccountForUser(ctx.context.internalAdapter, session.userId);
  if (!account) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "No linked Discord account found");
  }

  return {
    userId: session.userId,
    accountId: account.accountId,
    scopes: [...UserTokenDefaultScopes],
  };
};

const resolveConfiguredSubject = async (
  ctx: SheetOAuthEndpointContext,
  actor: SheetAuthResolvedIdentity,
  options: SheetOAuthOptions,
): Promise<SheetOAuthTokenExchangeSubject> => {
  for (const resolver of options.tokenExchange?.subjectResolvers ?? []) {
    const subject = await resolver({
      ctx,
      actor,
      subjectToken: ctx.body.subject_token,
      subjectTokenType: ctx.body.subject_token_type,
      request: ctx.body,
    });
    if (subject) {
      return subject;
    }
  }

  throw oauthError(
    "BAD_REQUEST",
    "invalid_request",
    `Unsupported subject_token_type ${ctx.body.subject_token_type}`,
  );
};

const resolveTokenExchangeSubject = async (
  ctx: SheetOAuthEndpointContext,
  actor: SheetAuthResolvedIdentity,
  options: SheetOAuthOptions,
): Promise<SheetOAuthTokenExchangeSubject> => {
  return await Match.value(ctx.body.subject_token_type).pipe(
    Match.when(AccessTokenType, () => resolveAccessTokenSubject(ctx, options)),
    Match.when(SessionTokenType, () => resolveSessionTokenSubject(ctx)),
    Match.orElse(() => resolveConfiguredSubject(ctx, actor, options)),
  );
};

const signTokenExchangeAccessToken = async (
  ctx: SheetOAuthEndpointContext,
  options: SheetOAuthOptions,
  input: {
    readonly actor: SheetAuthResolvedIdentity;
    readonly subject: SheetOAuthTokenExchangeSubject;
    readonly audience: string;
    readonly scopes: readonly string[];
  },
): Promise<SheetOAuthTokenExchangeResponse> => {
  const iat = Math.floor(Date.now() / 1000);
  const expiresIn = options.tokenExchange?.accessTokenExpiresIn ?? 300;
  const exp = iat + expiresIn;
  const scope = input.scopes.join(" ");
  if (!input.subject.accountId) {
    throw oauthError("BAD_REQUEST", "invalid_request", "Token exchange subject is missing account");
  }
  const actorClaims = {
    sub: input.actor.userId,
    client_id: input.actor.clientId,
  };

  const accessToken = await signJWT(ctx, {
    payload: {
      ...input.subject.claims,
      iss: options.issuer.replace(/\/$/, ""),
      sub: input.subject.userId,
      account_id: input.subject.accountId,
      aud: input.audience,
      azp: input.actor.clientId,
      client_id: input.actor.clientId,
      scope,
      act: actorClaims,
      iat,
      exp,
    },
  });

  return {
    access_token: accessToken,
    issued_token_type: AccessTokenType,
    token_type: "Bearer",
    expires_in: expiresIn,
    expires_at: exp,
    scope,
  };
};

export const exchangeToken = async (
  ctx: SheetOAuthEndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetOAuthTokenExchangeResponse> => {
  assertValidTokenType("requested_token_type", ctx.body.requested_token_type);
  const audience = ctx.body.audience ?? ctx.body.resource;
  if (!audience) {
    throw oauthError("BAD_REQUEST", "invalid_target", "Missing requested audience");
  }
  assertValidTokenExchangeAudience(audience, options);

  const actor = await requireTokenExchangeActor(ctx, options);
  const subject = await resolveTokenExchangeSubject(ctx, actor, options);
  const scopes = requestedTokenExchangeScopes(ctx.body.scope, subject, actor);
  return await signTokenExchangeAccessToken(ctx, options, {
    actor,
    subject,
    audience,
    scopes,
  });
};
