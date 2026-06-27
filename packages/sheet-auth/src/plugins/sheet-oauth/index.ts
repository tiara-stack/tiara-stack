import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  APIError,
  type BetterAuthPlugin,
  type InternalAdapter,
  type Session,
  type User,
} from "better-auth";
import { getSessionFromCtx } from "better-auth/api";
import { createAuthEndpoint, type AuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { signJWT } from "better-auth/plugins";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { Schema } from "effect";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { DISCORD_SERVICE_USER_ID_SENTINEL, UserTokenDefaultScopes } from "../../oauth";
import { oauthResourceMetadataMappings } from "../../oauth-resource-metadata";
import { getBearerToken } from "../../utils/bearer-token";

const TokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
const AccessTokenType = "urn:ietf:params:oauth:token-type:access_token";
const JwtTokenType = "urn:ietf:params:oauth:token-type:jwt";

const trustedDiscordSessionBody = Schema.Struct({
  discordUserId: Schema.String,
}).pipe(Schema.toStandardSchemaV1);

const tokenExchangeBody = Schema.Struct({
  grant_type: Schema.Literal(TokenExchangeGrantType),
  subject_token: Schema.String,
  subject_token_type: Schema.String,
  actor_token: Schema.optional(Schema.String),
  actor_token_type: Schema.optional(Schema.String),
  requested_token_type: Schema.optional(Schema.String),
  audience: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
}).pipe(Schema.toStandardSchemaV1);

const subjectTokenBody = Schema.Struct({
  subject: Schema.String,
  audience: Schema.optional(Schema.String),
  expiresIn: Schema.optional(Schema.Number),
}).pipe(Schema.toStandardSchemaV1);

export interface SheetOAuthTokenExchangeSubject {
  readonly userId: string;
  readonly accountId?: string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly claims?: JWTPayload | undefined;
}

export interface SheetOAuthTokenExchangeRequest {
  readonly grant_type: typeof TokenExchangeGrantType;
  readonly subject_token: string;
  readonly subject_token_type: string;
  readonly actor_token?: string | undefined;
  readonly actor_token_type?: string | undefined;
  readonly requested_token_type?: string | undefined;
  readonly audience?: string | undefined;
  readonly resource?: string | undefined;
  readonly scope?: string | undefined;
}

export interface SheetOAuthTokenExchangeSubjectResolverInput {
  readonly ctx: SheetOAuthEndpointContext;
  readonly actor: SheetAuthResolvedIdentity;
  readonly subjectToken: string;
  readonly subjectTokenType: string;
  readonly request: SheetOAuthTokenExchangeRequest;
}

export type SheetOAuthTokenExchangeSubjectResolver = (
  input: SheetOAuthTokenExchangeSubjectResolverInput,
) => Promise<SheetOAuthTokenExchangeSubject | undefined>;

export interface SheetOAuthJwtSubjectResolverOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly resolveSubject: (input: {
    readonly ctx: SheetOAuthEndpointContext;
    readonly actor: SheetAuthResolvedIdentity;
    readonly payload: JWTPayload;
    readonly subject: string;
    readonly request: SheetOAuthTokenExchangeRequest;
  }) => Promise<SheetOAuthTokenExchangeSubject | undefined>;
}

export interface SheetOAuthTokenExchangeOptions {
  readonly accessTokenExpiresIn?: number | undefined;
  readonly actorScopes?: readonly string[] | undefined;
  readonly subjectResolvers?: readonly SheetOAuthTokenExchangeSubjectResolver[] | undefined;
  readonly subjectTokenMinting?: SheetOAuthSubjectTokenMintingOptions | undefined;
}

export interface SheetOAuthKubernetesSubjectTokenMintingOptions {
  readonly tokenReviewUrl?: string | undefined;
  readonly reviewerTokenPath?: string | undefined;
  readonly caPath?: string | undefined;
  readonly audience: string;
  readonly allowedServiceAccounts: readonly string[];
}

export interface SheetOAuthSubjectTokenMintingOptions {
  readonly secret?: string | undefined;
  readonly issuer?: string | undefined;
  readonly audience?: string | undefined;
  readonly expiresIn?: number | undefined;
  readonly allowedSubjectPrefixes?: readonly string[] | undefined;
  readonly kubernetes?: SheetOAuthKubernetesSubjectTokenMintingOptions | undefined;
}

