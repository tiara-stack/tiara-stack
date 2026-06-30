// fallow-ignore-file code-duplication
import { Config, Effect, Option, Schema, SchemaGetter } from "effect";

const split = (separator: string) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.split({ separator }),
      encode: SchemaGetter.transform((arr: ReadonlyArray<string>) => arr.join(separator)),
    }),
  );

const nonEmptyString = Schema.NonEmptyString;
const nonEmptySecret = Schema.Redacted(nonEmptyString);
const tokenExchangeClientId = Config.schema(
  nonEmptyString,
  "SHEET_AUTH_OAUTH_TOKEN_EXCHANGE_CLIENT_ID",
);
const tokenExchangeClientSecret = Config.schema(
  nonEmptySecret,
  "SHEET_AUTH_OAUTH_TOKEN_EXCHANGE_CLIENT_SECRET",
);
const SheetClientConfig = Schema.Struct({
  platform: Schema.Literals(["discord"]),
  clientId: Schema.String,
  baseUrl: Schema.String,
  serviceTokenResource: Schema.String,
});

const sheetClients = Schema.fromJsonString(Schema.Array(SheetClientConfig));
const sheetAuthOAuthTokenExchangeClientCredentials = Config.make((provider) =>
  Effect.gen(function* () {
    const clientId = yield* Config.option(tokenExchangeClientId).parse(provider);
    const clientSecret = yield* Config.option(tokenExchangeClientSecret).parse(provider);

    if (Option.isSome(clientId) && Option.isNone(clientSecret)) {
      yield* tokenExchangeClientSecret.parse(provider);
    }
    if (Option.isNone(clientId) && Option.isSome(clientSecret)) {
      yield* tokenExchangeClientId.parse(provider);
    }

    return { clientId, clientSecret };
  }),
);

export const config = {
  port: Config.port("PORT").pipe(Config.withDefault(3000)),
  sheetApisBaseUrl: Config.string("SHEET_APIS_BASE_URL"),
  sheetWorkflowsBaseUrl: Config.string("SHEET_WORKFLOWS_BASE_URL"),
  sheetBotBaseUrl: Config.string("SHEET_BOT_BASE_URL"),
  sheetClients: Config.schema(sheetClients, "SHEET_CLIENTS").pipe(
    Config.withDefault([
      {
        platform: "discord" as const,
        clientId: "discord-main",
        baseUrl: "http://sheet-bot:3000",
        serviceTokenResource: "sheet-bot",
      },
    ]),
  ),
  sheetAuthIssuer: Config.string("SHEET_AUTH_ISSUER"),
  sheetAuthOAuthClientId: Config.schema(nonEmptyString, "SHEET_AUTH_OAUTH_CLIENT_ID"),
  sheetAuthOAuthClientSecret: Config.schema(nonEmptySecret, "SHEET_AUTH_OAUTH_CLIENT_SECRET"),
  sheetAuthOAuthTokenExchangeClientId: sheetAuthOAuthTokenExchangeClientCredentials.pipe(
    Config.map(({ clientId }) => clientId),
  ),
  sheetAuthOAuthTokenExchangeClientSecret: sheetAuthOAuthTokenExchangeClientCredentials.pipe(
    Config.map(({ clientSecret }) => clientSecret),
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
