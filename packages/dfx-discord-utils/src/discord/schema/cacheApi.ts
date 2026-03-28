import { HttpApiSchema } from "@effect/platform";
import { Schema } from "effect";
import { DiscordChannel } from "./channel";
import { DiscordGuild } from "./guild";
import { DiscordMember } from "./member";
import { DiscordRole } from "./role";

export const ChannelCacheEntrySchema = Schema.Struct({
  parentId: Schema.String,
  resourceId: Schema.String,
  value: DiscordChannel,
});

export const RoleCacheEntrySchema = Schema.Struct({
  parentId: Schema.String,
  resourceId: Schema.String,
  value: DiscordRole,
});

export const MemberCacheEntrySchema = Schema.Struct({
  parentId: Schema.String,
  resourceId: Schema.String,
  value: DiscordMember,
});

export const ChannelCacheEntriesSchema = Schema.Array(ChannelCacheEntrySchema);
export const RoleCacheEntriesSchema = Schema.Array(RoleCacheEntrySchema);
export const MemberCacheEntriesSchema = Schema.Array(MemberCacheEntrySchema);

export const GuildValueSchema = Schema.Struct({
  value: DiscordGuild,
});

export const ChannelValueSchema = Schema.Struct({
  value: DiscordChannel,
});

export const RoleValueSchema = Schema.Struct({
  value: DiscordRole,
});

export const MemberValueSchema = Schema.Struct({
  value: DiscordMember,
});

export const ApplicationValueSchema = Schema.Struct({
  ownerId: Schema.String,
});

export const CacheSizeSchema = Schema.Struct({
  size: Schema.Number,
});

export class CacheNotFoundError extends Schema.TaggedError<CacheNotFoundError>()(
  "CacheNotFoundError",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class CacheReadonlyError extends Schema.TaggedError<CacheReadonlyError>()(
  "CacheReadonlyError",
  { message: Schema.String },
) {}
