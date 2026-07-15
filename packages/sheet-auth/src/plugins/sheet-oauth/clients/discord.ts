import { APIError } from "better-auth";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { Effect, Predicate, Schema } from "effect";
import { findDiscordOAuthAccountForUser } from "../accounts";
import type { OAuth2RefreshTokens, SheetOAuthEndpointContext, SheetOAuthOptions } from "../types";
import { requireUserOAuthIdentity } from "../verifiers/access-token";
import { dedupeAsync } from "./dedupe-async";

const resolveSocialProvider = async (ctx: SheetOAuthEndpointContext, providerId: string) => {
  for (const entry of ctx.context.socialProviders ?? []) {
    const provider = Predicate.isFunction(entry) ? await entry() : entry;
    if (provider?.id === providerId) {
      return provider;
    }
  }
  return undefined;
};

type DiscordOAuthAccount = NonNullable<Awaited<ReturnType<typeof findDiscordOAuthAccountForUser>>>;

const OAuth2RefreshTokensSchema = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  refreshToken: Schema.optional(Schema.String),
  accessTokenExpiresAt: Schema.optional(Schema.Union([Schema.Date, Schema.DateFromString])),
  refreshTokenExpiresAt: Schema.optional(Schema.Union([Schema.Date, Schema.DateFromString])),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  idToken: Schema.optional(Schema.String),
});

const discordRefreshes = new Map<string, Promise<string>>();
const RefreshAccessTokenFallbackLifetimeMs = 5 * 60_000;

const isDiscordCredentialError = (error: unknown) => {
  if (Predicate.isTagged(error, "SchemaError")) {
    return true;
  }
  const status = Predicate.hasProperty(error, "status") ? error.status : undefined;
  if (status === 400 || status === 401) {
    return true;
  }
  const message = Predicate.isError(error) ? error.message : String(error);
  return /invalid[_ -]?grant|invalid refresh|revoked/i.test(message);
};

const accessTokenExpiresSoon = (account: DiscordOAuthAccount) => {
  const expiresAt = Predicate.isDate(account.accessTokenExpiresAt)
    ? account.accessTokenExpiresAt
    : account.accessTokenExpiresAt
      ? new Date(account.accessTokenExpiresAt)
      : undefined;

  return expiresAt ? expiresAt.getTime() - Date.now() < 60_000 : true;
};

export const refreshDiscordAccessToken = async (
  ctx: SheetOAuthEndpointContext,
  account: DiscordOAuthAccount,
) => {
  const provider = await resolveSocialProvider(ctx, "discord");
  if (!provider?.refreshAccessToken || !account.refreshToken) {
    return undefined;
  }

  const refreshToken = await decryptOAuthToken(account.refreshToken, ctx.context);
  let newTokens: OAuth2RefreshTokens;
  try {
    newTokens = await Effect.runPromise(
      Effect.tryPromise({
        try: () => provider.refreshAccessToken(refreshToken),
        catch: (error) => error,
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.flatMap(Schema.decodeUnknownEffect(OAuth2RefreshTokensSchema)),
      ),
    );
  } catch (error) {
    const errorMessage = Predicate.isError(error) ? error.message : String(error);
    ctx.context.logger?.error?.("Discord access-token refresh failed", errorMessage);
    throw new APIError(isDiscordCredentialError(error) ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE", {
      message: isDiscordCredentialError(error)
        ? "Discord login required"
        : "Discord token refresh unavailable",
    });
  }
  const updatedData = {
    accessToken: await setTokenUtil(newTokens.accessToken, ctx.context),
    accessTokenExpiresAt:
      newTokens.accessTokenExpiresAt ?? new Date(Date.now() + RefreshAccessTokenFallbackLifetimeMs),
    refreshToken:
      newTokens.refreshToken === undefined
        ? account.refreshToken
        : await setTokenUtil(newTokens.refreshToken, ctx.context),
    refreshTokenExpiresAt: newTokens.refreshTokenExpiresAt ?? account.refreshTokenExpiresAt,
    scope: newTokens.scopes === undefined ? account.scope : newTokens.scopes.join(","),
    idToken: newTokens.idToken === undefined ? account.idToken : newTokens.idToken,
  };

  if (account.id) {
    await ctx.context.internalAdapter.updateAccount(account.id, updatedData);
  }

  return newTokens.accessToken;
};

export const maybeRefreshDiscordAccessToken = async (
  ctx: SheetOAuthEndpointContext,
  account: DiscordOAuthAccount,
) => {
  if (account.accessToken && !accessTokenExpiresSoon(account)) {
    return undefined;
  }

  const refreshKey = account.id ?? `${account.providerId}:${account.accountId}`;
  return await dedupeAsync(discordRefreshes, refreshKey, async () => {
    const latestAccount = account.userId
      ? ((await findDiscordOAuthAccountForUser(ctx.context.internalAdapter, account.userId)) ??
        account)
      : account;
    if (latestAccount.accessToken && !accessTokenExpiresSoon(latestAccount)) {
      return await decryptOAuthToken(latestAccount.accessToken, ctx.context);
    }

    const refreshedAccessToken = await refreshDiscordAccessToken(ctx, latestAccount);
    if (!refreshedAccessToken) {
      throw new APIError("UNAUTHORIZED", {
        message: "Discord login required",
      });
    }
    return refreshedAccessToken;
  });
};

const requireDiscordOAuthAccount = async (
  ctx: SheetOAuthEndpointContext,
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
  ctx: SheetOAuthEndpointContext,
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

export const getDiscordProviderAccessToken = async (
  ctx: SheetOAuthEndpointContext,
  options: SheetOAuthOptions,
) => {
  const identity = await requireUserOAuthIdentity(ctx, options);
  const account = await requireDiscordOAuthAccount(ctx, identity.userId);
  const accessToken = await requireDiscordAccessToken(ctx, account);
  return {
    accessToken,
  };
};
