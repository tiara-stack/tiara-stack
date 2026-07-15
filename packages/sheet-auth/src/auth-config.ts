import { betterAuth, type Auth as BetterAuth, type BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createSecondaryStorage } from "./storage";
import type { Driver } from "unstorage";
import * as schema from "./schema";
import { sessionToken } from "./plugins/session-token";
import {
  DefaultRegisteredClientScopes,
  OAuthScopes,
  PublicOAuthScopes,
  UserTokenDefaultScopes,
} from "./oauth";
import {
  createJwtSubjectTokenResolver,
  resolveUserByDiscordId,
  sheetOAuth,
  type SheetOAuthTokenExchangeSubjectResolver,
} from "./plugins/sheet-oauth";

interface CreateAuthOptions {
  postgresUrl: string;
  discordClientId: string;
  discordClientSecret: string;
  oauthValidAudiences?: readonly string[];
  oauthJwksUrl?: string;
  trustedOAuthClientIds?: readonly string[];
  baseUrl: string;
  trustedOrigins?: string[];
  cookieDomain?: string;
  tokenExchangeSubjectJwtSecret?: string;
  tokenExchangeSubjectJwtIssuer?: string;
  tokenExchangeAccessTokenExpiresIn?: number;
  subjectTokenKubernetesAudience?: string;
  subjectTokenKubernetesAllowedServiceAccounts?: readonly string[];
  subjectTokenKubernetesReviewerTokenPath?: string;
  subjectTokenKubernetesCaPath?: string;
  subjectTokenKubernetesTokenReviewUrl?: string;
  secondaryStorageDriver: Driver;
}

type AuthPlugins = [
  ReturnType<typeof bearer>,
  ReturnType<typeof sessionToken>,
  ReturnType<typeof jwt>,
  ReturnType<typeof oauthProvider>,
  ReturnType<typeof sheetOAuth>,
];

type AuthOptions = BetterAuthOptions & {
  plugins: AuthPlugins;
};

export type Auth = BetterAuth<AuthOptions>;

type BaseAuthOptions = Omit<CreateAuthOptions, "postgresUrl" | "secondaryStorageDriver"> & {
  db: ReturnType<typeof drizzle>;
  secondaryStorage: ReturnType<typeof createSecondaryStorage>;
};

type CleanupMethods = {
  close: () => Promise<void>;
  closeStorage: () => Promise<void>;
};

const InternalOAuthResourceAudiences = [
  "sheet-ingress",
  "sheet-apis",
  "sheet-workflows",
  "sheet-bot",
] as const;
const TokenExchangeAccessTokenMaxExpiresIn = 300;

const tokenExchangeAccessTokenExpiresInOrThrow = (value: number | undefined) => {
  const expiresIn = value ?? TokenExchangeAccessTokenMaxExpiresIn;
  if (
    !Number.isInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > TokenExchangeAccessTokenMaxExpiresIn
  ) {
    throw new Error(
      `tokenExchangeAccessTokenExpiresIn must be an integer between 1 and ${TokenExchangeAccessTokenMaxExpiresIn}`,
    );
  }

  return expiresIn;
};

export const oauthAudiences = (baseUrl: string, audiences: readonly string[] | undefined) =>
  audiences?.length ? [...audiences] : [baseUrl, ...InternalOAuthResourceAudiences];

const createOAuthProviderPlugin = ({
  baseUrl,
  oauthValidAudiences,
  trustedOAuthClientIds,
}: Pick<BaseAuthOptions, "baseUrl" | "oauthValidAudiences" | "trustedOAuthClientIds">) =>
  oauthProvider({
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: false,
    scopes: [...OAuthScopes],
    clientRegistrationDefaultScopes: [...DefaultRegisteredClientScopes],
    clientRegistrationAllowedScopes: [...PublicOAuthScopes],
    clientCredentialGrantDefaultScopes: [],
    grantTypes: ["authorization_code", "client_credentials", "refresh_token"],
    validAudiences: oauthAudiences(baseUrl, oauthValidAudiences),
    cachedTrustedClients: new Set(trustedOAuthClientIds ?? []),
    requirePKCE: true,
    loginPage: "/sign-in",
    consentPage: "/consent",
  });

