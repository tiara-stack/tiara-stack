import { Config, Schema, SchemaGetter } from "effect";

const split = (separator: string) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.split({ separator }),
      encode: SchemaGetter.transform((arr: ReadonlyArray<string>) => arr.join(separator)),
    }),
  );

const nonEmptyString = Schema.NonEmptyString;
const nonEmptySecret = Schema.Redacted(nonEmptyString);

export const config = {
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  sheetApisBaseUrl: Config.string("SHEET_APIS_BASE_URL"),
  sheetWorkflowsBaseUrl: Config.string("SHEET_WORKFLOWS_BASE_URL"),
  sheetBotBaseUrl: Config.string("SHEET_BOT_BASE_URL"),
  sheetAuthIssuer: Config.string("SHEET_AUTH_ISSUER"),
  sheetAuthOAuthClientId: Config.schema(nonEmptyString, "SHEET_AUTH_OAUTH_CLIENT_ID"),
  sheetAuthOAuthClientSecret: Config.schema(nonEmptySecret, "SHEET_AUTH_OAUTH_CLIENT_SECRET"),
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