export interface SheetOAuthOptions {
  readonly issuer: string;
  readonly jwksUrl?: string | undefined;
  readonly validAudiences: readonly string[];
  readonly trustedClientIds?: ReadonlySet<string>;
  readonly tokenExchange?: SheetOAuthTokenExchangeOptions | undefined;
}

export const sheetOAuthJwksUrl = (options: Pick<SheetOAuthOptions, "issuer" | "jwksUrl">) =>
  options.jwksUrl ?? `${options.issuer.replace(/\/$/, "")}/jwks`;

export interface SheetAuthResolvedIdentity {
  readonly tokenType: "session" | "oauth_access_token";
  readonly userId: string;
  readonly accountId: string;
  readonly clientId?: string | undefined;
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
  readonly expiresAt?: string | undefined;
}

type SheetOAuthIdentityEndpoint = AuthEndpoint<
  "/sheet-auth/identity",
  {
    method: "GET";
  },
  SheetAuthResolvedIdentity
>;

type SheetOAuthTrustedDiscordSessionEndpoint = AuthEndpoint<
  "/sheet-auth/trusted-discord-session",
  {
    method: "POST";
    body: typeof trustedDiscordSessionBody;
    metadata: {
      allowedMediaTypes: string[];
    };
  },
  {
    session: Session;
    user: User;
  }
>;

interface SheetOAuthDiscordAccessTokenResponse {
  readonly accessToken: string;
}

type SheetOAuthDiscordAccessTokenEndpoint = AuthEndpoint<
  "/sheet-auth/discord/access-token",
  {
    method: "GET";
  },
  SheetOAuthDiscordAccessTokenResponse
>;

interface SheetOAuthSubjectTokenResponse {
  readonly subject_token: string;
  readonly subject_token_type: typeof JwtTokenType;
  readonly expires_in: number;
  readonly expires_at: number;
}

type SheetOAuthCreateSubjectTokenEndpoint = AuthEndpoint<
  "/sheet-auth/internal/subject-token",
  {
    method: "POST";
    body: typeof subjectTokenBody;
    metadata: {
      allowedMediaTypes: string[];
    };
  },
  SheetOAuthSubjectTokenResponse
>;

interface SheetOAuthTokenExchangeResponse {
  readonly access_token: string;
  readonly issued_token_type: typeof AccessTokenType;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly expires_at: number;
  readonly scope: string;
}

type SheetOAuthTokenExchangeEndpoint = AuthEndpoint<
  "/sheet-auth/oauth2/token-exchange",
  {
    method: "POST";
    body: typeof tokenExchangeBody;
    metadata: {
      allowedMediaTypes: string[];
    };
  },
  SheetOAuthTokenExchangeResponse
>;

type SheetOAuthPlugin = BetterAuthPlugin & {
  id: "sheet-oauth";
  endpoints: {
    getSheetAuthIdentity: SheetOAuthIdentityEndpoint;
    getDiscordAccessToken: SheetOAuthDiscordAccessTokenEndpoint;
    createTrustedDiscordSession: SheetOAuthTrustedDiscordSessionEndpoint;
    createSubjectToken: SheetOAuthCreateSubjectTokenEndpoint;
    exchangeOAuthToken: SheetOAuthTokenExchangeEndpoint;
  };
};

// Better Auth does not expose a stable endpoint context type for plugin internals.
export type SheetOAuthEndpointContext = any;
type EndpointContext = SheetOAuthEndpointContext;

type OAuth2RefreshTokens = {
  readonly accessToken?: string | undefined;
  readonly refreshToken?: string | undefined;
  readonly accessTokenExpiresAt?: Date | string | undefined;
  readonly refreshTokenExpiresAt?: Date | string | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly idToken?: string | undefined;
};

const splitScopes = (scope: unknown) =>
  typeof scope === "string" ? scope.split(" ").filter((value) => value.length > 0) : [];

const findDiscordSubjectAccount = async (adapter: InternalAdapter, discordUserId: string) =>
  (await adapter.findAccountByProviderId(discordUserId, "discord")) ??
  (await adapter.findAccountByProviderId(discordUserId, "kubernetes:discord"));

const findSubjectAccountForUser = async (adapter: InternalAdapter, userId: string) => {
  const accounts = await adapter.findAccounts(userId);
  return (
    accounts.find((account) => account.providerId === "discord") ??
    accounts.find((account) => account.providerId === "kubernetes:discord")
  );
};

