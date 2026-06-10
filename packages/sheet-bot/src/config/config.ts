import { Config, Schema } from "effect";

export const config = {
  discordToken: Config.schema(Schema.Redacted(Schema.String), "DISCORD_TOKEN"),
  podNamespace: Config.string("POD_NAMESPACE"),
  redisUrl: Config.schema(Schema.Redacted(Schema.String), "REDIS_URL"),
  sheetIngressNamespace: Config.option(Config.string("SHEET_INGRESS_NAMESPACE")),
  sheetIngressKubernetesAudience: Config.string("SHEET_INGRESS_KUBERNETES_AUDIENCE").pipe(
    // fallow-ignore-next-line code-duplication
    Config.withDefault("sheet-bot"),
  ),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthIntrospectionClientId: Config.option(
    Config.schema(Schema.String, "SHEET_AUTH_INTROSPECTION_CLIENT_ID"),
  ),
  sheetAuthOAuthIntrospectionClientSecret: Config.option(
    Config.schema(Schema.Redacted(Schema.String), "SHEET_AUTH_INTROSPECTION_CLIENT_SECRET"),
  ),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetServiceOAuthClientId: Config.option(
    Config.schema(Schema.String, "SHEET_BOT_SERVICE_CLIENT_ID"),
  ),
  sheetServiceOAuthClientSecret: Config.option(
    Config.schema(Schema.Redacted(Schema.String), "SHEET_BOT_SERVICE_CLIENT_SECRET"),
  ),
};
