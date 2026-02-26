import { Schema } from "effect";

export const config = {
  zeroCacheServer: Schema.Config("ZERO_CACHE_SERVER", Schema.String),
  zeroCacheUserId: Schema.Config("ZERO_CACHE_USER_ID", Schema.String),
  sheetAuthIssuer: Schema.Config("SHEET_AUTH_ISSUER", Schema.String),
  trustedOrigins: Schema.Config(
    "TRUSTED_ORIGINS",
    Schema.split(",").pipe(Schema.compose(Schema.Array(Schema.Trim))),
  ),
  redisUrl: Schema.Config("REDIS_URL", Schema.Redacted(Schema.String)),
};