const findDiscordOAuthAccountForUser = async (adapter: InternalAdapter, userId: string) => {
  const accounts = await adapter.findAccounts(userId);
  return accounts.find((account) => account.providerId === "discord");
};

const createPlaceholderUserWithDiscord = async (
  adapter: InternalAdapter,
  discordUserId: string,
) => {
  const user = await adapter.createUser({
    email: `discord_${discordUserId}@oauth.internal`,
    emailVerified: true,
    name: `Discord User ${discordUserId}`,
  });

  await adapter.createAccount({
    userId: user.id,
    providerId: "discord",
    accountId: discordUserId,
  });

  return user;
};

export const resolveUserByDiscordId = async (adapter: InternalAdapter, discordUserId: string) => {
  const account = await findDiscordSubjectAccount(adapter, discordUserId);
  if (account?.userId) {
    const user = await adapter.findUserById(account.userId);
    if (user) {
      return user;
    }
  }

  return await createPlaceholderUserWithDiscord(adapter, discordUserId);
};

const parseMetadata = (metadata: unknown) => {
  if (typeof metadata === "string") {
    try {
      return JSON.parse(metadata) as unknown;
    } catch {
      return undefined;
    }
  }

  return metadata;
};

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTrustedMetadata = (metadata: unknown) => {
  const parsedMetadata = parseMetadata(metadata);
  return isObjectRecord(parsedMetadata) && parsedMetadata.trusted === true;
};

const isTrustedClient = async (
  ctx: EndpointContext,
  clientId: string | undefined,
  options: SheetOAuthOptions,
) => {
  if (!clientId) {
    return false;
  }

  if (options.trustedClientIds?.has(clientId)) {
    return true;
  }

  const client = await ctx.context.adapter.findOne({
    model: "oauthClient",
    where: [{ field: "clientId", value: clientId }],
  });
  return isTrustedMetadata(client?.metadata);
};

export const verifyOAuthAccessToken = async (
  token: string,
  options: SheetOAuthOptions,
): Promise<Record<string, unknown>> => {
  const verifier = oauthProviderResourceClient().getActions().verifyAccessToken;
  return await verifier(token, {
    jwksUrl: sheetOAuthJwksUrl(options),
    verifyOptions: {
      audience: [...options.validAudiences],
      issuer: options.issuer.replace(/\/$/, ""),
    },
    resourceMetadataMappings: oauthResourceMetadataMappings(options.issuer, options.validAudiences),
  });
};

