const TargetPublicOAuthScopes = [
  "zero.read",
  "zero.mutate",
  "workflow.observe",
  "workflow.enqueue",
] as const;

export const PublicOAuthScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "sheet.read",
  "sheet.write",
  "sheet.manage",
  "workflow.dispatch",
  ...TargetPublicOAuthScopes,
] as const;

export const InternalOAuthScopes = [
  "service",
  "bot.impersonate",
  "token.exchange",
  "bot.cache.read",
  "bot.delivery.write",
  "rollout.gate.write",
  "rollout.gate.evaluate",
] as const;

export const OAuthScopes = [...PublicOAuthScopes, ...InternalOAuthScopes] as const;

export const DefaultRegisteredClientScopes = ["openid", "profile", "email"] as const;

export const UserTokenDefaultScopes = [
  "sheet.read",
  "sheet.write",
  "sheet.manage",
  "workflow.dispatch",
  ...TargetPublicOAuthScopes,
] as const;

export type SheetAuthOAuthScope = (typeof OAuthScopes)[number];

export const DISCORD_SERVICE_USER_ID_SENTINEL = "service_user";

export const TokenExchangeGrantType = "urn:ietf:params:oauth:grant-type:token-exchange";
export const AccessTokenType = "urn:ietf:params:oauth:token-type:access_token";
export const JwtTokenType = "urn:ietf:params:oauth:token-type:jwt";
export const SessionTokenType = "urn:tiara:sheet-auth:token-type:session";
