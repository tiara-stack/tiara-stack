import { Schema } from "effect";
import { Discord } from "dfx";

// Re-export the full GuildResponse from dfx for the API
export const DiscordGuild = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  home_header: Schema.optional(Schema.NullOr(Schema.String)),
  splash: Schema.optional(Schema.NullOr(Schema.String)),
  discovery_splash: Schema.optional(Schema.NullOr(Schema.String)),
  features: Schema.Array(Schema.String),
  banner: Schema.optional(Schema.NullOr(Schema.String)),
  owner_id: Schema.String,
  application_id: Schema.optional(Schema.NullOr(Schema.String)),
  region: Schema.String,
  afk_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  afk_timeout: Schema.Number,
  system_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  system_channel_flags: Schema.Number,
  widget_enabled: Schema.Boolean,
  widget_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  verification_level: Schema.Number,
  roles: Schema.Array(Schema.Struct({})),
  default_message_notifications: Schema.Number,
  mfa_level: Schema.Number,
  explicit_content_filter: Schema.Number,
  max_presences: Schema.optional(Schema.NullOr(Schema.Number)),
  max_members: Schema.Number,
  max_stage_video_channel_users: Schema.Number,
  max_video_channel_users: Schema.Number,
  vanity_url_code: Schema.optional(Schema.NullOr(Schema.String)),
  premium_tier: Schema.Number,
  premium_subscription_count: Schema.Number,
  preferred_locale: Schema.String,
  rules_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  safety_alerts_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  public_updates_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  premium_progress_bar_enabled: Schema.Boolean,
  nsfw: Schema.Boolean,
  nsfw_level: Schema.Number,
  emojis: Schema.Array(Schema.Struct({})),
  stickers: Schema.Array(Schema.Struct({})),
});

// Type alias for the full guild response
export type DiscordGuildType = typeof DiscordGuild.Type;

// Internal type from dfx for cache lookups
export type GuildResponse = Discord.GuildResponse;
