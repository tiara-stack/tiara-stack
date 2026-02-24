import { Schema } from "effect";

export const DiscordGuild = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.Boolean,
  permissions: Schema.String,
  features: Schema.Array(Schema.String),
});
