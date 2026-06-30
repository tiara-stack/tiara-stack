import { Config, Schema } from "effect";

const nonEmptyString = Schema.NonEmptyString;
const nonEmptySecret = Schema.Redacted(nonEmptyString);

export const config = {
  podNamespace: Config.string("POD_NAMESPACE"),
  sheetIngressNamespace: Config.option(Config.string("SHEET_INGRESS_NAMESPACE")),
  zeroCacheServer: Config.schema(Schema.String, "ZERO_CACHE_SERVER"),
  zeroCacheUserId: Config.schema(Schema.String, "ZERO_CACHE_USER_ID"),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthClientId: Config.schema(nonEmptyString, "SHEET_AUTH_OAUTH_CLIENT_ID"),
  sheetAuthOAuthClientSecret: Config.schema(nonEmptySecret, "SHEET_AUTH_OAUTH_CLIENT_SECRET"),
  sheetAuthOAuthAudience: Config.string("SHEET_AUTH_OAUTH_AUDIENCE").pipe(
    Config.withDefault("sheet-apis"),
  ),
  sheetAuthTrustedDelegationClientIds: Config.string(
    "SHEET_AUTH_TRUSTED_DELEGATION_CLIENT_IDS",
  ).pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ),
  redisUrl: Config.schema(Schema.Redacted(Schema.String), "REDIS_URL"),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
};
