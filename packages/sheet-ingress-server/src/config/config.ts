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