const createTokenExchangeSubjectResolvers = ({
  baseUrl,
  tokenExchangeSubjectJwtSecret,
  tokenExchangeSubjectJwtIssuer,
}: Pick<
  BaseAuthOptions,
  "baseUrl" | "tokenExchangeSubjectJwtSecret" | "tokenExchangeSubjectJwtIssuer"
>): readonly SheetOAuthTokenExchangeSubjectResolver[] => {
  if (!tokenExchangeSubjectJwtSecret) {
    return [];
  }

  return [
    createJwtSubjectTokenResolver({
      secret: tokenExchangeSubjectJwtSecret,
      issuer: tokenExchangeSubjectJwtIssuer ?? baseUrl,
      audience: baseUrl,
      resolveSubject: async ({ ctx, subject, payload }) => {
        const discordSubjectMatch = /^discord:(\d+)$/.exec(subject);
        const discordUserId = discordSubjectMatch?.[1];
        if (!discordUserId) {
          return undefined;
        }

        const user = await resolveUserByDiscordId(ctx.context.internalAdapter, discordUserId);

        return {
          userId: user.id,
          accountId: discordUserId,
          scopes: [...UserTokenDefaultScopes],
          claims: {
            ext: {
              iss: payload.iss,
              sub: subject,
            },
          },
        };
      },
    }),
  ];
};

const createSubjectTokenKubernetesOptions = ({
  subjectTokenKubernetesAudience,
  subjectTokenKubernetesAllowedServiceAccounts,
  subjectTokenKubernetesReviewerTokenPath,
  subjectTokenKubernetesCaPath,
  subjectTokenKubernetesTokenReviewUrl,
}: Pick<
  BaseAuthOptions,
  | "subjectTokenKubernetesAudience"
  | "subjectTokenKubernetesAllowedServiceAccounts"
  | "subjectTokenKubernetesReviewerTokenPath"
  | "subjectTokenKubernetesCaPath"
  | "subjectTokenKubernetesTokenReviewUrl"
>) => {
  if (!subjectTokenKubernetesAllowedServiceAccounts?.length) {
    return undefined;
  }

  return {
    audience: subjectTokenKubernetesAudience ?? "sheet-auth-subject-token",
    allowedServiceAccounts: subjectTokenKubernetesAllowedServiceAccounts,
    reviewerTokenPath: subjectTokenKubernetesReviewerTokenPath,
    caPath: subjectTokenKubernetesCaPath,
    tokenReviewUrl: subjectTokenKubernetesTokenReviewUrl,
  };
};

const createSheetOAuthPlugin = ({
  baseUrl,
  oauthJwksUrl,
  oauthValidAudiences,
  trustedOAuthClientIds,
  tokenExchangeSubjectJwtSecret,
  tokenExchangeSubjectJwtIssuer,
  tokenExchangeAccessTokenExpiresIn,
  subjectTokenKubernetesAudience,
  subjectTokenKubernetesAllowedServiceAccounts,
  subjectTokenKubernetesReviewerTokenPath,
  subjectTokenKubernetesCaPath,
  subjectTokenKubernetesTokenReviewUrl,
}: Pick<
  BaseAuthOptions,
  | "baseUrl"
  | "oauthJwksUrl"
  | "oauthValidAudiences"
  | "trustedOAuthClientIds"
  | "tokenExchangeSubjectJwtSecret"
  | "tokenExchangeSubjectJwtIssuer"
  | "tokenExchangeAccessTokenExpiresIn"
  | "subjectTokenKubernetesAudience"
  | "subjectTokenKubernetesAllowedServiceAccounts"
  | "subjectTokenKubernetesReviewerTokenPath"
  | "subjectTokenKubernetesCaPath"
  | "subjectTokenKubernetesTokenReviewUrl"
>) => {
  const accessTokenExpiresIn = tokenExchangeAccessTokenExpiresInOrThrow(
    tokenExchangeAccessTokenExpiresIn,
  );

  return sheetOAuth({
    issuer: baseUrl,
    jwksUrl: oauthJwksUrl,
    validAudiences: oauthAudiences(baseUrl, oauthValidAudiences),
    trustedClientIds: new Set(trustedOAuthClientIds ?? []),
    tokenExchange: {
      actorScopes: ["token.exchange"],
      accessTokenExpiresIn,
      subjectResolvers: createTokenExchangeSubjectResolvers({
        baseUrl,
        tokenExchangeSubjectJwtSecret,
        tokenExchangeSubjectJwtIssuer,
      }),
      subjectTokenMinting: {
        secret: tokenExchangeSubjectJwtSecret,
        issuer: tokenExchangeSubjectJwtIssuer ?? baseUrl,
        audience: baseUrl,
        expiresIn: 60,
        allowedSubjectPrefixes: ["discord:"],
        kubernetes: createSubjectTokenKubernetesOptions({
          subjectTokenKubernetesAudience,
          subjectTokenKubernetesAllowedServiceAccounts,
          subjectTokenKubernetesReviewerTokenPath,
          subjectTokenKubernetesCaPath,
          subjectTokenKubernetesTokenReviewUrl,
        }),
      },
    },
  });
};

