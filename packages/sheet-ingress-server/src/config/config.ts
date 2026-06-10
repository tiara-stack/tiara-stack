import { Config, ConfigProvider, Effect, Option, Schema, SchemaGetter } from "effect";

// fallow-ignore-next-line code-duplication
const split = (separator: string) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.split({ separator }),
      encode: SchemaGetter.transform((arr: ReadonlyArray<string>) => arr.join(separator)),
    }),
  );

const sheetAuthOAuthIntrospectionClientIdConfig = Config.option(
  Config.schema(Schema.String, "SHEET_AUTH_INTROSPECTION_CLIENT_ID"),
);

const readOAuthClientCredentials = (idEnv: string, secretEnv: string) => {
  const id = Config.option(Config.schema(Schema.String, idEnv));
  const secret = Config.option(Config.schema(Schema.Redacted(Schema.String), secretEnv));

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

const sheetApisOAuthClientCredentials = readOAuthClientCredentials(
  "SHEET_APIS_SERVICE_CLIENT_ID",
  "SHEET_APIS_SERVICE_CLIENT_SECRET",
);

const sheetWorkflowsOAuthClientCredentials = readOAuthClientCredentials(
  "SHEET_WORKFLOWS_SERVICE_CLIENT_ID",
  "SHEET_WORKFLOWS_SERVICE_CLIENT_SECRET",
);

const sheetBotOAuthClientCredentials = readOAuthClientCredentials(
  "SHEET_BOT_SERVICE_CLIENT_ID",
  "SHEET_BOT_SERVICE_CLIENT_SECRET",
);

const sheetAuthOAuthIntrospectionClientSecretConfig = Config.option(
  Config.schema(Schema.Redacted(Schema.String), "SHEET_AUTH_INTROSPECTION_CLIENT_SECRET"),
);

const sheetAuthOAuthIntrospectionClientCredentials = Config.all({
  id: sheetAuthOAuthIntrospectionClientIdConfig,
  secret: sheetAuthOAuthIntrospectionClientSecretConfig,
}).pipe(
  Config.mapOrFail(({ id, secret }) => {
    if (Option.isSome(id) !== Option.isSome(secret)) {
      return Effect.fail(
        new Config.ConfigError(
          new ConfigProvider.SourceError({
            message:
              "SHEET_AUTH_INTROSPECTION_CLIENT_ID and SHEET_AUTH_INTROSPECTION_CLIENT_SECRET must be both set or both omitted",
          }),
        ),
      );
    }
    return Effect.succeed({ id, secret });
  }),
);

export const config = {
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  sheetApisBaseUrl: Config.string("SHEET_APIS_BASE_URL"),
  sheetWorkflowsBaseUrl: Config.string("SHEET_WORKFLOWS_BASE_URL"),
  sheetBotBaseUrl: Config.string("SHEET_BOT_BASE_URL"),
  sheetAuthIssuer: Config.string("SHEET_AUTH_ISSUER"),
  sheetAuthOAuthIntrospectionClientId: sheetAuthOAuthIntrospectionClientCredentials.pipe(
    Config.map(({ id }) => id),
  ),
  sheetAuthOAuthIntrospectionClientSecret: sheetAuthOAuthIntrospectionClientCredentials.pipe(
    Config.map(({ secret }) => secret),
  ),
  sheetAuthOAuthIntrospectionClientCredentials,
  sheetApisOAuthClientCredentials,
  sheetWorkflowsOAuthClientCredentials,
  sheetBotOAuthClientCredentials,
  sheetApisOAuthClientId: sheetApisOAuthClientCredentials.pipe(Config.map(({ id }) => id)),
  sheetApisOAuthClientSecret: sheetApisOAuthClientCredentials.pipe(
    Config.map(({ secret }) => secret),
  ),
  sheetWorkflowsOAuthClientId: sheetWorkflowsOAuthClientCredentials.pipe(
    Config.map(({ id }) => id),
  ),
  sheetWorkflowsOAuthClientSecret: sheetWorkflowsOAuthClientCredentials.pipe(
    Config.map(({ secret }) => secret),
  ),
  sheetBotOAuthClientId: sheetBotOAuthClientCredentials.pipe(Config.map(({ id }) => id)),
  sheetBotOAuthClientSecret: sheetBotOAuthClientCredentials.pipe(
    // fallow-ignore-next-line code-duplication
    Config.map(({ secret }) => secret),
  ),
  trustedOrigins: Config.schema(
    split(",").pipe(
      Schema.decodeTo(Schema.Array(Schema.Trim), {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
    "TRUSTED_ORIGINS",
  ),
};
