import { Schema } from "effect";
import {
  ForumLayout,
  ThreadAutoArchiveDuration,
  ThreadSearchTagSetting,
  VideoQualityMode,
} from "./enums";
import { DiscordUser } from "./user";

export const ChannelPermissionOverwrite = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals([0, 1]),
  allow: Schema.String,
  deny: Schema.String,
});

export const ForumTag = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  moderated: Schema.Boolean,
  emoji_id: Schema.optional(Schema.NullOr(Schema.String)),
  emoji_name: Schema.optional(Schema.NullOr(Schema.String)),
});

export const DefaultReactionEmoji = Schema.Struct({
  emoji_id: Schema.optional(Schema.NullOr(Schema.String)),
  emoji_name: Schema.optional(Schema.NullOr(Schema.String)),
});

const DiscordChannelBase = {
  id: Schema.String,
  flags: Schema.Number,
  last_message_id: Schema.optional(Schema.NullOr(Schema.String)),
  last_pin_timestamp: Schema.optional(Schema.NullOr(Schema.String)),
};

export const DiscordDMChannel = Schema.Struct({
  ...DiscordChannelBase,
  type: Schema.Literal(1),
  recipients: Schema.Array(DiscordUser),
});

export const DiscordGroupDMChannel = Schema.Struct({
  ...DiscordChannelBase,
  type: Schema.Literal(3),
  recipients: Schema.Array(DiscordUser),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  icon: Schema.optional(Schema.NullOr(Schema.String)),
  owner_id: Schema.String,
  managed: Schema.optional(Schema.Boolean),
  application_id: Schema.optional(Schema.String),
});

export const DiscordGuildChannel = Schema.Struct({
  ...DiscordChannelBase,
  type: Schema.Literals([0, 2, 4, 5, 13, 14, 15, 16]),
  guild_id: Schema.optional(Schema.String),
  name: Schema.String,
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  position: Schema.Number,
  permission_overwrites: Schema.optional(Schema.Array(ChannelPermissionOverwrite)),
  topic: Schema.optional(Schema.NullOr(Schema.String)),
  nsfw: Schema.optional(Schema.Boolean),
  rate_limit_per_user: Schema.optional(Schema.Number),
  bitrate: Schema.optional(Schema.Number),
  user_limit: Schema.optional(Schema.Number),
  rtc_region: Schema.optional(Schema.NullOr(Schema.String)),
  video_quality_mode: Schema.optional(VideoQualityMode),
  default_auto_archive_duration: Schema.optional(ThreadAutoArchiveDuration),
  default_thread_rate_limit_per_user: Schema.optional(Schema.Number),
  available_tags: Schema.optional(Schema.Array(ForumTag)),
  default_reaction_emoji: Schema.optional(Schema.NullOr(DefaultReactionEmoji)),
  default_sort_order: Schema.optional(Schema.NullOr(Schema.Literals([0, 1]))),
  default_forum_layout: Schema.optional(Schema.NullOr(ForumLayout)),
  default_tag_setting: Schema.optional(Schema.NullOr(ThreadSearchTagSetting)),
  permissions: Schema.optional(Schema.NullOr(Schema.String)),
});

export const DiscordThread = Schema.Struct({
  ...DiscordChannelBase,
  type: Schema.Literals([10, 11, 12]),
  guild_id: Schema.String,
  name: Schema.String,
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  owner_id: Schema.String,
  member_count: Schema.optional(Schema.Number),
  message_count: Schema.optional(Schema.Number),
  total_message_sent: Schema.optional(Schema.Number),
  rate_limit_per_user: Schema.optional(Schema.Number),
  thread_metadata: Schema.Struct({
    archived: Schema.Boolean,
    auto_archive_duration: ThreadAutoArchiveDuration,
    archive_timestamp: Schema.optional(Schema.NullOr(Schema.String)),
    locked: Schema.Boolean,
    invitable: Schema.optional(Schema.Boolean),
    create_timestamp: Schema.optional(Schema.String),
  }),
});

const UnknownChannel = Schema.Struct({
  ...DiscordChannelBase,
  type: Schema.Number,
});

export const DiscordChannel = Schema.Union([
  DiscordDMChannel,
  DiscordGroupDMChannel,
  DiscordGuildChannel,
  DiscordThread,
  UnknownChannel,
]);
export type DiscordChannel = typeof DiscordChannel.Type;
