import { Schema } from "effect";
import { TokenExchangeGrantType } from "../../oauth";

export const MaxSubjectTokenLifetimeSeconds = 300;

export const trustedDiscordSessionBody = Schema.Struct({
  discordUserId: Schema.String.check(Schema.isPattern(/^\d+$/)),
}).pipe(Schema.toStandardSchemaV1);

export const tokenExchangeBody = Schema.Struct({
  grant_type: Schema.Literal(TokenExchangeGrantType),
  subject_token: Schema.String,
  subject_token_type: Schema.String,
  actor_token: Schema.optional(Schema.String),
  actor_token_type: Schema.optional(Schema.String),
  requested_token_type: Schema.optional(Schema.String),
  audience: Schema.optional(Schema.String),
  resource: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
}).pipe(Schema.toStandardSchemaV1);

export const subjectTokenBody = Schema.Struct({
  subject: Schema.NonEmptyString,
  audience: Schema.optional(Schema.String),
  expiresIn: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThan(0),
      Schema.isLessThanOrEqualTo(MaxSubjectTokenLifetimeSeconds),
    ),
  ),
}).pipe(Schema.toStandardSchemaV1);
