import { Schema } from "effect";

export const config = {
  discordClientId: Schema.Config("DISCORD_CLIENT_ID", Schema.String),
  discordClientSecret: Schema.Config("DISCORD_CLIENT_SECRET", Schema.Redacted(Schema.String)),
  postgresUrl: Schema.Config("POSTGRES_URL", Schema.String),
  kubernetesAudience: Schema.Config("KUBERNETES_AUDIENCE", Schema.String),
  baseUrl: Schema.Config("BASE_URL", Schema.String),
  trustedOrigins: Schema.Config(
    "TRUSTED_ORIGINS",
    Schema.split(",").pipe(Schema.compose(Schema.Array(Schema.Trim))),
  ),
  redisUrl: Schema.Config("REDIS_URL", Schema.Redacted(Schema.String)),
  redisBase: Schema.Config("REDIS_BASE", Schema.String),
};
