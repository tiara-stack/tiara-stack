import { Schema } from "effect";

// Guild schema aligned with Discord Guild Object
// https://docs.discord.com/developers/resources/guild#guild-object
// All optional fields use optional(NullOr) to handle both undefined (cache miss) and null (Discord null)
export const DiscordGuild = Schema.Struct({
  // Guild ID
  id: Schema.String,
  // Guild name (2-100 characters, excluding trailing/leading whitespace)
  name: Schema.String,
  // Icon hash
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  // Icon hash, returned when in the template object
  icon_hash: Schema.optional(Schema.NullOr(Schema.String)),
  // Splash hash
  splash: Schema.optional(Schema.NullOr(Schema.String)),
  // Discovery splash hash; only present for guilds with the "DISCOVERABLE" feature
  discovery_splash: Schema.optional(Schema.NullOr(Schema.String)),
  // ID of owner
  owner_id: Schema.String,
  // Voice region ID (deprecated)
  region: Schema.optional(Schema.NullOr(Schema.String)),
  // ID of AFK channel
  afk_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  // AFK timeout in seconds
  afk_timeout: Schema.Number,
  // True if the server widget is enabled
  widget_enabled: Schema.optional(Schema.Boolean),
  // Channel ID that the widget will generate an invite to, or null if set to no invite
  widget_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  // Verification level required for the guild
  verification_level: Schema.Number,
  // Default message notifications level
  default_message_notifications: Schema.Number,
  // Explicit content filter level
  explicit_content_filter: Schema.Number,
  // Roles in the guild
  roles: Schema.Array(Schema.Struct({})),
  // Custom guild emojis
  emojis: Schema.Array(Schema.Struct({})),
  // Enabled guild features
  features: Schema.Array(Schema.String),
  // Required MFA level for the guild
  mfa_level: Schema.Number,
  // Application ID of the guild creator if it is bot-created
  application_id: Schema.optional(Schema.NullOr(Schema.String)),
  // ID of the channel where guild notices such as welcome messages and boost events are posted
  system_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  // System channel flags
  system_channel_flags: Schema.Number,
  // ID of the channel where Community guilds can display rules and/or guidelines
  rules_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  // Maximum number of presences for the guild (null is always returned, apart from the largest of guilds)
  max_presences: Schema.optional(Schema.NullOr(Schema.Number)),
  // Maximum number of members for the guild
  max_members: Schema.optional(Schema.Number),
  // Vanity URL code for the guild
  vanity_url_code: Schema.optional(Schema.NullOr(Schema.String)),
  // Description of a guild
  description: Schema.optional(Schema.NullOr(Schema.String)),
  // Banner hash
  banner: Schema.optional(Schema.NullOr(Schema.String)),
  // Premium tier (Server Boost level)
  premium_tier: Schema.Number,
  // Number of boosts this guild currently has
  premium_subscription_count: Schema.optional(Schema.Number),
  // Preferred locale of a Community guild
  preferred_locale: Schema.String,
  // ID of the channel where admins and moderators of Community guilds receive notices from Discord
  public_updates_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
  // Maximum amount of users in a video channel
  max_video_channel_users: Schema.optional(Schema.Number),
  // Maximum amount of users in a stage video channel
  max_stage_video_channel_users: Schema.optional(Schema.Number),
  // Approximate number of members in this guild
  approximate_member_count: Schema.optional(Schema.Number),
  // Approximate number of non-offline members in this guild
  approximate_presence_count: Schema.optional(Schema.Number),
  // The welcome screen of a Community guild, shown to new members
  welcome_screen: Schema.optional(Schema.NullOr(Schema.Struct({}))),
  // Guild age-restriction level
  nsfw_level: Schema.Number,
  // Custom guild stickers
  stickers: Schema.optional(Schema.Array(Schema.Struct({}))),
  // Whether the guild has the boost progress bar enabled
  premium_progress_bar_enabled: Schema.Boolean,
  // ID of the channel where admins and moderators of Community guilds receive safety alerts from Discord
  safety_alerts_channel_id: Schema.optional(Schema.NullOr(Schema.String)),
});

export type DiscordGuildType = typeof DiscordGuild.Type;
