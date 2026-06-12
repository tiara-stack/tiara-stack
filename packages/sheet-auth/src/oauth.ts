export const PublicOAuthScopes = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "sheet.read",
  "sheet.write",
  "sheet.manage",
  "workflow.dispatch",
] as const;

export const InternalOAuthScopes = [
  "service",
  "ingress.forward",
  "bot.impersonate",
  "token.exchange",
] as const;

export const OAuthScopes = [...PublicOAuthScopes, ...InternalOAuthScopes] as const;

export const DefaultRegisteredClientScopes = ["openid", "profile", "email"] as const;

export const UserTokenDefaultScopes = [
  "sheet.read",
  "sheet.write",
  "sheet.manage",
  "workflow.dispatch",
] as const;

export type SheetAuthOAuthScope = (typeof OAuthScopes)[number];

export const DISCORD_SERVICE_USER_ID_SENTINEL = "service_user";
