import { DiscordREST } from "dfx";
import type * as Discord from "dfx/types";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { Effect, Predicate, Schema } from "effect";
import { GuildsCache, ChannelsCache, RolesCache, MembersCache } from "./cache";
import { DiscordApplication } from "./gateway";
import {
  ApplicationValueSchema,
  AddGuildMemberRolePayloadSchema,
  CacheNotFoundError,
  CacheSizeSchema,
  ChannelCacheEntriesSchema,
  ChannelValueSchema,
  CreatePinPayloadSchema,
  CreateInteractionResponsePayloadSchema,
  DiscordBotRestErrorSchema,
  DiscordInteractionCallbackResponseSchema,
  DiscordMessageSchema,
  EmptyBotResponseSchema,
  GuildValueSchema,
  makeDiscordBotRestError,
  MemberCacheEntriesSchema,
  MemberValueSchema,
  RoleCacheEntriesSchema,
  RoleValueSchema,
  SendMessagePayloadSchema,
  UpdateMessagePayloadSchema,
  UpdateOriginalInteractionResponsePayloadSchema,
} from "./schema";
import type { DiscordBotRestError } from "./schema";

const ResourceParams = Schema.Struct({
  params: Schema.Struct({ resourceId: Schema.String }),
});

const ParentParams = Schema.Struct({
  params: Schema.Struct({ parentId: Schema.String }),
});

const ParentResourceParams = Schema.Struct({
  params: Schema.Struct({
    parentId: Schema.String,
    resourceId: Schema.String,
  }),
});

export class DiscordRpcs extends RpcGroup.make(
  Rpc.make("application.getApplication", {
    success: ApplicationValueSchema,
  }),
  Rpc.make("bot.createInteractionResponse", {
    payload: CreateInteractionResponsePayloadSchema,
    success: DiscordInteractionCallbackResponseSchema,
    error: DiscordBotRestErrorSchema,
  }),
  Rpc.make("bot.sendMessage", {
    payload: SendMessagePayloadSchema,
    success: DiscordMessageSchema,
    error: DiscordBotRestErrorSchema,
  }),
  Rpc.make("bot.updateMessage", {
    payload: UpdateMessagePayloadSchema,
    success: DiscordMessageSchema,
    error: DiscordBotRestErrorSchema,
  }),
  Rpc.make("bot.updateOriginalInteractionResponse", {
    payload: UpdateOriginalInteractionResponsePayloadSchema,
    success: DiscordMessageSchema,
    error: DiscordBotRestErrorSchema,
  }),
  Rpc.make("bot.createPin", {
    payload: CreatePinPayloadSchema,
    success: EmptyBotResponseSchema,
    error: DiscordBotRestErrorSchema,
  }),
  Rpc.make("bot.addGuildMemberRole", {
    payload: AddGuildMemberRolePayloadSchema,
    success: EmptyBotResponseSchema,
    error: DiscordBotRestErrorSchema,
  }),
  Rpc.make("cache.getGuild", {
    payload: ResourceParams,
    success: GuildValueSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getGuildSize", {
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getChannel", {
    payload: ParentResourceParams,
    success: ChannelValueSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getRole", {
    payload: ParentResourceParams,
    success: RoleValueSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getMember", {
    payload: ParentResourceParams,
    success: MemberValueSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getChannelsForParent", {
    payload: ParentParams,
    success: ChannelCacheEntriesSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getRolesForParent", {
    payload: ParentParams,
    success: RoleCacheEntriesSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getMembersForParent", {
    payload: ParentParams,
    success: MemberCacheEntriesSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getChannelsForResource", {
    payload: ResourceParams,
    success: ChannelCacheEntriesSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getRolesForResource", {
    payload: ResourceParams,
    success: RoleCacheEntriesSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getMembersForResource", {
    payload: ResourceParams,
    success: MemberCacheEntriesSchema,
    error: CacheNotFoundError,
  }),
  Rpc.make("cache.getChannelsSize", {
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getRolesSize", {
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getMembersSize", {
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getChannelsSizeForParent", {
    payload: ParentParams,
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getRolesSizeForParent", {
    payload: ParentParams,
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getMembersSizeForParent", {
    payload: ParentParams,
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getChannelsSizeForResource", {
    payload: ResourceParams,
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getRolesSizeForResource", {
    payload: ResourceParams,
    success: CacheSizeSchema,
  }),
  Rpc.make("cache.getMembersSizeForResource", {
    payload: ResourceParams,
    success: CacheSizeSchema,
  }),
) {}

