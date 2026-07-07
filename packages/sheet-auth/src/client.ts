// fallow-ignore-file code-duplication
import { DateTime, Deferred, Effect, Option, Redacted, Schema } from "effect";
import { createAuthClient } from "better-auth/client";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { Account, Session } from "./model";
import { sheetOAuthClient } from "./plugins/sheet-oauth/client";

// =============================================================================
// 1. Errors
// =============================================================================

export class SessionResponseError extends Schema.TaggedErrorClass<SessionResponseError>(
  "SessionResponseError",
)("SessionResponseError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error type for token verification failures
 */
export class TokenVerificationError extends Schema.TaggedErrorClass<TokenVerificationError>(
  "TokenVerificationError",
)("TokenVerificationError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error type for account retrieval failures
 */
export class AccountError extends Schema.TaggedErrorClass<AccountError>("AccountError")(
  "AccountError",
  {
    statusText: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * Error type for Discord access token retrieval failures
 */
export class DiscordAccessTokenError extends Schema.TaggedErrorClass<DiscordAccessTokenError>(
  "DiscordAccessTokenError",
)("DiscordAccessTokenError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class TrustedDiscordSessionError extends Schema.TaggedErrorClass<TrustedDiscordSessionError>(
  "TrustedDiscordSessionError",
)("TrustedDiscordSessionError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class SheetAuthIdentityError extends Schema.TaggedErrorClass<SheetAuthIdentityError>(
  "SheetAuthIdentityError",
)("SheetAuthIdentityError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class OAuthClientCredentialsTokenError extends Schema.TaggedErrorClass<OAuthClientCredentialsTokenError>(
  "OAuthClientCredentialsTokenError",
)("OAuthClientCredentialsTokenError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class OAuthTokenExchangeError extends Schema.TaggedErrorClass<OAuthTokenExchangeError>(
  "OAuthTokenExchangeError",
)("OAuthTokenExchangeError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class OAuthSubjectTokenError extends Schema.TaggedErrorClass<OAuthSubjectTokenError>(
  "OAuthSubjectTokenError",
)("OAuthSubjectTokenError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class OAuthClientManagementError extends Schema.TaggedErrorClass<OAuthClientManagementError>(
  "OAuthClientManagementError",
)("OAuthClientManagementError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// =============================================================================
// 2. Types
// =============================================================================

type BetterAuthClientError = {
  readonly statusText: string;
  readonly message?: string | undefined;
};

type BetterAuthClientResult<Data> = {
  readonly data?: Data | null | undefined;
  readonly error?: BetterAuthClientError | null | undefined;
};

type BetterAuthFetchSuccessContext = {
  readonly response: Response;
};

type BetterAuthSessionData = {
  readonly user: {
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly name: string;
    readonly image?: string | null | undefined;
  };
  readonly session?: {
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly userId: string;
    readonly expiresAt: Date;
    readonly token: string;
    readonly ipAddress?: string | null | undefined;
    readonly userAgent?: string | null | undefined;
  };
};

type BetterAuthAccountData = {
  readonly scopes: string[];
  readonly userId: string;
  readonly accountId: string;
  readonly providerId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type BetterAuthAccessTokenData = {
  readonly accessToken: string;
};

type BetterAuthRequestOptions = {
  readonly fetchOptions?: {
    readonly headers?: Headers | HeadersInit | undefined;
    readonly onSuccess?: (ctx: BetterAuthFetchSuccessContext) => Promise<void>;
  };
};

type BetterAuthFetchOptions = {
  readonly headers?: Headers | HeadersInit | undefined;
};

type OAuthTokenEndpointData = {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly expires_at: number;
  readonly scope: string;
};

type OAuthTokenExchangeData = OAuthTokenEndpointData & {
  readonly issued_token_type: string;
};

type OAuthSubjectTokenData = {
  readonly subject_token: string;
  readonly subject_token_type: string;
  readonly expires_in: number;
  readonly expires_at: number;
};

export type SheetAuthClient = {
  readonly getSession: (options: {
    readonly fetchOptions?: {
      readonly headers?: Headers | HeadersInit | undefined;
      readonly onSuccess?: (ctx: BetterAuthFetchSuccessContext) => Promise<void>;
    };
  }) => Promise<BetterAuthClientResult<BetterAuthSessionData>>;
  readonly listAccounts: (options: {
    readonly fetchOptions?: {
      readonly headers?: Headers | HeadersInit | undefined;
    };
  }) => Promise<BetterAuthClientResult<BetterAuthAccountData[]>>;
  readonly getAccessToken: (options: {
    readonly providerId: string;
    readonly fetchOptions?: {
      readonly headers?: Headers | HeadersInit | undefined;
    };
  }) => Promise<BetterAuthClientResult<BetterAuthAccessTokenData>>;
  readonly signOut: () => Promise<BetterAuthClientResult<unknown>>;
  readonly signIn: {
    readonly social: (options: {
      readonly provider: "discord";
      readonly callbackURL: string;
    }) => Promise<BetterAuthClientResult<unknown>>;
  };
  readonly sheetAuth: {
    readonly discord: {
      readonly accessToken: (
        options: BetterAuthRequestOptions,
      ) => Promise<BetterAuthClientResult<SheetAuthDiscordAccessTokenResponse>>;
    };
    readonly identity: (
      options: BetterAuthRequestOptions,
    ) => Promise<BetterAuthClientResult<SheetAuthResolvedIdentity>>;
    readonly oauth2: {
      readonly tokenExchange: (
        options: Record<string, unknown>,
      ) => Promise<BetterAuthClientResult<OAuthTokenExchangeData>>;
    };
    readonly internal: {
      readonly subjectToken: (
        options: Record<string, unknown>,
      ) => Promise<BetterAuthClientResult<OAuthSubjectTokenData>>;
    };
    readonly trustedDiscordSession: (
      options: {
        readonly discordUserId: string;
      } & BetterAuthRequestOptions,
    ) => Promise<BetterAuthClientResult<BetterAuthSessionData>>;
  };
  readonly oauth2: {
    readonly token: (
      options: Record<string, unknown>,
      fetchOptions?: BetterAuthFetchOptions,
    ) => Promise<BetterAuthClientResult<OAuthTokenEndpointData>>;
    readonly getClients: (
      options: BetterAuthRequestOptions,
    ) => Promise<BetterAuthClientResult<OAuthClientDetails[]>>;
    readonly createClient: (
      options: Record<string, unknown>,
    ) => Promise<BetterAuthClientResult<OAuthClientDetails>>;
    readonly updateClient: (
      options: Record<string, unknown>,
    ) => Promise<BetterAuthClientResult<OAuthClientDetails>>;
    readonly client: {
      readonly rotateSecret: (
        options: Record<string, unknown>,
      ) => Promise<BetterAuthClientResult<OAuthClientDetails>>;
    };
    readonly deleteClient: (
      options: Record<string, unknown>,
    ) => Promise<BetterAuthClientResult<unknown>>;
  };
};

const betterAuthCoreClient = (client: SheetAuthClient): SheetAuthClient => client;

export interface SheetAuthResolvedIdentity {
  readonly tokenType: "session" | "oauth_access_token";
  readonly userId: string;
  readonly accountId: string;
  readonly clientId?: string | undefined;
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
  readonly expiresAt?: string | undefined;
}

export interface OAuthClientCredentialsToken {
  readonly accessToken: Redacted.Redacted<string>;
  readonly tokenType: string;
  readonly expiresIn: number;
  readonly expiresAt: number;
  readonly scope: string;
}

export interface OAuthTokenExchangeToken {
  readonly accessToken: Redacted.Redacted<string>;
  readonly issuedTokenType: string;
  readonly tokenType: string;
  readonly expiresIn: number;
  readonly expiresAt: number;
  readonly scope: string;
}

export interface OAuthSubjectToken {
  readonly subjectToken: Redacted.Redacted<string>;
  readonly subjectTokenType: string;
  readonly expiresIn: number;
  readonly expiresAt: number;
}

export interface SheetAuthDiscordAccessTokenResponse {
  readonly accessToken: string;
}

export interface OAuthClientDetails {
  readonly client_id: string;
  readonly client_secret?: string | undefined;
  readonly client_secret_expires_at?: number | undefined;
  readonly client_id_issued_at?: number | undefined;
  readonly user_id?: string | null | undefined;
  readonly client_name?: string | undefined;
  readonly client_uri?: string | undefined;
  readonly logo_uri?: string | undefined;
  readonly contacts?: readonly string[] | undefined;
  readonly tos_uri?: string | undefined;
  readonly policy_uri?: string | undefined;
  readonly redirect_uris?: readonly string[] | undefined;
  readonly post_logout_redirect_uris?: readonly string[] | undefined;
  readonly token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
  readonly grant_types?: readonly ("authorization_code" | "client_credentials" | "refresh_token")[];
  readonly response_types?: readonly "code"[];
  readonly scope?: string | undefined;
  readonly public?: boolean | undefined;
  readonly type?: "web" | "native" | "user-agent-based" | undefined;
  readonly disabled?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface OAuthClientCreateInput {
  readonly redirect_uris: readonly string[];
  readonly scope?: string | undefined;
  readonly client_name?: string | undefined;
  readonly client_uri?: string | undefined;
  readonly logo_uri?: string | undefined;
  readonly contacts?: readonly string[] | undefined;
  readonly tos_uri?: string | undefined;
  readonly policy_uri?: string | undefined;
  readonly token_endpoint_auth_method?: "none" | "client_secret_basic" | "client_secret_post";
  readonly grant_types?: readonly ("authorization_code" | "client_credentials" | "refresh_token")[];
  readonly response_types?: readonly "code"[];
  readonly type?: "web" | "native" | "user-agent-based";
}

export type OAuthClientUpdateInput = Partial<
  Pick<
    OAuthClientCreateInput,
    | "redirect_uris"
    | "scope"
    | "client_name"
    | "client_uri"
    | "logo_uri"
    | "contacts"
    | "tos_uri"
    | "policy_uri"
    | "grant_types"
    | "response_types"
    | "type"
  >
>;

type OAuthClientCredentialsTokenOptions = {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string> | string;
  readonly scope?: readonly string[] | string | undefined;
  readonly resource?: string | undefined;
};

export type OAuthTokenExchangeTokenOptions = {
  readonly subjectToken: Redacted.Redacted<string> | string;
  readonly subjectTokenType: string;
  readonly actorToken?: Redacted.Redacted<string> | string | undefined;
  readonly actorTokenType?: string | undefined;
  readonly requestedTokenType?: string | undefined;
  readonly audience?: string | undefined;
  readonly resource?: string | undefined;
  readonly scope?: readonly string[] | string | undefined;
};

export type OAuthSubjectTokenOptions = {
  readonly subject: string;
  readonly kubernetesServiceAccountToken: Redacted.Redacted<string> | string;
  readonly audience?: string | undefined;
  readonly expiresIn?: number | undefined;
};

const oauthClientCredentialsScope = (
  scope: OAuthClientCredentialsTokenOptions["scope"],
): string | undefined => (typeof scope === "string" ? scope : scope?.join(" "));

const oauthClientSecretValue = (secret: OAuthClientCredentialsTokenOptions["clientSecret"]) =>
  typeof secret === "string" ? secret : Redacted.value(secret);

const redactedValue = (value: Redacted.Redacted<string> | string) =>
  typeof value === "string" ? value : Redacted.value(value);

const oauthClientCredentialsBody = (options: OAuthClientCredentialsTokenOptions) => {
  const scope = oauthClientCredentialsScope(options.scope);
  return {
    grant_type: "client_credentials" as const,
    client_id: options.clientId,
    client_secret: oauthClientSecretValue(options.clientSecret),
    ...(scope ? { scope } : {}),
    ...(options.resource ? { resource: options.resource } : {}),
  };
};

const oauthClientCreateBody = ({
  contacts,
  grant_types,
  redirect_uris,
  response_types,
  ...input
}: OAuthClientCreateInput) => ({
  ...input,
  redirect_uris: [...redirect_uris],
  ...(contacts ? { contacts: [...contacts] } : {}),
  ...(grant_types ? { grant_types: [...grant_types] } : {}),
  ...(response_types ? { response_types: [...response_types] } : {}),
});

const oauthClientUpdateBody = ({
  contacts,
  grant_types,
  redirect_uris,
  response_types,
  ...update
}: OAuthClientUpdateInput) => ({
  ...update,
  ...(redirect_uris ? { redirect_uris: [...redirect_uris] } : {}),
  ...(contacts ? { contacts: [...contacts] } : {}),
  ...(grant_types ? { grant_types: [...grant_types] } : {}),
  ...(response_types ? { response_types: [...response_types] } : {}),
});

const oauthTokenExchangeBody = (options: OAuthTokenExchangeTokenOptions) => {
  const scope = oauthClientCredentialsScope(options.scope);
  return {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange" as const,
    subject_token: redactedValue(options.subjectToken),
    subject_token_type: options.subjectTokenType,
    ...(options.actorToken ? { actor_token: redactedValue(options.actorToken) } : {}),
    ...(options.actorTokenType ? { actor_token_type: options.actorTokenType } : {}),
    ...(options.requestedTokenType ? { requested_token_type: options.requestedTokenType } : {}),
    ...(options.audience ? { audience: options.audience } : {}),
    ...(options.resource ? { resource: options.resource } : {}),
    ...(scope ? { scope } : {}),
  };
};

const oauthSubjectTokenBody = (options: OAuthSubjectTokenOptions) => ({
  subject: options.subject,
  ...(options.audience ? { audience: options.audience } : {}),
  ...(options.expiresIn ? { expiresIn: options.expiresIn } : {}),
});

const makeOAuthClientCredentialsTokenError = (
  statusText: string,
  message: string,
  cause: unknown,
) =>
  new OAuthClientCredentialsTokenError({
    statusText,
    message,
    cause,
  });

const makeOAuthTokenExchangeError = (statusText: string, message: string, cause: unknown) =>
  new OAuthTokenExchangeError({
    statusText,
    message,
    cause,
  });

const makeOAuthSubjectTokenError = (statusText: string, message: string, cause: unknown) =>
  new OAuthSubjectTokenError({
    statusText,
    message,
    cause,
  });

// =============================================================================
// 3. Client Factory
// =============================================================================

/**
 * Create a Better Auth client for stateless authentication.
 *
 * This client is used to call Better Auth APIs from services.
 * The session token is passed via the Authorization header in fetchOptions.
 *
 * @param baseURL - Base URL of the auth server
 * @returns Better Auth client instance
 *
 * @example
 * ```typescript
 * const client = createSheetAuthClient("https://auth.example.com");
 *
 * // Use with bearer token (from session token)
 * const { data } = await client.getAccessToken({
 *   providerId: "discord",
 *   fetchOptions: {
 *     headers: {
 *       Authorization: `Bearer ${sessionToken}`,
 *     },
 *   },
 * });
 * ```
 */
export function createSheetAuthClient(baseURL: string): SheetAuthClient {
  return createAuthClient({
    baseURL,
    basePath: "/",
    fetchOptions: {
      credentials: "include" as const,
    },
    plugins: [oauthProviderClient(), sheetOAuthClient()],
  }) as unknown as SheetAuthClient;
}

const toSession = (
  data: {
    user: {
      createdAt: Date;
      updatedAt: Date;
      email: string;
      emailVerified: boolean;
      name: string;
      image?: string | null | undefined;
    };
    session?: {
      createdAt: Date;
      updatedAt: Date;
      userId: string;
      expiresAt: Date;
      token: string;
      ipAddress?: string | null | undefined;
      userAgent?: string | null | undefined;
    } | null;
  },
  token: string | undefined,
) =>
  new Session({
    user: {
      createdAt: DateTime.fromDateUnsafe(data.user.createdAt),
      updatedAt: DateTime.fromDateUnsafe(data.user.updatedAt),
      email: data.user.email,
      emailVerified: data.user.emailVerified,
      name: data.user.name,
      image: data.user.image,
    },
    session: data.session
      ? {
          createdAt: DateTime.fromDateUnsafe(data.session.createdAt),
          updatedAt: DateTime.fromDateUnsafe(data.session.updatedAt),
          userId: data.session.userId,
          expiresAt: DateTime.fromDateUnsafe(data.session.expiresAt),
          token: data.session.token,
          ipAddress: data.session.ipAddress,
          userAgent: data.session.userAgent,
        }
      : undefined,
    token: token ? Redacted.make(token) : undefined,
  });

/**
 * Get the session using the Better Auth client.
 *
 * @param client - Better Auth client instance
 * @returns Effect with the session
 */
export function getSession(
  client: SheetAuthClient,
  headers?: Headers | HeadersInit,
): Effect.Effect<Option.Option<Session>, SessionResponseError> {
  return Effect.gen(function* () {
    const tokenDeferred = yield* Deferred.make<string | undefined>();
    const context = yield* Effect.context<never>();
    const authClient = betterAuthCoreClient(client);
    const session = yield* Effect.tryPromise({
      try: async () =>
        await authClient.getSession({
          fetchOptions: {
            headers,
            onSuccess: async (ctx) => {
              const token = ctx.response.headers.get("set-auth-token");
              await Effect.runPromiseWith(context)(
                Deferred.succeed(tokenDeferred, token ?? undefined),
              );
            },
          },
        }),
      catch: (error) =>
        new SessionResponseError({
          statusText: "GET_SESSION_FAILED",
          message: `GET_SESSION_FAILED: ${error instanceof Error ? error.message : "Failed to get session"}`,
          cause: error,
        }),
    });

    if (session.error) {
      return yield* new SessionResponseError({
        statusText: session.error.statusText,
        message: `${session.error.statusText}: ${session.error.message || "Failed to get session"}`,
        cause: session.error,
      });
    }

    const token = yield* Deferred.await(tokenDeferred);

    return Option.fromNullishOr(session.data).pipe(
      Option.map(
        (data) =>
          new Session({
            user: {
              createdAt: DateTime.fromDateUnsafe(data.user.createdAt),
              updatedAt: DateTime.fromDateUnsafe(data.user.updatedAt),
              email: data.user.email,
              emailVerified: data.user.emailVerified,
              name: data.user.name,
              image: data.user.image,
            },
            session: data.session
              ? {
                  createdAt: DateTime.fromDateUnsafe(data.session.createdAt),
                  updatedAt: DateTime.fromDateUnsafe(data.session.updatedAt),
                  userId: data.session.userId,
                  expiresAt: DateTime.fromDateUnsafe(data.session.expiresAt),
                  token: data.session.token,
                  ipAddress: data.session.ipAddress,
                  userAgent: data.session.userAgent,
                }
              : undefined,
            token: token ? Redacted.make(token) : undefined,
          }),
      ),
    );
  });
}

/**
 * Get account using the Better Auth client.
 *
 * @param client - Better Auth client instance
 * @param providerIds - Provider IDs to filter by
 * @param headers - Headers for authentication
 * @returns Effect with the account
 */
export function getAccount(
  client: SheetAuthClient,
  providerIds: string[],
  headers?: Headers | HeadersInit,
): Effect.Effect<Account, AccountError> {
  return Effect.gen(function* () {
    const authClient = betterAuthCoreClient(client);
    const accounts = yield* Effect.tryPromise({
      try: async () =>
        await authClient.listAccounts({
          fetchOptions: {
            headers,
          },
        }),
      catch: (error) =>
        new AccountError({
          statusText: "GET_ACCOUNTS_FAILED",
          message: `GET_ACCOUNTS_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        }),
    });

    if (accounts.error) {
      return yield* new AccountError({
        statusText: accounts.error.statusText,
        message: `${accounts.error.statusText}: ${accounts.error.message || "Failed to get accounts"}`,
        cause: accounts.error,
      });
    }

    const account = accounts.data?.find((account) => providerIds.includes(account.providerId));
    if (!account) {
      return yield* new AccountError({
        statusText: "ACCOUNT_NOT_FOUND",
        message: "ACCOUNT_NOT_FOUND: Account not found",
      });
    }

    return new Account({
      scopes: account.scopes,
      userId: account.userId,
      accountId: account.accountId,
      providerId: account.providerId,
      createdAt: DateTime.fromDateUnsafe(account.createdAt),
      updatedAt: DateTime.fromDateUnsafe(account.updatedAt),
    });
  });
}

// =============================================================================
// 6. Discord Access Token
// =============================================================================

/**
 * Get Discord access token using the Better Auth client.
 *
 * This function calls Better Auth's getAccessToken endpoint which:
 * - Returns the current access token if valid
 * - Automatically refreshes the token if expired
 *
 * The session token is passed via the Authorization header for authentication.
 *
 * @param client - Better Auth client instance
 * @param headers - Headers for authentication
 * @returns Effect with the access token
 */
export function getDiscordAccessToken(
  client: SheetAuthClient,
  headers?: Headers | HeadersInit,
): Effect.Effect<{ accessToken: Redacted.Redacted<string> }, DiscordAccessTokenError> {
  return Effect.gen(function* () {
    const authClient = betterAuthCoreClient(client);
    const accessToken = yield* Effect.tryPromise({
      try: async () =>
        await authClient.getAccessToken({
          providerId: "discord",
          fetchOptions: {
            headers,
          },
        }),
      catch: (error) =>
        error instanceof DiscordAccessTokenError
          ? error
          : new DiscordAccessTokenError({
              statusText: "GET_DISCORD_ACCESS_TOKEN_FAILED",
              message: `GET_DISCORD_ACCESS_TOKEN_FAILED: ${error instanceof Error ? error.message : "Failed to get Discord access token"}`,
              cause: error,
            }),
    });

    if (accessToken.error) {
      return yield* new DiscordAccessTokenError({
        statusText: accessToken.error.statusText,
        message: `${accessToken.error.statusText}: ${accessToken.error.message || "Failed to get Discord access token"}`,
        cause: accessToken.error,
      });
    }

    if (!accessToken.data?.accessToken) {
      return yield* new DiscordAccessTokenError({
        statusText: "NO_DISCORD_ACCESS_TOKEN",
        message: "NO_DISCORD_ACCESS_TOKEN: No Discord access token returned from Better Auth",
      });
    }

    return { accessToken: Redacted.make(accessToken.data.accessToken) };
  });
}

export function getDiscordAccessTokenWithOAuth(
  client: SheetAuthClient,
  headers?: Headers | HeadersInit,
): Effect.Effect<{ accessToken: Redacted.Redacted<string> }, DiscordAccessTokenError> {
  return Effect.gen(function* () {
    const accessToken = yield* Effect.tryPromise({
      try: async () =>
        await client.sheetAuth.discord.accessToken({
          fetchOptions: {
            headers,
          },
        }),
      catch: (error) =>
        error instanceof DiscordAccessTokenError
          ? error
          : new DiscordAccessTokenError({
              statusText: "GET_DISCORD_ACCESS_TOKEN_FAILED",
              message: `GET_DISCORD_ACCESS_TOKEN_FAILED: ${error instanceof Error ? error.message : "Failed to get Discord access token"}`,
              cause: error,
            }),
    });

    if (accessToken.error) {
      return yield* new DiscordAccessTokenError({
        statusText: accessToken.error.statusText,
        message: `${accessToken.error.statusText}: ${accessToken.error.message || "Failed to get Discord access token"}`,
        cause: accessToken.error,
      });
    }

    if (!accessToken.data?.accessToken) {
      return yield* new DiscordAccessTokenError({
        statusText: "NO_DISCORD_ACCESS_TOKEN",
        message: "NO_DISCORD_ACCESS_TOKEN: No Discord access token returned from sheet-auth",
      });
    }

    return { accessToken: Redacted.make(accessToken.data.accessToken) };
  });
}

export function getSheetAuthIdentity(
  client: SheetAuthClient,
  headers?: Headers | HeadersInit,
): Effect.Effect<SheetAuthResolvedIdentity, SheetAuthIdentityError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async () =>
        await client.sheetAuth.identity({
          fetchOptions: {
            headers,
          },
        }),
      catch: (error) =>
        new SheetAuthIdentityError({
          statusText: "GET_SHEET_AUTH_IDENTITY_FAILED",
          message: `GET_SHEET_AUTH_IDENTITY_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          cause: error,
        }),
    });

    if (response.error || !response.data) {
      return yield* new SheetAuthIdentityError({
        statusText: response.error?.statusText ?? "GET_SHEET_AUTH_IDENTITY_FAILED",
        message: `${response.error?.statusText ?? "GET_SHEET_AUTH_IDENTITY_FAILED"}: ${
          response.error?.message || "Failed to resolve sheet-auth identity"
        }`,
        cause: response.error,
      });
    }

    return response.data;
  });
}

export function createOAuthClientCredentialsToken(
  client: SheetAuthClient,
  options: OAuthClientCredentialsTokenOptions,
): Effect.Effect<OAuthClientCredentialsToken, OAuthClientCredentialsTokenError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async () =>
        await client.oauth2.token(oauthClientCredentialsBody(options), {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }),
      catch: (error) =>
        makeOAuthClientCredentialsTokenError(
          "CREATE_OAUTH_CLIENT_CREDENTIALS_TOKEN_FAILED",
          `CREATE_OAUTH_CLIENT_CREDENTIALS_TOKEN_FAILED: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error,
        ),
    });

    if (response.error || !response.data) {
      return yield* makeOAuthClientCredentialsTokenError(
        response.error?.statusText ?? "CREATE_OAUTH_CLIENT_CREDENTIALS_TOKEN_FAILED",
        `${response.error?.statusText ?? "CREATE_OAUTH_CLIENT_CREDENTIALS_TOKEN_FAILED"}: ${
          response.error?.message || "Failed to create OAuth client credentials token"
        }`,
        response.error,
      );
    }

    return {
      accessToken: Redacted.make(response.data.access_token),
      tokenType: response.data.token_type,
      expiresIn: response.data.expires_in,
      expiresAt: response.data.expires_at,
      scope: response.data.scope,
    };
  });
}

export function exchangeOAuthToken(
  client: SheetAuthClient,
  options: OAuthTokenExchangeTokenOptions,
): Effect.Effect<OAuthTokenExchangeToken, OAuthTokenExchangeError> {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async () => await client.sheetAuth.oauth2.tokenExchange(oauthTokenExchangeBody(options)),
      catch: (error) =>
        makeOAuthTokenExchangeError(
          "EXCHANGE_OAUTH_TOKEN_FAILED",
          `EXCHANGE_OAUTH_TOKEN_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          error,
        ),
    });

    if (response.error || !response.data) {
      return yield* makeOAuthTokenExchangeError(
        response.error?.statusText ?? "EXCHANGE_OAUTH_TOKEN_FAILED",
        `${response.error?.statusText ?? "EXCHANGE_OAUTH_TOKEN_FAILED"}: ${
          response.error?.message || "Failed to exchange OAuth token"
        }`,
        response.error,
      );
    }

    return {
      accessToken: Redacted.make(response.data.access_token),
      issuedTokenType: response.data.issued_token_type,
      tokenType: response.data.token_type,
      expiresIn: response.data.expires_in,
      expiresAt: response.data.expires_at,
      scope: response.data.scope,
    };
  });
}

export function createOAuthSubjectToken(
  client: SheetAuthClient,
  options: OAuthSubjectTokenOptions,
): Effect.Effect<OAuthSubjectToken, OAuthSubjectTokenError> {
  return Effect.gen(function* () {
    const kubernetesServiceAccountToken = redactedValue(options.kubernetesServiceAccountToken);
    const response = yield* Effect.tryPromise({
      try: async () =>
        await client.sheetAuth.internal.subjectToken({
          ...oauthSubjectTokenBody(options),
          fetchOptions: {
            headers: {
              Authorization: `Bearer ${kubernetesServiceAccountToken}`,
            },
          },
        }),
      catch: (error) =>
        makeOAuthSubjectTokenError(
          "CREATE_OAUTH_SUBJECT_TOKEN_FAILED",
          `CREATE_OAUTH_SUBJECT_TOKEN_FAILED: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error,
        ),
    });

    if (response.error || !response.data) {
      return yield* makeOAuthSubjectTokenError(
        response.error?.statusText ?? "CREATE_OAUTH_SUBJECT_TOKEN_FAILED",
        `${response.error?.statusText ?? "CREATE_OAUTH_SUBJECT_TOKEN_FAILED"}: ${
          response.error?.message || "Failed to create OAuth subject token"
        }`,
        response.error,
      );
    }

    return {
      subjectToken: Redacted.make(response.data.subject_token),
      subjectTokenType: response.data.subject_token_type,
      expiresIn: response.data.expires_in,
      expiresAt: response.data.expires_at,
    };
  });
}

export function createTrustedDiscordSession(
  client: SheetAuthClient,
  discordUserId: string,
  oauthToken: Redacted.Redacted<string> | string,
): Effect.Effect<Session, TrustedDiscordSessionError> {
  return Effect.gen(function* () {
    const tokenDeferred = yield* Deferred.make<string | undefined>();
    const context = yield* Effect.context<never>();
    const response = yield* Effect.tryPromise({
      try: async () =>
        await client.sheetAuth.trustedDiscordSession({
          discordUserId,
          fetchOptions: {
            headers: {
              Authorization: `Bearer ${
                typeof oauthToken === "string" ? oauthToken : Redacted.value(oauthToken)
              }`,
            },
            onSuccess: async (ctx) => {
              const token = ctx.response.headers.get("set-auth-token");
              await Effect.runPromiseWith(context)(
                Deferred.succeed(tokenDeferred, token ?? undefined),
              );
            },
          },
        }),
      catch: (error) =>
        new TrustedDiscordSessionError({
          statusText: "TRUSTED_DISCORD_SESSION_FAILED",
          message: `TRUSTED_DISCORD_SESSION_FAILED: ${
            error instanceof Error ? error.message : "Failed to create trusted Discord session"
          }`,
          cause: error,
        }),
    });

    if (response.error || !response.data) {
      return yield* new TrustedDiscordSessionError({
        statusText: response.error?.statusText ?? "TRUSTED_DISCORD_SESSION_FAILED",
        message: `${response.error?.statusText ?? "TRUSTED_DISCORD_SESSION_FAILED"}: ${
          response.error?.message || "Failed to create trusted Discord session"
        }`,
        cause: response.error,
      });
    }

    const token = yield* Deferred.await(tokenDeferred);
    return toSession(response.data, token);
  });
}

const oauthClientManagementError = (
  statusText: string,
  message: string,
  cause?: unknown,
): OAuthClientManagementError =>
  new OAuthClientManagementError({
    statusText,
    message: `${statusText}: ${message}`,
    cause,
  });

const unwrapOAuthClientResponse = <T>(
  response: BetterAuthClientResult<T>,
  operation: string,
): Effect.Effect<T, OAuthClientManagementError> => {
  if (response.error || !response.data) {
    return Effect.fail(
      oauthClientManagementError(
        response.error?.statusText ?? operation,
        response.error?.message || "OAuth client request failed",
        response.error,
      ),
    );
  }

  return Effect.succeed(response.data);
};

export function listOAuthClients(
  client: SheetAuthClient,
  headers?: Headers | HeadersInit,
): Effect.Effect<readonly OAuthClientDetails[], OAuthClientManagementError> {
  return Effect.tryPromise({
    try: async () =>
      await client.oauth2.getClients({
        fetchOptions: {
          headers,
        },
      }),
    catch: (error) =>
      oauthClientManagementError(
        "LIST_OAUTH_CLIENTS_FAILED",
        error instanceof Error ? error.message : String(error),
        error,
      ),
  }).pipe(
    Effect.flatMap((response) => unwrapOAuthClientResponse(response, "LIST_OAUTH_CLIENTS_FAILED")),
  );
}

export function createOAuthClient(
  client: SheetAuthClient,
  input: OAuthClientCreateInput,
  headers?: Headers | HeadersInit,
): Effect.Effect<OAuthClientDetails, OAuthClientManagementError> {
  return Effect.tryPromise({
    try: async () =>
      await client.oauth2.createClient({
        ...oauthClientCreateBody(input),
        fetchOptions: {
          headers,
        },
      }),
    catch: (error) =>
      oauthClientManagementError(
        "CREATE_OAUTH_CLIENT_FAILED",
        error instanceof Error ? error.message : String(error),
        error,
      ),
  }).pipe(
    Effect.flatMap((response) => unwrapOAuthClientResponse(response, "CREATE_OAUTH_CLIENT_FAILED")),
  );
}

export function updateOAuthClient(
  client: SheetAuthClient,
  clientId: string,
  update: OAuthClientUpdateInput,
  headers?: Headers | HeadersInit,
): Effect.Effect<OAuthClientDetails, OAuthClientManagementError> {
  return Effect.tryPromise({
    try: async () =>
      await client.oauth2.updateClient({
        client_id: clientId,
        update: oauthClientUpdateBody(update),
        fetchOptions: {
          headers,
        },
      }),
    catch: (error) =>
      oauthClientManagementError(
        "UPDATE_OAUTH_CLIENT_FAILED",
        error instanceof Error ? error.message : String(error),
        error,
      ),
  }).pipe(
    Effect.flatMap((response) => unwrapOAuthClientResponse(response, "UPDATE_OAUTH_CLIENT_FAILED")),
  );
}

export function rotateOAuthClientSecret(
  client: SheetAuthClient,
  clientId: string,
  headers?: Headers | HeadersInit,
): Effect.Effect<OAuthClientDetails, OAuthClientManagementError> {
  return Effect.tryPromise({
    try: async () =>
      await client.oauth2.client.rotateSecret({
        client_id: clientId,
        fetchOptions: {
          headers,
        },
      }),
    catch: (error) =>
      oauthClientManagementError(
        "ROTATE_OAUTH_CLIENT_SECRET_FAILED",
        error instanceof Error ? error.message : String(error),
        error,
      ),
  }).pipe(
    Effect.flatMap((response) =>
      unwrapOAuthClientResponse(response, "ROTATE_OAUTH_CLIENT_SECRET_FAILED"),
    ),
  );
}

export function deleteOAuthClient(
  client: SheetAuthClient,
  clientId: string,
  headers?: Headers | HeadersInit,
): Effect.Effect<void, OAuthClientManagementError> {
  return Effect.tryPromise({
    try: async () =>
      await client.oauth2.deleteClient({
        client_id: clientId,
        fetchOptions: {
          headers,
        },
      }),
    catch: (error) =>
      oauthClientManagementError(
        "DELETE_OAUTH_CLIENT_FAILED",
        error instanceof Error ? error.message : String(error),
        error,
      ),
  }).pipe(
    Effect.flatMap((response) =>
      response.error
        ? Effect.fail(
            oauthClientManagementError(
              response.error.statusText,
              response.error.message || "OAuth client request failed",
              response.error,
            ),
          )
        : Effect.void,
    ),
  );
}
