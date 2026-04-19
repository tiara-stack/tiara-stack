import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { readFileSync } from "fs";
import {
  BASE_ERROR_CODES,
  type BetterAuthPlugin,
  type InternalAdapter,
  type Session,
  type User,
} from "better-auth";
import { createAuthEndpoint, type AuthEndpoint, type AuthMiddleware } from "better-auth/plugins";
import { Schema } from "effect";
import { APIError } from "better-auth";
import { setSessionCookie } from "better-auth/cookies";
import { sessionMiddleware } from "better-auth/api";
import { PermissionValues, type Permission } from "./shared";

const KUBERNETES_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const KUBERNETES_JWKS_URL = "https://kubernetes.default.svc.cluster.local/openid/v1/jwks";
export const DISCORD_BOT_USER_ID_SENTINEL = "discord_bot_user";

function readKubernetesToken(): string {
  try {
    return readFileSync(KUBERNETES_TOKEN_PATH, "utf-8");
  } catch (cause) {
    throw new Error(
      `Failed to read Kubernetes service account token from ${KUBERNETES_TOKEN_PATH}. ` +
        `Ensure the pod is running in Kubernetes with a mounted service account.`,
      { cause },
    );
  }
}

// Cached JWKS instance to avoid reading K8s token on every verification
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJWKS(expectedAudience: string) {
  const cached = jwksCache.get(expectedAudience);
  if (cached) return cached;

  const jwks = createRemoteJWKSet(new URL(KUBERNETES_JWKS_URL), {
    [customFetch]: (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, {
        ...init,
        headers: {
          // eslint-disable-next-line @typescript-eslint/no-misused-spread
          ...init?.headers,
          Authorization: `Bearer ${readKubernetesToken()}`,
        },
      }),
  });

  jwksCache.set(expectedAudience, jwks);
  return jwks;
}

/**
 * Verify Kubernetes projected ServiceAccount token
 *
 * Validates the token signature, issuer, and audience.
 * Note: This only validates the K8s token structure. The discord_user_id
 * should be provided separately in the request body.
 */
export async function verifyKubernetesToken(
  token: string,
  expectedAudience: string,
): Promise<{ sub: string }> {
  const jwks = getJWKS(expectedAudience);

  const { payload } = await jwtVerify(token, jwks, {
    audience: expectedAudience,
  });

  // Validate that this is a ServiceAccount token
  if (!payload.sub?.startsWith("system:serviceaccount:")) {
    throw new Error("Invalid token: not a ServiceAccount token");
  }

  return {
    sub: payload.sub,
  };
}

export interface KubernetesOAuthOptions {
  /**
   * Expected audience for Kubernetes tokens
   */
  audience: string;
}

const createSessionBody = Schema.Struct({
  token: Schema.String,
  discord_user_id: Schema.String,
}).pipe(Schema.toStandardSchemaV1);

type KubernetesOAuthCreateSessionEndpoint = AuthEndpoint<
  "/kubernetes-oauth/create-session",
  {
    method: "POST";
    body: typeof createSessionBody;
    metadata: {
      allowedMediaTypes: string[];
    };
  },
  {
    session: Session;
    user: User;
  }
>;

type KubernetesOAuthGetImplicitPermissionsEndpoint = AuthEndpoint<
  "/kubernetes-oauth/get-implicit-permissions",
  {
    method: "GET";
    use: AuthMiddleware[];
  },
  {
    permissions: Permission[];
  }
>;

type KubernetesOAuthPlugin = BetterAuthPlugin & {
  id: "kubernetes-oauth";
  endpoints: {
    createSession: KubernetesOAuthCreateSessionEndpoint;
    getImplicitPermissions: KubernetesOAuthGetImplicitPermissionsEndpoint;
  };
};

/**
 * Find user by Discord user ID via the account table (junction table).
 * The account table links internal user IDs to external OAuth provider IDs.
 */
async function findUserByDiscordId(adapter: InternalAdapter, discordUserId: string) {
  // 1. Find account by providerId + accountId (Discord user ID)
  const account = await adapter.findAccountByProviderId(discordUserId, "kubernetes:discord");

  if (!account?.userId) {
    return undefined;
  }

  return (await adapter.findUserById(account.userId)) ?? undefined;
}

/**
 * Create placeholder user and link it to Discord via account table.
 * This creates both a user record and an account record (junction).
 */
async function createPlaceholderUserWithDiscord(adapter: InternalAdapter, discordUserId: string) {
  const user = await adapter.createUser({
    email: `discord_${discordUserId}@k8s.internal`,
    emailVerified: true,
    name: `Discord User ${discordUserId}`,
  });

  await adapter.createAccount({
    userId: user.id,
    providerId: "kubernetes:discord",
    accountId: discordUserId,
  });

  return user;
}

/**
 * Better Auth plugin for Kubernetes token-based OAuth
 *
 * This plugin adds support for client_credentials grant type using
 * Kubernetes ServiceAccount tokens as the authentication mechanism.
 */
const makeKubernetesOAuth = (options: KubernetesOAuthOptions): KubernetesOAuthPlugin => {
  return {
    id: "kubernetes-oauth",
    endpoints: {
      createSession: createAuthEndpoint(
        "/kubernetes-oauth/create-session",
        {
          method: "POST",
          body: createSessionBody,
          metadata: {
            allowedMediaTypes: ["application/x-www-form-urlencoded", "application/json"],
          },
        },
        async (ctx) => {
          try {
            // Verify the Kubernetes token
            await verifyKubernetesToken(ctx.body.token, options.audience);
          } catch {
            throw new APIError("UNAUTHORIZED", {
              code: "INVALID_TOKEN",
              message: BASE_ERROR_CODES.INVALID_TOKEN,
            });
          }

          // 1. Look up user by discordUserId via account table (junction)
          let user = await findUserByDiscordId(
            ctx.context.internalAdapter,
            ctx.body.discord_user_id,
          );

          // 2. If not found, create placeholder user + account link
          if (!user) {
            user = await createPlaceholderUserWithDiscord(
              ctx.context.internalAdapter,
              ctx.body.discord_user_id,
            );
          }

          const session = await ctx.context.internalAdapter.createSession(user.id, true);

          if (!session) {
            ctx.context.logger.error("Failed to create session");
            throw new APIError("UNAUTHORIZED", {
              code: "FAILED_TO_CREATE_SESSION",
              message: BASE_ERROR_CODES.FAILED_TO_CREATE_SESSION,
            });
          }

          await setSessionCookie(
            ctx,
            {
              session,
              user,
            },
            true,
          );

          return ctx.json({
            session,
            user,
          });
        },
      ),
      getImplicitPermissions: createAuthEndpoint(
        "/kubernetes-oauth/get-implicit-permissions",
        {
          method: "GET",
          use: [sessionMiddleware],
        },
        async (ctx) => {
          const session = ctx.context.session;
          const accounts = await ctx.context.internalAdapter.findAccounts(session.user.id);

          let permissions: Permission[] = [];
          const kubernetesAccount = accounts.find(
            (account) => account.providerId === "kubernetes:discord",
          );
          if (kubernetesAccount?.accountId === DISCORD_BOT_USER_ID_SENTINEL) {
            permissions.push(...PermissionValues);
          }

          return ctx.json({
            permissions,
          });
        },
      ),
    },
  } satisfies KubernetesOAuthPlugin;
};

export const kubernetesOAuth: typeof makeKubernetesOAuth = makeKubernetesOAuth;