const mapToEntries = <A>(map: ReadonlyMap<string, A>, parentId: string) =>
  Array.from(map.entries()).map(([resourceId, value]) => ({
    parentId,
    resourceId,
    value,
  }));

const resourceMapToEntries = <A>(map: ReadonlyMap<string, A>, resourceId: string) =>
  Array.from(map.entries()).map(([parentId, value]) => ({
    parentId,
    resourceId,
    value,
  }));

const isCacheMissError = Predicate.isTagged("CacheMissError");

const handleCacheError = <A>(
  effect: Effect.Effect<A, unknown, never>,
  notFoundMessage: string,
): Effect.Effect<A, CacheNotFoundError, never> =>
  effect.pipe(
    Effect.catch((err) => {
      if (isCacheMissError(err)) {
        return Effect.fail(new CacheNotFoundError({ message: notFoundMessage }));
      }
      return Effect.die(err);
    }),
  );

const handleSizeError = (
  effect: Effect.Effect<{ readonly size: number }, unknown, never>,
  errorMessage: string,
): Effect.Effect<{ readonly size: number }, never, never> =>
  effect.pipe(
    Effect.tapError((err) => Effect.logError(`${errorMessage}: ${String(err)}`)),
    Effect.orDie,
  );

const statusFromError = (error: unknown): number | undefined => {
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    typeof error.response.status === "number"
  ) {
    return error.response.status;
  }
  return undefined;
};

const messageFromError = (message: string, error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "data" in error &&
    typeof error.data === "object" &&
    error.data !== null &&
    "message" in error.data &&
    typeof error.data.message === "string"
  ) {
    return `${message}: ${error.data.message}`;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return `${message}: ${error.message}`;
  }

  return message;
};

const handleBotRestError = <A>(
  effect: Effect.Effect<A, unknown, never>,
  message: string,
): Effect.Effect<A, DiscordBotRestError, never> =>
  effect.pipe(
    Effect.mapError((error) =>
      makeDiscordBotRestError({
        message: messageFromError(message, error),
        status: statusFromError(error),
      }),
    ),
  );

const disabledMentions = () => ({ parse: [] });

const withoutMessageMentions = <A extends object>(payload: A): A => ({
  ...payload,
  allowed_mentions: disabledMentions(),
});

const withoutInteractionMessageMentions = <
  A extends {
    readonly type: number;
    readonly data?: object | null;
  },
>(
  payload: A,
): A => {
  if (
    (payload.type === 4 || payload.type === 7) &&
    typeof payload.data === "object" &&
    payload.data !== null
  ) {
    return {
      ...payload,
      data: {
        ...payload.data,
        allowed_mentions: disabledMentions(),
      },
    };
  }

  return payload;
};

