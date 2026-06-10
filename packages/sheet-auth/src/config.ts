import { Config, Option, Schema, SchemaGetter, String } from "effect";

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

// fallow-ignore-next-line code-duplication
const split = (separator: string) =>
  Schema.String.pipe(
    Schema.decodeTo(Schema.Array(Schema.String), {
      decode: SchemaGetter.split({ separator }),
      encode: SchemaGetter.transform((arr: ReadonlyArray<string>) => arr.join(separator)),
    }),
  );

export const config = {
  discordClientId: Config.schema(Schema.String, "DISCORD_CLIENT_ID"),
  discordClientSecret: Config.schema(Schema.Redacted(Schema.String), "DISCORD_CLIENT_SECRET"),
  postgresUrl: Config.schema(Schema.String, "POSTGRES_URL"),
  kubernetesAudience: Config.schema(Schema.String, "KUBERNETES_AUDIENCE"),
  // fallow-ignore-next-line code-duplication
  baseUrl: Config.schema(Schema.String, "BASE_URL"),
  trustedOrigins: Config.schema(
    split(",").pipe(
      Schema.decodeTo(Schema.Array(Schema.Trim), {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
    "TRUSTED_ORIGINS",
  ),
  cookieDomain: Config.schema(
    Schema.Trim.pipe(
      Schema.decodeTo(Schema.Option(Schema.Trimmed), {
        decode: SchemaGetter.transform(Option.liftPredicate(String.isNonEmpty)),
        encode: SchemaGetter.transform(Option.getOrElse(() => "")),
      }),
    ),
    "COOKIE_DOMAIN",
  ),
  redisUrl: Config.schema(Schema.Redacted(Schema.String), "REDIS_URL"),
  redisBase: Config.schema(Schema.String, "REDIS_BASE"),
  oauthClientRegistrationRateLimit: Config.schema(
    positiveInt,
    "OAUTH_CLIENT_REGISTRATION_RATE_LIMIT",
  ).pipe(Config.withDefault(60)),
  oauthClientRegistrationWindowSeconds: Config.schema(
    positiveInt,
    "OAUTH_CLIENT_REGISTRATION_WINDOW_SECONDS",
  ).pipe(Config.withDefault(60)),
  oauthClientTokenRateLimit: Config.schema(positiveInt, "OAUTH_TOKEN_RATE_LIMIT").pipe(
    Config.withDefault(240),
  ),
  oauthClientTokenWindowSeconds: Config.schema(positiveInt, "OAUTH_TOKEN_WINDOW_SECONDS").pipe(
    Config.withDefault(60),
  ),
};
