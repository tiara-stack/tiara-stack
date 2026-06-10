import { Config, Schema } from "effect";

export const config = {
  podNamespace: Config.string("POD_NAMESPACE"),
  sheetIngressNamespace: Config.option(Config.string("SHEET_INGRESS_NAMESPACE")),
  zeroCacheServer: Config.schema(Schema.String, "ZERO_CACHE_SERVER"),
  zeroCacheUserId: Config.schema(Schema.String, "ZERO_CACHE_USER_ID"),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthIntrospectionClientId: Config.option(
    Config.schema(Schema.String, "SHEET_AUTH_INTROSPECTION_CLIENT_ID"),
  ),
  sheetAuthOAuthIntrospectionClientSecret: Config.option(
    Config.schema(Schema.Redacted(Schema.String), "SHEET_AUTH_INTROSPECTION_CLIENT_SECRET"),
  ),
  sheetIngressKubernetesAudience: Config.string("SHEET_INGRESS_KUBERNETES_AUDIENCE").pipe(
    Config.withDefault("sheet-apis"),
  ),
  redisUrl: Config.schema(Schema.Redacted(Schema.String), "REDIS_URL"),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetServiceOAuthClientId: Config.option(
    Config.schema(Schema.String, "SHEET_APIS_SERVICE_CLIENT_ID"),
  ),
  sheetServiceOAuthClientSecret: Config.option(
    Config.schema(Schema.Redacted(Schema.String), "SHEET_APIS_SERVICE_CLIENT_SECRET"),
  ),
};
