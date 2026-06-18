import { Effect, Schema } from "effect";

export const DiscordRoleColors = Schema.Struct({
  primary_color: Schema.Number,
  secondary_color: Schema.NullOr(Schema.Number),
  tertiary_color: Schema.NullOr(Schema.Number),
});

export const DiscordRoleTags = Schema.Struct({
  bot_id: Schema.optional(Schema.String),
  integration_id: Schema.optional(Schema.String),
  premium_subscriber: Schema.optional(Schema.NullOr(Schema.Undefined)),
  subscription_listing_id: Schema.optional(Schema.String),
  available_for_purchase: Schema.optional(Schema.NullOr(Schema.Undefined)),
  guild_connections: Schema.optional(Schema.NullOr(Schema.Undefined)),
});

export const DiscordRole = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  permissions: Schema.String,
  position: Schema.Number,
  color: Schema.Number,
  colors: DiscordRoleColors,
  hoist: Schema.Boolean,
  managed: Schema.Boolean,
  mentionable: Schema.Boolean,
  icon: Schema.NullOr(Schema.String),
  unicode_emoji: Schema.NullOr(Schema.String),
  tags: Schema.optional(DiscordRoleTags),
  flags: Schema.Number,
});

export type DiscordRole = typeof DiscordRole.Type;
