import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { Schema } from "effect";
import { Unauthorized } from "typhoon-core/error";
import {
  ApplicationValueSchema,
  GuildValueSchema,
  ChannelValueSchema,
  RoleValueSchema,
  MemberValueSchema,
  ChannelCacheEntriesSchema,
  RoleCacheEntriesSchema,
  MemberCacheEntriesSchema,
  CacheSizeSchema,
  CacheNotFoundError,
  AddGuildMemberRolePayloadSchema,
  CreatePinPayloadSchema,
  CreateInteractionResponsePayloadSchema,
  DiscordBotRestErrors,
  DiscordInteractionCallbackResponseSchema,
  DiscordMessageSchema,
  EmptyBotResponseSchema,
  SendMessagePayloadSchema,
  UpdateMessagePayloadSchema,
  UpdateOriginalInteractionResponsePayloadSchema,
} from "./schema";

// Path parameters
export const ParentIdParam = Schema.String;
export const ResourceIdParam = Schema.String;

// Route ordering note: @effect/platform's HTTP router prioritizes static segments over
// parameterised ones (e.g., `/cache/guilds/size` matches before `/cache/guilds/:resourceId`).
// This ensures `/resource/*` and `/size` endpoints remain reachable despite appearing after
// dynamic routes in the registration order.

export class ApplicationApi extends HttpApiGroup.make("application")
  .add(
    HttpApiEndpoint.get("getApplication", "/application", {
      success: ApplicationValueSchema,
      error: Unauthorized,
    }),
  )
  .annotate(OpenApi.Title, "Application")
  .annotate(OpenApi.Description, "Discord application metadata API") {}

