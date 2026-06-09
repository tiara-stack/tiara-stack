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

const toRecord = (metadata: unknown): Record<string, unknown> =>
  typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};

const pickMetadataBoolean = (
  metadata: Record<string, unknown>,
  preferredField: string,
  fallbackField?: string,
) =>
  metadata[preferredField] === true ||
  (fallbackField !== undefined && metadata[fallbackField] === true);

const pickMetadataString = (
  metadata: Record<string, unknown>,
  preferredField: string,
  fallbackField?: string,
) => {
  const preferredValue = metadata[preferredField];
  if (typeof preferredValue === "string") {
    return preferredValue;
  }
  if (fallbackField === undefined) {
    return undefined;
  }
  const fallbackValue = metadata[fallbackField];
  return typeof fallbackValue === "string" ? fallbackValue : undefined;
};

// fallow-ignore-next-line complexity
const buildClientAccessTokenClaims = (scopes: string[], metadata: unknown) => {
  const resolvedMetadata = toRecord(metadata);
  return {
    trusted_client: pickMetadataBoolean(
      resolvedMetadata,
      "trusted_service_client",
      "trustedServiceClient",
    ),
    allowed_services: toStringArray(
      resolvedMetadata["allowed_services"] ??
        resolvedMetadata.allowedServices ??
        resolvedMetadata.services,
    ),
    allowed_scopes: toStringArray(
      resolvedMetadata["allowed_scopes"] ??
        resolvedMetadata.allowedScopes ??
        resolvedMetadata.scopes ??
        scopes,
    ),
    owner_user_id: pickMetadataString(resolvedMetadata, "owner_user_id", "ownerUserId"),
    client_type: pickMetadataString(resolvedMetadata, "type"),
    status: pickMetadataString(resolvedMetadata, "status"),
  };
};

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
        customAccessTokenClaims: ({ scopes, metadata }) =>
          buildClientAccessTokenClaims(scopes, metadata),
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
