// fallow-ignore-file code-duplication
import { Config, Option, Schema, SchemaGetter, String } from "effect";

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
  oauthValidAudiences: Config.schema(
    split(",").pipe(
      Schema.decodeTo(Schema.Array(Schema.Trim), {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
    "OAUTH_VALID_AUDIENCES",
  ).pipe(Config.withDefault([])),
  oauthJwksUrl: Config.schema(Schema.NonEmptyString, "SHEET_AUTH_OAUTH_JWKS_URL").pipe(
    Config.withDefault("http://127.0.0.1:3000/jwks"),
  ),
  trustedOAuthClientIds: Config.schema(
    split(",").pipe(
      Schema.decodeTo(Schema.Array(Schema.Trim), {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
    "TRUSTED_OAUTH_CLIENT_IDS",
  ).pipe(Config.withDefault([])),
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
  tokenExchangeSubjectJwtSecret: Config.option(
    Config.schema(
      Schema.Redacted(Schema.NonEmptyString),
      "SHEET_AUTH_TOKEN_EXCHANGE_SUBJECT_JWT_SECRET",
    ),
  ),
  tokenExchangeSubjectJwtIssuer: Config.option(
    Config.schema(Schema.NonEmptyString, "SHEET_AUTH_TOKEN_EXCHANGE_SUBJECT_JWT_ISSUER"),
  ),
  tokenExchangeAccessTokenExpiresIn: Config.schema(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 300 })),
    "SHEET_AUTH_TOKEN_EXCHANGE_ACCESS_TOKEN_EXPIRES_IN",
  ).pipe(Config.withDefault(300)),
  subjectTokenKubernetesAudience: Config.schema(
    Schema.NonEmptyString,
    "SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_AUDIENCE",
  ).pipe(Config.withDefault("sheet-auth-subject-token")),
  subjectTokenKubernetesAllowedServiceAccounts: Config.schema(
    split(",").pipe(
      Schema.decodeTo(Schema.Array(Schema.Trim), {
        decode: SchemaGetter.passthrough(),
        encode: SchemaGetter.passthrough(),
      }),
    ),
    "SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_ALLOWED_SERVICE_ACCOUNTS",
  ).pipe(Config.withDefault([])),
  subjectTokenKubernetesReviewerTokenPath: Config.schema(
    Schema.NonEmptyString,
    "SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_REVIEWER_TOKEN_PATH",
  ).pipe(Config.withDefault("/var/run/secrets/tokens/kubernetes-jwks-token")),
  subjectTokenKubernetesCaPath: Config.schema(
    Schema.NonEmptyString,
    "SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_CA_PATH",
  ).pipe(Config.withDefault("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")),
  subjectTokenKubernetesTokenReviewUrl: Config.schema(
    Schema.NonEmptyString,
    "SHEET_AUTH_SUBJECT_TOKEN_KUBERNETES_TOKEN_REVIEW_URL",
  ).pipe(
    Config.withDefault("https://kubernetes.default.svc/apis/authentication.k8s.io/v1/tokenreviews"),
  ),
  redisUrl: Config.schema(Schema.Redacted(Schema.String), "REDIS_URL"),
  redisBase: Config.schema(Schema.String, "REDIS_BASE"),
};