const makeSessionIdentity = async (
  ctx: EndpointContext,
): Promise<SheetAuthResolvedIdentity | undefined> => {
  const session = await getSessionFromCtx(ctx as never);
  if (!session?.session) {
    return undefined;
  }

  const account = await findSubjectAccountForUser(ctx.context.internalAdapter, session.user.id);
  if (!account) {
    throw new APIError("UNAUTHORIZED", {
      message: "No linked Discord account found",
    });
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

const tokenExpiresAt = (payload: Record<string, unknown>) =>
  typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : undefined;

const getAccessTokenClientId = (payload: Record<string, unknown>) =>
  typeof payload.client_id === "string"
    ? payload.client_id
    : typeof payload.azp === "string"
      ? payload.azp
      : undefined;

const tokenHasInternalScope = (scopes: readonly string[]) =>
  scopes.some(
    (scope) =>
      scope === "service" ||
      scope === "ingress.forward" ||
      scope === "bot.impersonate" ||
      scope === "token.exchange",
  );

const rejectUnauthorized = (message: string): never => {
  throw new APIError("UNAUTHORIZED", { message });
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

const makeUserAccessTokenIdentity = async (
  ctx: EndpointContext,
  payload: Record<string, unknown>,
  clientId: string | undefined,
  scopes: readonly string[],
): Promise<SheetAuthResolvedIdentity> => {
  const subject = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!subject) {
    throw new APIError("UNAUTHORIZED", {
      message: "OAuth token is not associated with a user",
    });
  }

  const account = await findSubjectAccountForUser(ctx.context.internalAdapter, subject);
  if (!account) {
    throw new APIError("UNAUTHORIZED", {
      message: "No linked Discord account found",
    });
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

const makeAccessTokenIdentity = async (
  ctx: EndpointContext,
  token: string,
  options: SheetOAuthOptions,
): Promise<SheetAuthResolvedIdentity> => {
  const payload = await verifyOAuthAccessToken(token, options);
  const scopes = splitScopes(payload.scope);
  const clientId = getAccessTokenClientId(payload);
  const isTrusted = await isTrustedClient(ctx, clientId, options);

  assertInternalScopesAllowed(scopes, isTrusted);

  if (scopes.includes("service")) {
    if (!isTrusted) {
      rejectUnauthorized("Untrusted OAuth client cannot resolve as a service user");
    }

    return makeServiceIdentity(payload, clientId, scopes);
  }

  return await makeUserAccessTokenIdentity(ctx, payload, clientId, scopes);
};

const resolveSocialProvider = async (ctx: EndpointContext, providerId: string) => {
  for (const entry of ctx.context.socialProviders ?? []) {
    const provider = typeof entry === "function" ? await entry() : entry;
    if (provider?.id === providerId) {
      return provider;
    }
  }
  return undefined;
};

const accessTokenExpiresSoon = (
  account: NonNullable<Awaited<ReturnType<typeof findDiscordOAuthAccountForUser>>>,
) => {
  const expiresAt =
    account.accessTokenExpiresAt instanceof Date
      ? account.accessTokenExpiresAt
      : account.accessTokenExpiresAt
        ? new Date(account.accessTokenExpiresAt)
        : undefined;

  return expiresAt ? expiresAt.getTime() - Date.now() < 5_000 : false;
};

type DiscordOAuthAccount = NonNullable<Awaited<ReturnType<typeof findDiscordOAuthAccountForUser>>>;

const refreshDiscordAccessToken = async (ctx: EndpointContext, account: DiscordOAuthAccount) => {
  const provider = await resolveSocialProvider(ctx, "discord");
  if (!provider?.refreshAccessToken || !account.refreshToken) {
    return undefined;
  }

  const refreshToken = await decryptOAuthToken(account.refreshToken, ctx.context);
  const newTokens = (await provider.refreshAccessToken(refreshToken)) as OAuth2RefreshTokens;
  const updatedData = {
    accessToken: await setTokenUtil(newTokens.accessToken, ctx.context),
    accessTokenExpiresAt: newTokens.accessTokenExpiresAt,
    refreshToken: await setTokenUtil(newTokens.refreshToken, ctx.context),
    refreshTokenExpiresAt: newTokens.refreshTokenExpiresAt,
    scope: newTokens.scopes?.join(",") || account.scope,
    idToken: newTokens.idToken || account.idToken,
  };

  if (account.id) {
    await ctx.context.internalAdapter.updateAccount(account.id, updatedData);
  }

  return newTokens.accessToken;
};

const maybeRefreshDiscordAccessToken = async (
  ctx: EndpointContext,
  account: DiscordOAuthAccount,
) => {
  if (account.accessToken && !accessTokenExpiresSoon(account)) {
    return undefined;
  }

  return await refreshDiscordAccessToken(ctx, account);
};

const requireBearerToken = (ctx: EndpointContext) => {
  const token = getBearerToken(ctx.request?.headers.get("authorization"));
  if (!token) {
    throw new APIError("UNAUTHORIZED", {
      message: "Missing bearer token",
    });
  }
  return token;
};

const requireUserOAuthIdentity = async (
  ctx: EndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetAuthResolvedIdentity> => {
  const token = requireBearerToken(ctx);
  const identity = await makeAccessTokenIdentity(ctx, token, options);
  if (identity.tokenType !== "oauth_access_token" || identity.permissions.includes("service")) {
    throw new APIError("UNAUTHORIZED", {
      message: "OAuth token must resolve to a user",
    });
  }

  if (!identity.scopes.includes("sheet.read")) {
    throw oauthError("UNAUTHORIZED", "insufficient_scope", "OAuth token requires sheet.read scope");
  }

  return identity;
};

const requireDiscordOAuthAccount = async (
  ctx: EndpointContext,
  userId: string,
): Promise<DiscordOAuthAccount> => {
  const account = await findDiscordOAuthAccountForUser(ctx.context.internalAdapter, userId);
  if (!account) {
    throw new APIError("UNAUTHORIZED", {
      message: "No linked Discord account found",
    });
  }

  if (!account.accessToken && !account.refreshToken) {
    throw new APIError("UNAUTHORIZED", {
      message: "Discord login required",
    });
  }

  return account;
};

const requireDiscordAccessToken = async (
  ctx: EndpointContext,
  account: DiscordOAuthAccount,
): Promise<string> => {
  const refreshedAccessToken = await maybeRefreshDiscordAccessToken(ctx, account);
  if (refreshedAccessToken) {
    return refreshedAccessToken;
  }

  if (!account.accessToken) {
    throw new APIError("UNAUTHORIZED", {
      message: "No Discord access token found",
    });
  }

  const accessToken = await decryptOAuthToken(account.accessToken, ctx.context);
  if (!accessToken) {
    throw new APIError("UNAUTHORIZED", {
      message: "No Discord access token found",
    });
  }

  return accessToken;
};

const getDiscordProviderAccessToken = async (ctx: EndpointContext, options: SheetOAuthOptions) => {
  const identity = await requireUserOAuthIdentity(ctx, options);
  const account = await requireDiscordOAuthAccount(ctx, identity.userId);
  const accessToken = await requireDiscordAccessToken(ctx, account);
  return {
    accessToken,
  };
};

const oauthError = (status: "BAD_REQUEST" | "UNAUTHORIZED", error: string, description: string) =>
  new APIError(status, {
    error,
    error_description: description,
    message: description,
  });

const serviceAccountUsername = (serviceAccount: string) => {
  const [namespace, name] = serviceAccount.split("/");
  return namespace && name ? `system:serviceaccount:${namespace}:${name}` : serviceAccount;
};

const readRequiredTokenFile = async (path: string) => (await readFile(path, "utf8")).trim();

const tokenReviewRequest = async ({
  url,
  reviewerToken,
  ca,
  token,
  audience,
}: {
  readonly url: string;
  readonly reviewerToken: string;
  readonly ca: string | undefined;
  readonly token: string;
  readonly audience: string;
}) =>
  await new Promise<unknown>((resolve, reject) => {
    const parsedUrl = new URL(url);
    const request = parsedUrl.protocol === "http:" ? httpRequest : httpsRequest;
    const body = JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: {
        token,
        audiences: [audience],
      },
    });

    const req = request(
      parsedUrl,
      {
        method: "POST",
        ca,
        headers: {
          authorization: `Bearer ${reviewerToken}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`TokenReview failed with HTTP ${res.statusCode}: ${responseBody}`));
            return;
          }

          try {
            resolve(JSON.parse(responseBody) as unknown);
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    req.on("error", reject);
    req.end(body);
  });

export const verifyKubernetesServiceAccountToken = async (
  token: string,
  options: SheetOAuthKubernetesSubjectTokenMintingOptions,
) => {
  const reviewerToken = await readRequiredTokenFile(
    options.reviewerTokenPath ?? "/var/run/secrets/tokens/kubernetes-jwks-token",
  );
  const ca = await readFile(
    options.caPath ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
    "utf8",
  ).catch(() => undefined);
  const response = await tokenReviewRequest({
    url:
      options.tokenReviewUrl ??
      "https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews",
    reviewerToken,
    ca,
    token,
    audience: options.audience,
  });

  const status = isObjectRecord(response) ? response.status : undefined;
  const user = isObjectRecord(status) ? status.user : undefined;
  const username = isObjectRecord(user) && typeof user.username === "string" ? user.username : "";
  const audiences =
    isObjectRecord(status) && Array.isArray(status.audiences)
      ? status.audiences.filter((audience): audience is string => typeof audience === "string")
      : [];
  const authenticated = isObjectRecord(status) && status.authenticated === true;
  const allowedUsernames = new Set(options.allowedServiceAccounts.map(serviceAccountUsername));

  if (
    !authenticated ||
    !audiences.includes(options.audience) ||
    !username ||
    !allowedUsernames.has(username)
  ) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Invalid Kubernetes service account token");
  }

  return {
    username,
    audiences,
  };
};

const assertSubjectTokenMintingConfigured = (
  options: SheetOAuthOptions,
): Required<SheetOAuthSubjectTokenMintingOptions> => {
  const minting = options.tokenExchange?.subjectTokenMinting;
  if (!minting?.secret || !minting.kubernetes) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Subject token minting is not configured");
  }

  return {
    secret: minting.secret,
    issuer: minting.issuer ?? options.issuer,
    audience: minting.audience ?? options.issuer,
    expiresIn: minting.expiresIn ?? 60,
    allowedSubjectPrefixes: minting.allowedSubjectPrefixes ?? ["discord:"],
    kubernetes: minting.kubernetes,
  };
};

const assertAllowedSubject = (subject: string, allowedSubjectPrefixes: readonly string[]) => {
  if (!allowedSubjectPrefixes.some((prefix) => subject.startsWith(prefix))) {
    throw oauthError("BAD_REQUEST", "invalid_request", "Requested subject is not allowed");
  }
};

const createMintedSubjectToken = async (
  ctx: EndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetOAuthSubjectTokenResponse> => {
  const minting = assertSubjectTokenMintingConfigured(options);
  assertAllowedSubject(ctx.body.subject, minting.allowedSubjectPrefixes);

  const kubernetesToken = getBearerToken(ctx.request?.headers.get("authorization"));
  if (!kubernetesToken) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Missing Kubernetes service account token");
  }

  const workload = await verifyKubernetesServiceAccountToken(kubernetesToken, minting.kubernetes);
  const iat = Math.floor(Date.now() / 1000);
  const expiresIn = Math.min(Math.max(Math.floor(ctx.body.expiresIn ?? minting.expiresIn), 1), 300);
  const exp = iat + expiresIn;
  const audience = ctx.body.audience ?? minting.audience;
  const subjectToken = await new SignJWT({
    k8s: {
      sub: workload.username,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(minting.issuer.replace(/\/$/, ""))
    .setSubject(ctx.body.subject)
    .setAudience(audience.replace(/\/$/, ""))
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(minting.secret));

  return {
    subject_token: subjectToken,
    subject_token_type: JwtTokenType,
    expires_in: expiresIn,
    expires_at: exp,
  };
};

export const createJwtSubjectTokenResolver =
  (options: SheetOAuthJwtSubjectResolverOptions): SheetOAuthTokenExchangeSubjectResolver =>
  async ({ ctx, actor, subjectToken, subjectTokenType, request }) => {
    if (subjectTokenType !== JwtTokenType) {
      return undefined;
    }

    let payload: JWTPayload;
    try {
      payload = (
        await jwtVerify(subjectToken, new TextEncoder().encode(options.secret), {
          issuer: options.issuer.replace(/\/$/, ""),
          audience: options.audience.replace(/\/$/, ""),
          algorithms: ["HS256"],
        })
      ).payload;
    } catch {
      throw oauthError("UNAUTHORIZED", "invalid_request", "Invalid subject token");
    }

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw oauthError("BAD_REQUEST", "invalid_request", "Subject token is missing sub");
    }

    return await options.resolveSubject({
      ctx,
      actor,
      payload,
      subject: payload.sub,
      request,
    });
  };

const assertValidRequestedTokenType = (requestedTokenType: string | undefined) => {
  if (requestedTokenType && requestedTokenType !== AccessTokenType) {
    throw oauthError(
      "BAD_REQUEST",
      "invalid_request",
      `Unsupported requested_token_type ${requestedTokenType}`,
    );
  }
};

const assertValidActorTokenType = (actorTokenType: string | undefined) => {
  if (actorTokenType && actorTokenType !== AccessTokenType) {
    throw oauthError(
      "BAD_REQUEST",
      "invalid_request",
      `Unsupported actor_token_type ${actorTokenType}`,
    );
  }
};

const assertValidTokenExchangeAudience = (audience: string, options: SheetOAuthOptions) => {
  if (!options.validAudiences.includes(audience)) {
    throw oauthError("BAD_REQUEST", "invalid_target", "Requested audience is invalid");
  }
};

const requireTokenExchangeActor = async (
  ctx: EndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetAuthResolvedIdentity> => {
  assertValidActorTokenType(ctx.body.actor_token_type);
  const actorToken =
    ctx.body.actor_token ?? getBearerToken(ctx.request?.headers.get("authorization"));
  if (!actorToken) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Missing actor token");
  }

  const actor = await makeAccessTokenIdentity(ctx, actorToken, options);
  if (!actor.permissions.includes("service")) {
    throw oauthError("UNAUTHORIZED", "invalid_request", "Actor token must be a service token");
  }

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

const requestedTokenExchangeScopes = (
  requestScope: string | undefined,
  subject: SheetOAuthTokenExchangeSubject,
  actor: SheetAuthResolvedIdentity,
) => {
  const requestedScopes = splitScopes(requestScope);
  if (requestedScopes.length > 0) {
    assertScopesAllowedByActor(requestedScopes, actor);
    return requestedScopes;
  }

  const subjectScopes = subject.scopes ?? [];
  return subjectScopes.filter((scope) => actor.scopes.includes(scope));
};

const resolveAccessTokenSubject = async (
  ctx: EndpointContext,
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

const resolveConfiguredSubject = async (
  ctx: EndpointContext,
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
  ctx: EndpointContext,
  actor: SheetAuthResolvedIdentity,
  options: SheetOAuthOptions,
): Promise<SheetOAuthTokenExchangeSubject> => {
  if (ctx.body.subject_token_type === AccessTokenType) {
    return await resolveAccessTokenSubject(ctx, options);
  }

  return await resolveConfiguredSubject(ctx, actor, options);
};

const signTokenExchangeAccessToken = async (
  ctx: EndpointContext,
  options: SheetOAuthOptions,
  input: {
    readonly actor: SheetAuthResolvedIdentity;
    readonly subject: SheetOAuthTokenExchangeSubject;
    readonly audience: string;
    readonly scopes: readonly string[];
  },
): Promise<SheetOAuthTokenExchangeResponse> => {
  const iat = Math.floor(Date.now() / 1000);
  const expiresIn = options.tokenExchange?.accessTokenExpiresIn ?? 3600;
  const exp = iat + expiresIn;
  const scope = input.scopes.join(" ");
  const actorClaims = {
    sub: input.actor.userId,
    client_id: input.actor.clientId,
  };

  const accessToken = await signJWT(ctx as never, {
    payload: {
      ...input.subject.claims,
      iss: options.issuer.replace(/\/$/, ""),
      sub: input.subject.userId,
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

const exchangeToken = async (
  ctx: EndpointContext,
  options: SheetOAuthOptions,
): Promise<SheetOAuthTokenExchangeResponse> => {
  assertValidRequestedTokenType(ctx.body.requested_token_type);
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

export const sheetOAuth = (options: SheetOAuthOptions): SheetOAuthPlugin => ({
  id: "sheet-oauth",
  endpoints: {
    getSheetAuthIdentity: createAuthEndpoint(
      "/sheet-auth/identity",
      {
        method: "GET",
      },
      async (ctx) => {
        const sessionIdentity = await makeSessionIdentity(ctx);
        if (sessionIdentity) {
          return ctx.json(sessionIdentity);
        }

        const token = getBearerToken(ctx.request?.headers.get("authorization"));
        if (!token) {
          throw new APIError("UNAUTHORIZED", {
            message: "Missing bearer token",
          });
        }

        return ctx.json(await makeAccessTokenIdentity(ctx, token, options));
      },
    ),
    getDiscordAccessToken: createAuthEndpoint(
      "/sheet-auth/discord/access-token",
      {
        method: "GET",
      },
      async (ctx) => {
        return ctx.json(await getDiscordProviderAccessToken(ctx, options), {
          headers: {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
          },
        });
      },
    ),
    createTrustedDiscordSession: createAuthEndpoint(
      "/sheet-auth/trusted-discord-session",
      {
        method: "POST",
        body: trustedDiscordSessionBody,
        metadata: {
          allowedMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
        },
      },
      async (ctx) => {
        const token = requireBearerToken(ctx);
        const identity = await makeAccessTokenIdentity(ctx, token, options);
        if (
          !identity.scopes.includes("bot.impersonate") ||
          !identity.permissions.includes("service")
        ) {
          throw new APIError("UNAUTHORIZED", {
            message: "OAuth client cannot create trusted Discord sessions",
          });
        }

        const user = await resolveUserByDiscordId(
          ctx.context.internalAdapter,
          ctx.body.discordUserId,
        );
        const session = await ctx.context.internalAdapter.createSession(user.id, true);

        await setSessionCookie(ctx, { session, user }, true);

        return ctx.json({ session, user });
      },
    ),
    createSubjectToken: createAuthEndpoint(
      "/sheet-auth/internal/subject-token",
      {
        method: "POST",
        body: subjectTokenBody,
        metadata: {
          allowedMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
        },
      },
      async (ctx) => {
        return ctx.json(await createMintedSubjectToken(ctx, options), {
          headers: {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
          },
        });
      },
    ),
    exchangeOAuthToken: createAuthEndpoint(
      "/sheet-auth/oauth2/token-exchange",
      {
        method: "POST",
        body: tokenExchangeBody,
        metadata: {
          allowedMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
        },
      },
      async (ctx) => {
        return ctx.json(await exchangeToken(ctx, options), {
          headers: {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
          },
        });
      },
    ),
  },
});
