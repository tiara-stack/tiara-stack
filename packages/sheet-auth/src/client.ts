import { DateTime, Deferred, Effect, Option, Redacted, Schema } from "effect";
import { createAuthClient } from "better-auth/client";
import { Account, Session } from "./model";
import { kubernetesOAuthClient, type Permission } from "./plugins/kubernetes-oauth/client";

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

/**
 * Error type for Kubernetes OAuth sign in failures
 */
export class KubernetesOAuthSignInError extends Schema.TaggedErrorClass<KubernetesOAuthSignInError>(
  "KubernetesOAuthSignInError",
)("KubernetesOAuthSignInError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error type for Kubernetes OAuth implicit permissions retrieval failures
 */
export class KubernetesOAuthImplicitPermissionsError extends Schema.TaggedErrorClass<KubernetesOAuthImplicitPermissionsError>(
  "KubernetesOAuthImplicitPermissionsError",
)("KubernetesOAuthImplicitPermissionsError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error type for OAuth client credentials flow failures
 */
export class OAuthClientCredentialsError extends Schema.TaggedErrorClass<OAuthClientCredentialsError>(
  "OAuthClientCredentialsError",
)("OAuthClientCredentialsError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error type for OAuth token introspection failures
 */
export class OAuthIntrospectionError extends Schema.TaggedErrorClass<OAuthIntrospectionError>(
  "OAuthIntrospectionError",
)("OAuthIntrospectionError", {
  statusText: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// =============================================================================
// 2. Types
// =============================================================================

export type SheetAuthClient = ReturnType<typeof createSheetAuthClient>;

const OAuthClientCredentialsResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  token_type: Schema.optional(Schema.NonEmptyString),
  scope: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});

const OAuthIntrospectionResponse = Schema.Struct({
  active: Schema.optional(Schema.Boolean),
  client_id: Schema.optional(Schema.String),
  sub: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  aud: Schema.optional(Schema.String),
  trusted_client: Schema.optional(Schema.Boolean),
  trustedServiceClient: Schema.optional(Schema.Boolean),
  allowed_services: Schema.optional(Schema.Unknown),
  allowedServices: Schema.optional(Schema.Unknown),
  allowed_scopes: Schema.optional(Schema.Unknown),
  allowedScopes: Schema.optional(Schema.Unknown),
  owner_user_id: Schema.optional(Schema.String),
  client_type: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});

type OAuthClientCredentialsResponse = Schema.Schema.Type<typeof OAuthClientCredentialsResponse>;
type OAuthIntrospectionResponse = Schema.Schema.Type<typeof OAuthIntrospectionResponse>;

export type OAuthClientCredentialsToken = {
  readonly token: Redacted.Redacted<string>;
  readonly tokenType: string;
  readonly scope: string | undefined;
  readonly expiresIn: number | undefined;
};

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
export function createSheetAuthClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    basePath: "/",
    fetchOptions: {
      credentials: "include" as const,
    },
    plugins: [kubernetesOAuthClient()],
  });
}

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
    const session = yield* Effect.tryPromise({
      try: async () =>
        await client.getSession({
          fetchOptions: {
            headers,
            onSuccess: async (ctx) => {
              const token = ctx.response.headers.get("set-auth-token");
              await Effect.runPromise(Deferred.succeed(tokenDeferred, token ?? undefined));
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
      yield* Effect.fail(
        new SessionResponseError({
          statusText: session.error.statusText,
          message: `${session.error.statusText}: ${session.error.message || "Failed to get session"}`,
          cause: session.error,
        }),
      );
      return Option.none();
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
    const accounts = yield* Effect.tryPromise({
      try: async () =>
        await client.listAccounts({
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
      return yield* Effect.fail(
        new AccountError({
          statusText: accounts.error.statusText,
          message: `${accounts.error.statusText}: ${accounts.error.message || "Failed to get accounts"}`,
          cause: accounts.error,
        }),
      );
    }

    const account = accounts.data?.find((account) => providerIds.includes(account.providerId));
    if (!account) {
      return yield* Effect.fail(
        new AccountError({
          statusText: "ACCOUNT_NOT_FOUND",
          message: "ACCOUNT_NOT_FOUND: Account not found",
        }),
      );
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
    const accessToken = yield* Effect.tryPromise({
      try: async () =>
        await client.getAccessToken({
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
      return yield* Effect.fail(
        new DiscordAccessTokenError({
          statusText: accessToken.error.statusText,
          message: `${accessToken.error.statusText}: ${accessToken.error.message || "Failed to get Discord access token"}`,
          cause: accessToken.error,
        }),
      );
    }

    if (!accessToken.data?.accessToken) {
      return yield* Effect.fail(
        new DiscordAccessTokenError({
          statusText: "NO_DISCORD_ACCESS_TOKEN",
          message: "NO_DISCORD_ACCESS_TOKEN: No Discord access token returned from Better Auth",
        }),
      );
    }

    return { accessToken: Redacted.make(accessToken.data.accessToken) };
  });
}

const toBasicAuthHeader = (clientId: string, clientSecret: Redacted.Redacted<string>) =>
  `Basic ${Buffer.from(`${clientId}:${Redacted.value(clientSecret)}`).toString("base64")}`;

export function createOAuthClientCredentialsToken(
  sheetAuthIssuer: string,
  clientId: string,
  clientSecret: Redacted.Redacted<string>,
  scope?: string,
): Effect.Effect<OAuthClientCredentialsToken, OAuthClientCredentialsError> {
  return Effect.gen(function* () {
    const tokenUrl = new URL("/oauth2/token", sheetAuthIssuer).toString();
    const form = new URLSearchParams({ grant_type: "client_credentials" });
    if (scope?.trim().length) {
      form.set("scope", scope.trim());
    }

    const response = yield* Effect.tryPromise({
      try: async () =>
        fetch(tokenUrl, {
          method: "POST",
          headers: {
            authorization: toBasicAuthHeader(clientId, clientSecret),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
        }),
      catch: (error) =>
        new OAuthClientCredentialsError({
          statusText: "CLIENT_CREDENTIALS_REQUEST_FAILED",
          message: `CLIENT_CREDENTIALS_REQUEST_FAILED: ${
            error instanceof Error ? error.message : "Failed to request service access token"
          }`,
          cause: error,
        }),
    });

    if (!response.ok) {
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => "",
      }).pipe(Effect.catch(() => Effect.succeed("")));
      return yield* Effect.fail(
        new OAuthClientCredentialsError({
          statusText: "CLIENT_CREDENTIALS_REQUEST_FAILED",
          message: `CLIENT_CREDENTIALS_REQUEST_FAILED: ${response.status} ${response.statusText}: ${
            body || "<empty body>"
          }`,
        }),
      );
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (error) =>
        new OAuthClientCredentialsError({
          statusText: "CLIENT_CREDENTIALS_PARSE_FAILED",
          message: `CLIENT_CREDENTIALS_PARSE_FAILED: ${
            error instanceof Error ? error.message : "Failed to parse service token response"
          }`,
          cause: error,
        }),
    });

    const tokenPayload = yield* Schema.decodeUnknownEffect(OAuthClientCredentialsResponse)(
      payload,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new OAuthClientCredentialsError({
            statusText: "CLIENT_CREDENTIALS_PARSE_FAILED",
            message: "CLIENT_CREDENTIALS_PARSE_FAILED: Failed to decode service token response",
            cause,
          }),
      ),
    );

    return {
      token: Redacted.make(tokenPayload.access_token),
      tokenType: tokenPayload.token_type ?? "Bearer",
      scope: tokenPayload.scope,
      expiresIn: tokenPayload.expires_in,
    } satisfies OAuthClientCredentialsToken;
  });
}

export function introspectOAuthAccessToken(
  sheetAuthIssuer: string,
  clientId: string,
  clientSecret: Redacted.Redacted<string>,
  token: Redacted.Redacted<string>,
): Effect.Effect<OAuthIntrospectionResponse, OAuthIntrospectionError> {
  return Effect.gen(function* () {
    const introspectionUrl = new URL("/oauth2/introspect", sheetAuthIssuer).toString();
    const form = new URLSearchParams({
      token: Redacted.value(token),
      token_type_hint: "access_token",
      client_id: clientId,
    });

    const response = yield* Effect.tryPromise({
      try: async () =>
        fetch(introspectionUrl, {
          method: "POST",
          headers: {
            authorization: toBasicAuthHeader(clientId, clientSecret),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form,
        }),
      catch: (error) =>
        new OAuthIntrospectionError({
          statusText: "OAUTH_INTROSPECTION_REQUEST_FAILED",
          message: `OAUTH_INTROSPECTION_REQUEST_FAILED: ${
            error instanceof Error ? error.message : "Failed to introspect OAuth token"
          }`,
          cause: error,
        }),
    });

    if (!response.ok) {
      const body = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: () => "",
      }).pipe(Effect.catch(() => Effect.succeed("")));
      return yield* Effect.fail(
        new OAuthIntrospectionError({
          statusText: "OAUTH_INTROSPECTION_REQUEST_FAILED",
          message: `OAUTH_INTROSPECTION_REQUEST_FAILED: ${response.status} ${response.statusText}: ${
            body || "<empty body>"
          }`,
        }),
      );
    }

    const payload = yield* Effect.tryPromise({
      try: () => response.json(),
      catch: (error) =>
        new OAuthIntrospectionError({
          statusText: "OAUTH_INTROSPECTION_PARSE_FAILED",
          message: `OAUTH_INTROSPECTION_PARSE_FAILED: ${
            error instanceof Error ? error.message : "Failed to parse OAuth introspection response"
          }`,
          cause: error,
        }),
    });

    return yield* Schema.decodeUnknownEffect(OAuthIntrospectionResponse)(payload).pipe(
      Effect.mapError(
        (cause) =>
          new OAuthIntrospectionError({
            statusText: "OAUTH_INTROSPECTION_PARSE_FAILED",
            message:
              "OAUTH_INTROSPECTION_PARSE_FAILED: Failed to decode OAuth introspection response",
            cause,
          }),
      ),
    );
  });
}

// =============================================================================
// 7. Create Kubernetes OAuth Session
// =============================================================================

export function createKubernetesOAuthSession(
  client: SheetAuthClient,
  discordUserId: string,
  kubernetesToken: string,
  headers?: Headers | HeadersInit,
): Effect.Effect<Session, KubernetesOAuthSignInError> {
  return Effect.gen(function* () {
    const tokenDeferred = yield* Deferred.make<string | undefined>();

    const response = yield* Effect.tryPromise({
      try: async () =>
        await client.kubernetesOauth.createSession({
          discord_user_id: discordUserId,
          token: kubernetesToken,
          fetchOptions: {
            headers,
            onSuccess: async (ctx) => {
              const token = ctx.response.headers.get("set-auth-token");
              await Effect.runPromise(Deferred.succeed(tokenDeferred, token ?? undefined));
            },
          },
        }),
      catch: (error) =>
        new KubernetesOAuthSignInError({
          statusText: "KUBERNETES_OAUTH_SIGN_IN_FAILED",
          message: `KUBERNETES_OAUTH_SIGN_IN_FAILED: ${error instanceof Error ? error.message : "Failed to sign in with Kubernetes OAuth"}`,
          cause: error,
        }),
    });

    if (response.error) {
      return yield* Effect.fail(
        new KubernetesOAuthSignInError({
          statusText: response.error.statusText,
          message: `${response.error.statusText}: ${response.error.message || "Failed to sign in with Kubernetes OAuth"}`,
          cause: response.error,
        }),
      );
    }

    const token = yield* Deferred.await(tokenDeferred);
    return new Session({
      user: {
        createdAt: DateTime.fromDateUnsafe(response.data.user.createdAt),
        updatedAt: DateTime.fromDateUnsafe(response.data.user.updatedAt),
        email: response.data.user.email,
        emailVerified: response.data.user.emailVerified,
        name: response.data.user.name,
        image: response.data.user.image,
      },
      session: response.data.session
        ? {
            createdAt: DateTime.fromDateUnsafe(response.data.session.createdAt),
            updatedAt: DateTime.fromDateUnsafe(response.data.session.updatedAt),
            userId: response.data.session.userId,
            expiresAt: DateTime.fromDateUnsafe(response.data.session.expiresAt),
            token: response.data.session.token,
            ipAddress: response.data.session.ipAddress,
            userAgent: response.data.session.userAgent,
          }
        : undefined,
      token: token ? Redacted.make(token) : undefined,
    });
  });
}

// =============================================================================
// 8. Kubernetes OAuth Implicit Permissions
// =============================================================================

export function getKubernetesOAuthImplicitPermissions(
  client: SheetAuthClient,
  headers?: Headers | HeadersInit,
): Effect.Effect<{ permissions: Permission[] }, KubernetesOAuthImplicitPermissionsError> {
  return Effect.gen(function* () {
    const permissions = yield* Effect.tryPromise({
      try: async () =>
        await client.kubernetesOauth.getImplicitPermissions({
          fetchOptions: {
            headers,
          },
        }),
      catch: (error) =>
        new KubernetesOAuthImplicitPermissionsError({
          statusText: "GET_KUBERNETES_OAUTH_IMPLICIT_PERMISSIONS_FAILED",
          message: `GET_KUBERNETES_OAUTH_IMPLICIT_PERMISSIONS_FAILED: ${error instanceof Error ? error.message : "Failed to get Kubernetes OAuth implicit permissions"}`,
          cause: error,
        }),
    });

    if (permissions.error) {
      return yield* Effect.fail(
        new KubernetesOAuthImplicitPermissionsError({
          statusText: permissions.error.statusText,
          message: `${permissions.error.statusText}: ${permissions.error.message || "Failed to get Kubernetes OAuth implicit permissions"}`,
          cause: permissions.error,
        }),
      );
    }

    return { permissions: permissions.data?.permissions ?? [] };
  });
}
