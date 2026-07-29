import { Schema } from "effect";

export const DiscordGuildChannel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Int,
  parentId: Schema.NullOr(Schema.String),
  position: Schema.Int,
});

export type DiscordGuildChannel = typeof DiscordGuildChannel.Type;

export const DiscordGuildRole = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  position: Schema.Int,
  color: Schema.Int,
  managed: Schema.Boolean,
});

export type DiscordGuildRole = typeof DiscordGuildRole.Type;
