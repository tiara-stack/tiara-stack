import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createSecondaryStorage } from "./storage";
import type { Driver } from "unstorage";
import { kubernetesOAuth } from "./plugins/kubernetes-oauth";
import * as schema from "./schema";

interface CreateAuthOptions {
  postgresUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  kubernetesAudience: string;
  baseUrl: string;
  trustedOrigins?: string[];
  secondaryStorageDriver: Driver;
}

// Infer the Auth type from betterAuth return type
type BetterAuthInstance = ReturnType<typeof betterAuth>;

export type Auth = BetterAuthInstance;

export interface AuthWithCleanup extends Auth {
  close: () => Promise<void>;
  closeStorage: () => Promise<void>;
}

export function authConfig({
  postgresUrl,
  discordClientId,
  discordClientSecret,
  kubernetesAudience,
  baseUrl,
  trustedOrigins,
  secondaryStorageDriver,
}: CreateAuthOptions): AuthWithCleanup {
  const pgClient = postgres(postgresUrl);
  const db = drizzle(pgClient);

  // Create secondary storage from driver
  const secondaryStorage = createSecondaryStorage(secondaryStorageDriver);

  const auth = betterAuth({
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
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
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
      },
    },
    trustedOrigins: trustedOrigins ?? [baseUrl],
  });

  return Object.assign(auth, {
    close: () => pgClient.end(),
    closeStorage: () => secondaryStorage.close(),
  });
}
