import type { BetterAuthPlugin, Session, User } from "better-auth";
import type { AuthEndpoint } from "better-auth/api";
import type { JWTPayload } from "jose";
import type { AccessTokenType, JwtTokenType, TokenExchangeGrantType } from "../../oauth";
import { subjectTokenBody, tokenExchangeBody, trustedDiscordSessionBody } from "./schemas";

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

export interface SheetOAuthSubjectResolverBaseInput {
  readonly ctx: SheetOAuthEndpointContext;
  readonly actor: SheetAuthResolvedIdentity;
  readonly request: SheetOAuthTokenExchangeRequest;
}

export interface SheetOAuthTokenExchangeSubjectResolverInput extends SheetOAuthSubjectResolverBaseInput {
  readonly subjectToken: string;
  readonly subjectTokenType: string;
}

export type SheetOAuthTokenExchangeSubjectResolver = (
  input: SheetOAuthTokenExchangeSubjectResolverInput,
) => Promise<SheetOAuthTokenExchangeSubject | undefined>;

export interface SheetOAuthJwtSubjectResolverOptions {
  readonly secret: string;
  readonly issuer: string;
  readonly audience: string;
  readonly resolveSubject: (
    input: SheetOAuthSubjectResolverBaseInput & {
      readonly payload: JWTPayload;
      readonly subject: string;
    },
  ) => Promise<SheetOAuthTokenExchangeSubject | undefined>;
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
  readonly trustedClientIds?: ReadonlySet<string> | undefined;
  readonly tokenExchange?: SheetOAuthTokenExchangeOptions | undefined;
}

export interface SheetAuthResolvedIdentity {
  readonly tokenType: "session" | "oauth_access_token";
  readonly userId: string;
  readonly accountId: string;
  readonly clientId?: string | undefined;
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
  readonly expiresAt?: string | undefined;
}

export type SheetOAuthIdentityEndpoint = AuthEndpoint<
  "/sheet-auth/identity",
  {
    method: "GET";
  },
  SheetAuthResolvedIdentity
>;

export type SheetOAuthTrustedDiscordSessionEndpoint = AuthEndpoint<
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

export interface SheetOAuthDiscordAccessTokenResponse {
  readonly accessToken: string;
}

export type SheetOAuthDiscordAccessTokenEndpoint = AuthEndpoint<
  "/sheet-auth/discord/access-token",
  {
    method: "GET";
  },
  SheetOAuthDiscordAccessTokenResponse
>;

export interface SheetOAuthSubjectTokenResponse {
  readonly subject_token: string;
  readonly subject_token_type: typeof JwtTokenType;
  readonly expires_in: number;
  readonly expires_at: number;
}

export type SheetOAuthCreateSubjectTokenEndpoint = AuthEndpoint<
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

export interface SheetOAuthTokenExchangeResponse {
  readonly access_token: string;
  readonly issued_token_type: typeof AccessTokenType;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly expires_at: number;
  readonly scope: string;
}

export type SheetOAuthTokenExchangeEndpoint = AuthEndpoint<
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

export type SheetOAuthPlugin = BetterAuthPlugin & {
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

export interface OAuth2RefreshTokens {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly accessTokenExpiresAt?: Date | undefined;
  readonly refreshTokenExpiresAt?: Date | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly idToken?: string | undefined;
}
