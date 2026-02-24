import { Deferred, Effect, Option, Runtime, Schema } from "effect";
import { createAuthClient } from "better-auth/client";
import { jwtClient } from "better-auth/client/plugins";
import { jwtVerify, createLocalJWKSet } from "jose";

// =============================================================================
// 1. Errors
// =============================================================================

export class SessionResponseError extends Schema.TaggedError<SessionResponseError>(
  "SessionResponseError",
)("SessionResponseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error type for token verification failures
 */
export class TokenVerificationError extends Schema.TaggedError<TokenVerificationError>(
  "TokenVerificationError",
)("TokenVerificationError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Error type for Discord access token retrieval failures
 */
export class DiscordAccessTokenError extends Schema.TaggedError<DiscordAccessTokenError>(
  "DiscordAccessTokenError",
)("DiscordAccessTokenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

// =============================================================================
// 2. Types
// =============================================================================

export interface TokenVerificationResult {
  payload: {
    sub: string;
    email?: string;
    name?: string;
    [key: string]: unknown;
  };
}

export type SheetAuthClientOption = ReturnType<typeof SheetAuthClientOption>;
export type SheetAuthClient = ReturnType<typeof createSheetAuthClient>;

// =============================================================================
// 3. Client Factory
// =============================================================================

const SheetAuthClientOption = (baseURL: string) => {
  return {
    baseURL,
    basePath: "/",
    fetchOptions: {
      credentials: "include" as const,
    },
    plugins: [jwtClient()],
  };
};

/**
 * Create a Better Auth client for stateless authentication.
 *
 * This client is used to call Better Auth APIs from services.
 * The JWT token is passed via the Authorization header in fetchOptions.
 *
 * @param baseURL - Base URL of the auth server
 * @returns Better Auth client instance
 *
 * @example
 * ```typescript
 * const client = createSheetAuthClient("https://auth.example.com");
 *
 * // Use with bearer token (from JWT)
 * const { data } = await client.getAccessToken({
 *   providerId: "discord",
 *   fetchOptions: {
 *     headers: {
 *       Authorization: `Bearer ${jwtToken}`,
 *     },
 *   },
 * });
 * ```
 */
export function createSheetAuthClient(baseURL: string) {
  return createAuthClient(SheetAuthClientOption(baseURL));
}

// =============================================================================
// 4. Session
// =============================================================================

/**
 * Get the session using the Better Auth client.
 *
 * @param client - Better Auth client instance
 * @returns Effect with the session
 */
export function getSession(client: SheetAuthClient, headers?: Headers | HeadersInit) {
  return Effect.gen(function* () {
    const runtime = yield* Effect.runtime();
    const jwt = yield* Deferred.make<string | null>();
    const session = yield* Effect.tryPromise({
      try: async () =>
        Option.fromNullable(
          await client.getSession({
            fetchOptions: {
              headers,
              onSuccess: (ctx) =>
                Runtime.runPromise(
                  runtime,
                  Deferred.succeed(jwt, ctx.response.headers.get("set-auth-jwt")).pipe(
                    Effect.asVoid,
                  ),
                ),
              onError: () =>
                Runtime.runPromise(runtime, Deferred.succeed(jwt, null).pipe(Effect.asVoid)),
            },
          }),
        ),
      catch: (error) =>
        new SessionResponseError({
          message: error instanceof Error ? error.message : "Failed to get session",
        }),
    });

    return { session, jwt: Option.fromNullable(yield* jwt) };
  });
}

// =============================================================================
// 5. Token Verification
// =============================================================================

/**
 * Verify a JWT token using Better Auth's client to fetch JWKS,
 * then verify the token locally with jose.
 *
 * Returns standard JWT claims (sub, email, name).
 * To get Discord user ID, use the Better Auth client separately.
 *
 * @param client - Better Auth client instance (with jwtClient plugin)
 * @param token - JWT token to verify
 * @returns Effect with verification result containing standard claims
 */
export function verifyToken(
  client: SheetAuthClient,
  token: string,
): Effect.Effect<TokenVerificationResult, TokenVerificationError> {
  return Effect.gen(function* () {
    // Fetch JWKS using the client
    const jwksData = yield* Effect.tryPromise({
      try: async () => {
        const result = await client.jwks();

        if (result.error) {
          throw new Error(result.error.message || "Failed to fetch JWKS");
        }

        return result.data;
      },
      catch: (error) =>
        new TokenVerificationError({
          message: error instanceof Error ? error.message : "Failed to fetch JWKS",
          cause: error,
        }),
    });

    // Verify the token using jose with the fetched JWKS
    const { payload } = yield* Effect.tryPromise({
      try: async () => {
        const JWKS = createLocalJWKSet(jwksData);
        return await jwtVerify(token, JWKS);
      },
      catch: (error) =>
        new TokenVerificationError({
          message: error instanceof Error ? error.message : "Token verification failed",
          cause: error,
        }),
    });

    const userId = payload.sub as string | undefined;

    if (!userId) {
      return yield* new TokenVerificationError({
        message: "Token missing sub claim",
      });
    }

    return {
      payload: {
        sub: userId,
        email: payload.email as string | undefined,
        name: payload.name as string | undefined,
        ...payload,
      },
    };
  });
}

// =============================================================================
// 5. Discord Access Token
// =============================================================================

/**
 * Get Discord access token using the Better Auth client.
 *
 * This function calls Better Auth's getAccessToken endpoint which:
 * - Returns the current access token if valid
 * - Automatically refreshes the token if expired
 *
 * The JWT token is passed via the Authorization header for authentication.
 *
 * @param client - Better Auth client instance
 * @param jwtToken - JWT bearer token for authentication
 * @returns Effect with the access token
 */
export function getDiscordAccessToken(
  client: SheetAuthClient,
  jwtToken: string,
): Effect.Effect<{ accessToken: string }, DiscordAccessTokenError> {
  return Effect.tryPromise({
    try: async () => {
      const result = await client.getAccessToken({
        providerId: "discord",
        fetchOptions: {
          headers: {
            Authorization: `Bearer ${jwtToken}`,
          },
        },
      });

      if (result.error) {
        throw new DiscordAccessTokenError({
          message: result.error.message || "Failed to get Discord access token",
        });
      }

      if (!result.data?.accessToken) {
        throw new DiscordAccessTokenError({
          message: "No Discord access token returned from Better Auth",
        });
      }

      return { accessToken: result.data.accessToken };
    },
    catch: (error) =>
      error instanceof DiscordAccessTokenError
        ? error
        : new DiscordAccessTokenError({
            message: error instanceof Error ? error.message : String(error),
            cause: error,
          }),
  });
}