const authTrustedOrigins = (baseUrl: string, trustedOrigins: string[] | undefined) =>
  trustedOrigins ?? [baseUrl];

function createBaseAuth({
  db,
  discordClientId,
  discordClientSecret,
  oauthValidAudiences,
  oauthJwksUrl,
  trustedOAuthClientIds,
  baseUrl,
  trustedOrigins,
  cookieDomain,
  tokenExchangeSubjectJwtSecret,
  tokenExchangeSubjectJwtIssuer,
  tokenExchangeAccessTokenExpiresIn,
  subjectTokenKubernetesAudience,
  subjectTokenKubernetesAllowedServiceAccounts,
  subjectTokenKubernetesReviewerTokenPath,
  subjectTokenKubernetesCaPath,
  subjectTokenKubernetesTokenReviewUrl,
  secondaryStorage,
}: BaseAuthOptions): Auth {
  const options: AuthOptions = {
    baseURL: baseUrl,
    basePath: "/",
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    socialProviders: {
      discord: {
        clientId: discordClientId,
        clientSecret: discordClientSecret,
        disableDefaultScope: true,
        scope: ["identify", "email", "guilds"],
        overrideUserInfoOnSignIn: true,
      },
    },
    plugins: [
      bearer(),
      sessionToken(),
      jwt(),
      createOAuthProviderPlugin({ baseUrl, oauthValidAudiences, trustedOAuthClientIds }),
      createSheetOAuthPlugin({
        baseUrl,
        oauthJwksUrl,
        oauthValidAudiences,
        trustedOAuthClientIds,
        tokenExchangeSubjectJwtSecret,
        tokenExchangeSubjectJwtIssuer,
        tokenExchangeAccessTokenExpiresIn,
        subjectTokenKubernetesAudience,
        subjectTokenKubernetesAllowedServiceAccounts,
        subjectTokenKubernetesReviewerTokenPath,
        subjectTokenKubernetesCaPath,
        subjectTokenKubernetesTokenReviewUrl,
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
    trustedOrigins: authTrustedOrigins(baseUrl, trustedOrigins),
  };

  return betterAuth(options);
}

export type AuthWithCleanup = Auth & CleanupMethods;

export function authConfig({
  postgresUrl,
  discordClientId,
  discordClientSecret,
  oauthValidAudiences,
  oauthJwksUrl,
  trustedOAuthClientIds,
  baseUrl,
  trustedOrigins,
  cookieDomain,
  tokenExchangeSubjectJwtSecret,
  tokenExchangeSubjectJwtIssuer,
  tokenExchangeAccessTokenExpiresIn,
  subjectTokenKubernetesAudience,
  subjectTokenKubernetesAllowedServiceAccounts,
  subjectTokenKubernetesReviewerTokenPath,
  subjectTokenKubernetesCaPath,
  subjectTokenKubernetesTokenReviewUrl,
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
    oauthValidAudiences,
    oauthJwksUrl,
    trustedOAuthClientIds,
    baseUrl,
    trustedOrigins,
    cookieDomain,
    tokenExchangeSubjectJwtSecret,
    tokenExchangeSubjectJwtIssuer,
    tokenExchangeAccessTokenExpiresIn,
    subjectTokenKubernetesAudience,
    subjectTokenKubernetesAllowedServiceAccounts,
    subjectTokenKubernetesReviewerTokenPath,
    subjectTokenKubernetesCaPath,
    subjectTokenKubernetesTokenReviewUrl,
    secondaryStorage,
  });

  return Object.assign(auth, {
    close: () => pgClient.end(),
    closeStorage: () => secondaryStorage.close(),
  });
}