export const discordRpcHandlersLayer = DiscordRpcs.toLayer(
  Effect.gen(function* () {
    const application = yield* DiscordApplication;
    const rest = yield* DiscordREST;
    const guildsCache = yield* GuildsCache;
    const channelsCache = yield* ChannelsCache;
    const rolesCache = yield* RolesCache;
    const membersCache = yield* MembersCache;

    return DiscordRpcs.of({
      "application.getApplication": () => Effect.succeed({ ownerId: application.owner.id }),
      "bot.createInteractionResponse": ({ interactionId, interactionToken, payload }) =>
        handleBotRestError(
          rest
            .createInteractionResponse(interactionId, interactionToken, {
              params: { with_response: true },
              payload: withoutInteractionMessageMentions(
                payload,
              ) as Discord.CreateInteractionResponseRequest,
            })
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(DiscordInteractionCallbackResponseSchema)),
            ),
          `Failed to create interaction response for ${interactionId}`,
        ),
      "bot.sendMessage": ({ params: { channelId }, payload }) =>
        handleBotRestError(
          rest.createMessage(
            channelId,
            withoutMessageMentions(payload) as Discord.MessageCreateRequest,
          ),
          `Failed to send message to channel ${channelId}`,
        ),
      "bot.updateMessage": ({ params: { channelId, messageId }, payload }) =>
        handleBotRestError(
          rest.updateMessage(
            channelId,
            messageId,
            withoutMessageMentions(payload) as Discord.MessageEditRequestPartial,
          ),
          `Failed to update message ${messageId} in channel ${channelId}`,
        ),
      "bot.updateOriginalInteractionResponse": ({ params: { interactionToken }, payload }) =>
        handleBotRestError(
          rest.updateOriginalWebhookMessage(application.id, interactionToken, {
            payload: withoutMessageMentions(payload) as Discord.IncomingWebhookUpdateRequestPartial,
          }),
          "Failed to update original interaction response",
        ),
      "bot.createPin": ({ params: { channelId, messageId } }) =>
        handleBotRestError(
          rest.createPin(channelId, messageId).pipe(Effect.as({})),
          `Failed to pin message ${messageId} in channel ${channelId}`,
        ),
      "bot.addGuildMemberRole": ({ params: { guildId, userId, roleId } }) =>
        handleBotRestError(
          rest.addGuildMemberRole(guildId, userId, roleId).pipe(Effect.as({})),
          `Failed to add role ${roleId} to user ${userId} in guild ${guildId}`,
        ),
      "cache.getGuild": ({ params: { resourceId } }) =>
        handleCacheError(
          guildsCache.get(resourceId).pipe(Effect.map((value) => ({ value }))),
          `Guild ${resourceId} not found`,
        ),
      "cache.getGuildSize": () =>
        handleSizeError(
          guildsCache.size.pipe(Effect.map((size) => ({ size }))),
          "Failed to get guild size",
        ),
      "cache.getChannel": ({ params: { parentId, resourceId } }) =>
        handleCacheError(
          channelsCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
          `Channel ${resourceId} in guild ${parentId} not found`,
        ),
      "cache.getRole": ({ params: { parentId, resourceId } }) =>
        handleCacheError(
          rolesCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
          `Role ${resourceId} in guild ${parentId} not found`,
        ),
      "cache.getMember": ({ params: { parentId, resourceId } }) =>
        handleCacheError(
          membersCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
          `Member ${resourceId} in guild ${parentId} not found`,
        ),
      "cache.getChannelsForParent": ({ params: { parentId } }) =>
        handleCacheError(
          channelsCache
            .getForParent(parentId)
            .pipe(Effect.map((map) => mapToEntries(map, parentId))),
          `No channels found for guild ${parentId}`,
        ),
      "cache.getRolesForParent": ({ params: { parentId } }) =>
        handleCacheError(
          rolesCache.getForParent(parentId).pipe(Effect.map((map) => mapToEntries(map, parentId))),
          `No roles found for guild ${parentId}`,
        ),
      "cache.getMembersForParent": ({ params: { parentId } }) =>
        handleCacheError(
          membersCache
            .getForParent(parentId)
            .pipe(Effect.map((map) => mapToEntries(map, parentId))),
          `No members found for guild ${parentId}`,
        ),
      "cache.getChannelsForResource": ({ params: { resourceId } }) =>
        handleCacheError(
          channelsCache
            .getForResource(resourceId)
            .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
          `Channel ${resourceId} not found in any guild`,
        ),
      "cache.getRolesForResource": ({ params: { resourceId } }) =>
        handleCacheError(
          rolesCache
            .getForResource(resourceId)
            .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
          `Role ${resourceId} not found in any guild`,
        ),
      "cache.getMembersForResource": ({ params: { resourceId } }) =>
        handleCacheError(
          membersCache
            .getForResource(resourceId)
            .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
          `Member ${resourceId} not found in any guild`,
        ),
      "cache.getChannelsSize": () =>
        handleSizeError(
          channelsCache.size.pipe(Effect.map((size) => ({ size }))),
          "Failed to get channels size",
        ),
      "cache.getRolesSize": () =>
        handleSizeError(
          rolesCache.size.pipe(Effect.map((size) => ({ size }))),
          "Failed to get roles size",
        ),
      "cache.getMembersSize": () =>
        handleSizeError(
          membersCache.size.pipe(Effect.map((size) => ({ size }))),
          "Failed to get members size",
        ),
      "cache.getChannelsSizeForParent": ({ params: { parentId } }) =>
        handleSizeError(
          channelsCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
          `Failed to get channels size for guild ${parentId}`,
        ),
      "cache.getRolesSizeForParent": ({ params: { parentId } }) =>
        handleSizeError(
          rolesCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
          `Failed to get roles size for guild ${parentId}`,
        ),
      "cache.getMembersSizeForParent": ({ params: { parentId } }) =>
        handleSizeError(
          membersCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
          `Failed to get members size for guild ${parentId}`,
        ),
      "cache.getChannelsSizeForResource": ({ params: { resourceId } }) =>
        handleSizeError(
          channelsCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
          `Failed to get channels size for resource ${resourceId}`,
        ),
      "cache.getRolesSizeForResource": ({ params: { resourceId } }) =>
        handleSizeError(
          rolesCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
          `Failed to get roles size for resource ${resourceId}`,
        ),
      "cache.getMembersSizeForResource": ({ params: { resourceId } }) =>
        handleSizeError(
          membersCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
          `Failed to get members size for resource ${resourceId}`,
        ),
    });
  }),
);
