import { Config, Schema } from "effect";

const nonEmptyString = Schema.NonEmptyString;
const nonEmptySecret = Schema.Redacted(nonEmptyString);
const capabilityEncryptionSecret = Schema.Redacted(Schema.String.check(Schema.isMinLength(32)));

export const config = {
  sheetBotClientId: Config.schema(nonEmptyString, "SHEET_BOT_CLIENT_ID").pipe(
    Config.withDefault("discord-main"),
  ),
  discordToken: Config.schema(Schema.Redacted(Schema.String), "DISCORD_TOKEN"),
  podNamespace: Config.string("POD_NAMESPACE"),
  redisUrl: Config.schema(Schema.Redacted(Schema.String), "REDIS_URL"),
  sheetIngressNamespace: Config.option(Config.string("SHEET_INGRESS_NAMESPACE")),
  sheetAuthOAuthAudience: Config.string("SHEET_AUTH_OAUTH_AUDIENCE").pipe(
    Config.withDefault("sheet-bot"),
  ),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetWorkflowsBaseUrl: Config.schema(nonEmptyString, "SHEET_WORKFLOWS_BASE_URL").pipe(
    Config.withDefault("http://sheet-workflows:3000"),
  ),
  zeroCacheServer: Config.schema(nonEmptyString, "ZERO_CACHE_SERVER"),
  zeroCacheUserId: Config.schema(nonEmptyString, "ZERO_CACHE_USER_ID"),
  zeroOAuthAudience: Config.schema(nonEmptyString, "ZERO_OAUTH_AUDIENCE").pipe(
    Config.withDefault("sheet-db-server"),
  ),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthClientId: Config.schema(nonEmptyString, "SHEET_AUTH_OAUTH_CLIENT_ID"),
  sheetAuthOAuthClientSecret: Config.schema(nonEmptySecret, "SHEET_AUTH_OAUTH_CLIENT_SECRET"),
  sheetBotCapabilityEncryptionSecret: Config.schema(
    capabilityEncryptionSecret,
    "SHEET_BOT_CAPABILITY_ENCRYPTION_SECRET",
  ),
  sheetAuthSubjectTokenKubernetesTokenPath: Config.schema(
    nonEmptyString,
    "SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_TOKEN_PATH",
  ),
};