// Cache API Group
export class CacheApi extends HttpApiGroup.make("cache")
  // Guild cache endpoints (simple cache - only resourceId needed)
  .add(
    HttpApiEndpoint.get("getGuild", "/cache/guilds/:resourceId", {
      params: Schema.Struct({ resourceId: ResourceIdParam }),
      success: GuildValueSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getGuildSize", "/cache/guilds/size", {
      success: CacheSizeSchema,
      error: Unauthorized,
    }),
  )
  // Reverse lookup cache endpoints - get specific resource
  .add(
    HttpApiEndpoint.get("getChannel", "/cache/channels/:parentId/:resourceId", {
      params: Schema.Struct({ parentId: ParentIdParam, resourceId: ResourceIdParam }),
      success: ChannelValueSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRole", "/cache/roles/:parentId/:resourceId", {
      params: Schema.Struct({ parentId: ParentIdParam, resourceId: ResourceIdParam }),
      success: RoleValueSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getMember", "/cache/members/:parentId/:resourceId", {
      params: Schema.Struct({ parentId: ParentIdParam, resourceId: ResourceIdParam }),
      success: MemberValueSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  // Reverse lookup cache endpoints - get all for parent
  .add(
    HttpApiEndpoint.get("getChannelsForParent", "/cache/channels/:parentId", {
      params: Schema.Struct({ parentId: ParentIdParam }),
      success: ChannelCacheEntriesSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRolesForParent", "/cache/roles/:parentId", {
      params: Schema.Struct({ parentId: ParentIdParam }),
      success: RoleCacheEntriesSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getMembersForParent", "/cache/members/:parentId", {
      params: Schema.Struct({ parentId: ParentIdParam }),
      success: MemberCacheEntriesSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  // Reverse lookup cache endpoints - get all for resource (cross-parent lookup)
  .add(
    HttpApiEndpoint.get("getChannelsForResource", "/cache/channels/resource/:resourceId", {
      params: Schema.Struct({ resourceId: ResourceIdParam }),
      success: ChannelCacheEntriesSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRolesForResource", "/cache/roles/resource/:resourceId", {
      params: Schema.Struct({ resourceId: ResourceIdParam }),
      success: RoleCacheEntriesSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getMembersForResource", "/cache/members/resource/:resourceId", {
      params: Schema.Struct({ resourceId: ResourceIdParam }),
      success: MemberCacheEntriesSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  // Size endpoints for reverse lookup caches
  .add(
    HttpApiEndpoint.get("getChannelsSize", "/cache/channels/size", {
      success: CacheSizeSchema,
      error: Unauthorized,
    }),
  )
  .add(
    HttpApiEndpoint.get("getRolesSize", "/cache/roles/size", {
      success: CacheSizeSchema,
      error: Unauthorized,
    }),
  )
  .add(
    HttpApiEndpoint.get("getMembersSize", "/cache/members/size", {
      success: CacheSizeSchema,
      error: Unauthorized,
    }),
  )
  .add(
    HttpApiEndpoint.get("getChannelsSizeForParent", "/cache/channels/:parentId/size", {
      params: Schema.Struct({ parentId: ParentIdParam }),
      success: CacheSizeSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRolesSizeForParent", "/cache/roles/:parentId/size", {
      params: Schema.Struct({ parentId: ParentIdParam }),
      success: CacheSizeSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getMembersSizeForParent", "/cache/members/:parentId/size", {
      params: Schema.Struct({ parentId: ParentIdParam }),
      success: CacheSizeSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getChannelsSizeForResource", "/cache/channels/resource/:resourceId/size", {
      params: Schema.Struct({ resourceId: ResourceIdParam }),
      success: CacheSizeSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getRolesSizeForResource", "/cache/roles/resource/:resourceId/size", {
      params: Schema.Struct({ resourceId: ResourceIdParam }),
      success: CacheSizeSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.get("getMembersSizeForResource", "/cache/members/resource/:resourceId/size", {
      params: Schema.Struct({ resourceId: ResourceIdParam }),
      success: CacheSizeSchema,
      error: [CacheNotFoundError, Unauthorized],
    }),
  )
  .annotate(OpenApi.Title, "Cache")
  .annotate(OpenApi.Description, "Discord cache lookup API") {}

export class BotApi extends HttpApiGroup.make("bot")
  .add(
    HttpApiEndpoint.post("createInteractionResponse", "/bot/interactions/responses", {
      payload: CreateInteractionResponsePayloadSchema,
      success: DiscordInteractionCallbackResponseSchema,
      error: [...DiscordBotRestErrors, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.post("sendMessage", "/bot/channels/:channelId/messages", {
      params: Schema.Struct({ channelId: ResourceIdParam }),
      payload: SendMessagePayloadSchema.fields.payload,
      success: DiscordMessageSchema,
      error: [...DiscordBotRestErrors, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateMessage", "/bot/channels/:channelId/messages/:messageId", {
      params: UpdateMessagePayloadSchema.fields.params,
      payload: UpdateMessagePayloadSchema.fields.payload,
      success: DiscordMessageSchema,
      error: [...DiscordBotRestErrors, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.patch(
      "updateOriginalInteractionResponse",
      "/bot/interactions/:interactionToken/original-response",
      {
        params: UpdateOriginalInteractionResponsePayloadSchema.fields.params,
        payload: UpdateOriginalInteractionResponsePayloadSchema.fields.payload,
        success: DiscordMessageSchema,
        error: [...DiscordBotRestErrors, Unauthorized],
      },
    ),
  )
  .add(
    HttpApiEndpoint.put("createPin", "/bot/channels/:channelId/pins/:messageId", {
      params: CreatePinPayloadSchema.fields.params,
      success: EmptyBotResponseSchema,
      error: [...DiscordBotRestErrors, Unauthorized],
    }),
  )
  .add(
    HttpApiEndpoint.put(
      "addGuildMemberRole",
      "/bot/guilds/:guildId/members/:userId/roles/:roleId",
      {
        params: AddGuildMemberRolePayloadSchema.fields.params,
        success: EmptyBotResponseSchema,
        error: [...DiscordBotRestErrors, Unauthorized],
      },
    ),
  )
  .annotate(OpenApi.Title, "Bot")
  .annotate(OpenApi.Description, "Discord bot interaction and message API") {}

export class DiscordApi extends HttpApi.make("discord")
  .add(ApplicationApi)
  .add(CacheApi)
  .add(BotApi)
  .annotate(OpenApi.Title, "Discord API")
  .annotate(
    OpenApi.Description,
    "HTTP API for Discord application metadata, cache lookups, and bot actions",
  ) {}
