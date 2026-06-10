import { Config, ConfigProvider, Effect, Option, Schema } from "effect";

const readOAuthClientCredentials = (idEnv: string, secretEnv: string) => {
  const id = Config.option(Config.schema(Schema.NonEmptyString, idEnv));
  const secret = Config.option(Config.schema(Schema.Redacted(Schema.NonEmptyString), secretEnv));

  return Config.all({ id, secret }).pipe(
    Config.mapOrFail(({ id, secret }) => {
      if (Option.isSome(id) !== Option.isSome(secret)) {
        return Effect.fail(
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: `${idEnv} and ${secretEnv} must be both set or both omitted`,
            }),
          ),
        );
      }

      return Effect.succeed({ id, secret });
    }),
  );
};

const sheetAuthOAuthIntrospectionClientCredentials = readOAuthClientCredentials(
  "SHEET_AUTH_INTROSPECTION_CLIENT_ID",
  "SHEET_AUTH_INTROSPECTION_CLIENT_SECRET",
);
const sheetServiceOAuthClientCredentials = readOAuthClientCredentials(
  "SHEET_APIS_SERVICE_CLIENT_ID",
  "SHEET_APIS_SERVICE_CLIENT_SECRET",
);

export const config = {
  podNamespace: Config.string("POD_NAMESPACE"),
  sheetIngressNamespace: Config.option(Config.string("SHEET_INGRESS_NAMESPACE")),
  zeroCacheServer: Config.schema(Schema.String, "ZERO_CACHE_SERVER"),
  // fallow-ignore-next-line code-duplication
  zeroCacheUserId: Config.schema(Schema.String, "ZERO_CACHE_USER_ID"),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthIntrospectionClientCredentials,
  sheetAuthOAuthIntrospectionClientId: sheetAuthOAuthIntrospectionClientCredentials.pipe(
    Config.map(({ id }) => id),
  ),
  sheetAuthOAuthIntrospectionClientSecret: sheetAuthOAuthIntrospectionClientCredentials.pipe(
    Config.map(({ secret }) => secret),
  ),
  sheetIngressKubernetesAudience: Config.string("SHEET_INGRESS_KUBERNETES_AUDIENCE").pipe(
    Config.withDefault("sheet-apis"),
  ),
  redisUrl: Config.schema(Schema.Redacted(Schema.String), "REDIS_URL"),
  sheetIngressBaseUrl: Config.schema(Schema.String, "SHEET_INGRESS_BASE_URL"),
  sheetServiceOAuthClientCredentials,
  sheetServiceOAuthClientId: sheetServiceOAuthClientCredentials.pipe(Config.map(({ id }) => id)),
  sheetServiceOAuthClientSecret: sheetServiceOAuthClientCredentials.pipe(
    Config.map(({ secret }) => secret),
  ),
};
