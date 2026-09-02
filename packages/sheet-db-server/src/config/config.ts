import { Config, Schema } from "effect";

export const config = {
  postgresUrl: Config.schema(Schema.String, "POSTGRES_URL"),
  sheetAuthIssuer: Config.schema(Schema.String, "SHEET_AUTH_ISSUER"),
  sheetAuthOAuthAudience: Config.string("SHEET_AUTH_OAUTH_AUDIENCE").pipe(
    Config.withDefault("sheet-zero"),
  ),
};
