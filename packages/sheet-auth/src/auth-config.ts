import { betterAuth, type Auth as BetterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createSecondaryStorage } from "./storage";
import type { Driver } from "unstorage";
import { kubernetesOAuth } from "./plugins/kubernetes-oauth";
import * as schema from "./schema";
import { sessionToken } from "./plugins/session-token";

interface CreateAuthOptions {
  postgresUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  kubernetesAudience: string;
  baseUrl: string;
  trustedOrigins?: string[];
  cookieDomain?: string;
  secondaryStorageDriver: Driver;
  oauthClientRegistrationRateLimit: number;
  oauthClientRegistrationWindowSeconds: number;
  oauthClientTokenRateLimit: number;
  oauthClientTokenWindowSeconds: number;
}

type AuthPlugins = [
  ReturnType<typeof bearer>,
  ReturnType<typeof sessionToken>,
  ReturnType<typeof jwt>,
  ReturnType<typeof oauthProvider>,
  ReturnType<typeof kubernetesOAuth>,
];

type AuthOptions = BetterAuthOptions & {
  plugins: AuthPlugins;
};

export type Auth = BetterAuth<AuthOptions>;

type BaseAuthOptions = Omit<CreateAuthOptions, "postgresUrl" | "secondaryStorageDriver"> & {
  db: ReturnType<typeof drizzle>;
  secondaryStorage: ReturnType<typeof createSecondaryStorage>;
};

const toStringArray = (values: unknown) =>
  Array.isArray(values)
    ? values.filter((entry): entry is string => typeof entry === "string")
    : typeof values === "string"
      ? values
          .trim()
          .split(/[,\s]+/)
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];

type CleanupMethods = {
  close: () => Promise<void>;
  closeStorage: () => Promise<void>;
};

function createBaseAuth({
  db,
  discordClientId,
  discordClientSecret,
  kubernetesAudience,
  baseUrl,
  trustedOrigins,
  cookieDomain,
  oauthClientRegistrationRateLimit,
  oauthClientRegistrationWindowSeconds,
  oauthClientTokenRateLimit,
  oauthClientTokenWindowSeconds,
  secondaryStorage,
}: BaseAuthOptions): Auth {
  const options: AuthOptions = {
    baseURL: baseUrl,
    basePath: "/",
    database: drizzleAdapter(db, { provider: "pg", schema }),
    socialProviders: {
      discord: {
        clientId: discordClientId,
        clientSecret: discordClientSecret,
        scope: ["identify", "guilds"],
      },
    },
    plugins: [
      bearer(),
      sessionToken(),
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        rateLimit: {
          register: {
            window: oauthClientRegistrationWindowSeconds,
            max: oauthClientRegistrationRateLimit,
          },
          token: {
            window: oauthClientTokenWindowSeconds,
            max: oauthClientTokenRateLimit,
          },
        },
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "sheet-apis",
          "sheet-workflows",
          "service",
        ],
        allowDynamicClientRegistration: true,
        clientRegistrationAllowedScopes: ["sheet-apis", "sheet-workflows", "service"],
        clientRegistrationDefaultScopes: ["service"],
        storeClientSecret: "hashed",
        clientPrivileges: () => true,
        customAccessTokenClaims: ({ scopes, metadata }) => {
          const resolvedMetadata =
            metadata && typeof metadata === "object" && "trusted_service_client" in metadata
              ? (metadata as Record<string, unknown>)
              : {};

          const trustedClient =
            resolvedMetadata["trusted_service_client"] === true ||
            resolvedMetadata.trustedServiceClient === true;
          const ownerUserId =
            typeof resolvedMetadata.owner_user_id === "string"
              ? resolvedMetadata.owner_user_id
              : typeof resolvedMetadata.ownerUserId === "string"
                ? resolvedMetadata.ownerUserId
                : undefined;
          const clientType =
            typeof resolvedMetadata.type === "string" ? resolvedMetadata.type : undefined;
          const clientStatus =
            typeof resolvedMetadata.status === "string" ? resolvedMetadata.status : undefined;
          const allowedServices = toStringArray(
            "allowed_services" in resolvedMetadata
              ? resolvedMetadata.allowed_services
              : resolvedMetadata.allowedServices,
          );
          const allowedScopes = toStringArray(
            "allowed_scopes" in resolvedMetadata
              ? resolvedMetadata.allowed_scopes
              : (resolvedMetadata.allowedScopes ?? scopes),
          );

          return {
            trusted_client: trustedClient,
            allowed_services: allowedServices,
            allowed_scopes: allowedScopes,
            owner_user_id: ownerUserId,
            client_type: clientType,
            status: clientStatus,
          };
        },
      }),
      kubernetesOAuth({
        audience: kubernetesAudience,
      }),
    ],
    secondaryStorage,
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      // Required for @better-auth/oauth-provider when using secondaryStorage
      // The oauth-provider needs to query sessions by ID from the database
      storeSessionInDatabase: true,
    },
    advanced: {
      cookiePrefix: "sheet_auth",
      crossSubDomainCookies: {
        enabled: true,
        domain: cookieDomain,
      },
    },
    trustedOrigins: trustedOrigins ?? [baseUrl],
  };

  return betterAuth(options);
}

export type AuthWithCleanup = Auth & CleanupMethods;

export function authConfig({
  postgresUrl,
  discordClientId,
  discordClientSecret,
  kubernetesAudience,
  baseUrl,
  trustedOrigins,
  cookieDomain,
  oauthClientRegistrationRateLimit,
  oauthClientRegistrationWindowSeconds,
  oauthClientTokenRateLimit,
  oauthClientTokenWindowSeconds,
  secondaryStorageDriver,
}: CreateAuthOptions): AuthWithCleanup {
  const pgClient = postgres(postgresUrl);
  const db = drizzle(pgClient);

  // Create secondary storage from driver
  const secondaryStorage = createSecondaryStorage(secondaryStorageDriver);

  const auth = createBaseAuth({
    db,
    discordClientId,
    discordClientSecret,
    kubernetesAudience,
    baseUrl,
    trustedOrigins,
    cookieDomain,
    oauthClientRegistrationRateLimit,
    oauthClientRegistrationWindowSeconds,
    oauthClientTokenRateLimit,
    oauthClientTokenWindowSeconds,
    secondaryStorage,
  });

  return Object.assign(auth, {
    close: () => pgClient.end(),
    closeStorage: () => secondaryStorage.close(),
  });
}
