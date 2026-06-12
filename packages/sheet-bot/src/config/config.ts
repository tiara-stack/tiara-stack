import { Config, Schema } from "effect";

const nonEmptyString = Schema.NonEmptyString;
const nonEmptySecret = Schema.Redacted(nonEmptyString);

export const config = {
  discordToken: Config.schema(Schema.Redacted(Schema.String), "DISCORD_TOKEN"),
  podNamespace: Config.string("POD_NAMESPACE"),
  redisUrl: Config.schema(Schema.Redacted(Schema.String), "REDIS_URL"),
  sheetIngressNamespace: Config.option(Config.string("SHEET_INGRESS_NAMESPACE")),
  sheetAuthOAuthAudience: Config.string("SHEET_AUTH_OAUTH_AUDIENCE").pipe(
    Config.withDefault("sheet-bot"),
  ),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthClientId: Config.schema(nonEmptyString, "SHEET_AUTH_OAUTH_CLIENT_ID"),
  sheetAuthOAuthClientSecret: Config.schema(nonEmptySecret, "SHEET_AUTH_OAUTH_CLIENT_SECRET"),
  sheetAuthSubjectTokenKubernetesTokenPath: Config.schema(
    nonEmptyString,
    "SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_TOKEN_PATH",
  ),
};
