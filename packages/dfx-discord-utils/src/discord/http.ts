import { FileSystem, Effect, Layer, Predicate, Schema } from "effect";
import { HttpApiBuilder, HttpApiGroup } from "effect/unstable/httpapi";
import { DiscordREST } from "dfx";
import type * as Discord from "dfx/types";
import { GuildsCache, ChannelsCache, RolesCache, MembersCache } from "./cache";
import { DiscordApplication } from "./gateway";
import { DiscordApi } from "./api";
import {
  CacheNotFoundError,
  DiscordInteractionCallbackResponseSchema,
  makeDiscordBotRestError,
} from "./schema";
import type { DiscordBotRestError } from "./schema";

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

export const handleBotRestError = <A>(
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

type DiscordApiGroups = (typeof DiscordApi)["groups"][keyof (typeof DiscordApi)["groups"]];
type DiscordHttpApiHandlersServices = HttpApiGroup.ToService<"discord", DiscordApiGroups>;
type DiscordHttpApiHandlersRequirements =
  | ChannelsCache
  | DiscordApplication
  | DiscordREST
  | FileSystem.FileSystem
  | GuildsCache
  | MembersCache
  | RolesCache;

export const discordHttpApiHandlersLayer: Layer.Layer<
  DiscordHttpApiHandlersServices,
  never,
  DiscordHttpApiHandlersRequirements
> = HttpApiBuilder.group(DiscordApi, "application", (handlers) =>
  Effect.gen(function* () {
    const application = yield* DiscordApplication;

    return handlers.handle("getApplication", () =>
      Effect.succeed({ ownerId: application.owner.id }),
    );
  }),
).pipe(
  Layer.merge(
    HttpApiBuilder.group(DiscordApi, "bot", (handlers) =>
      Effect.gen(function* () {
        const application = yield* DiscordApplication;
        const rest = yield* DiscordREST;
        const fs = yield* FileSystem.FileSystem;

        return handlers
          .handle("createInteractionResponse", ({ payload }) =>
            handleBotRestError(
              rest
                .createInteractionResponse(payload.interactionId, payload.interactionToken, {
                  params: { with_response: true },
                  payload: withoutInteractionMessageMentions(
                    payload.payload,
                  ) as Discord.CreateInteractionResponseRequest,
                })
                .pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(DiscordInteractionCallbackResponseSchema),
                  ),
                ),
              `Failed to create interaction response for ${payload.interactionId}`,
            ),
          )
          .handle("sendMessage", ({ params: { channelId }, payload }) =>
            handleBotRestError(
              rest.createMessage(
                channelId,
                withoutMessageMentions(payload) as Discord.MessageCreateRequest,
              ),
              `Failed to send message to channel ${channelId}`,
            ),
          )
          .handle("updateMessage", ({ params: { channelId, messageId }, payload }) =>
            handleBotRestError(
              rest.updateMessage(
                channelId,
                messageId,
                withoutMessageMentions(payload) as Discord.MessageEditRequestPartial,
              ),
              `Failed to update message ${messageId} in channel ${channelId}`,
            ),
          )
          .handle(
            "updateOriginalInteractionResponse",
            ({ params: { interactionToken }, payload }) =>
              handleBotRestError(
                rest.updateOriginalWebhookMessage(application.id, interactionToken, {
                  payload: withoutMessageMentions(
                    payload,
                  ) as Discord.IncomingWebhookUpdateRequestPartial,
                }),
                "Failed to update original interaction response",
              ),
          )
          .handle(
            "updateOriginalInteractionResponseWithFiles",
            ({ params: { interactionToken }, payload }) =>
              handleBotRestError(
                Effect.gen(function* () {
                  const files = yield* Effect.forEach(
                    payload.files,
                    (file) =>
                      fs.readFile(file.path).pipe(
                        Effect.map(
                          (content) =>
                            new File([content as BlobPart], file.name, {
                              type: file.contentType,
                            }),
                        ),
                      ),
                    { concurrency: 2 },
                  );
                  return yield* rest.withFiles(files)(
                    rest.updateOriginalWebhookMessage(application.id, interactionToken, {
                      payload: withoutMessageMentions(
                        payload.payload,
                      ) as Discord.IncomingWebhookUpdateRequestPartial,
                    }),
                  );
                }),
                "Failed to update original interaction response with files",
              ),
          )
          .handle("createPin", ({ params: { channelId, messageId } }) =>
            handleBotRestError(
              rest.createPin(channelId, messageId).pipe(Effect.as({})),
              `Failed to pin message ${messageId} in channel ${channelId}`,
            ),
          )
          .handle("deleteMessage", ({ params: { channelId, messageId } }) =>
            handleBotRestError(
              rest.deleteMessage(channelId, messageId).pipe(Effect.as({})),
              `Failed to delete message ${messageId} in channel ${channelId}`,
            ),
          )
          .handle("addGuildMemberRole", ({ params: { guildId, userId, roleId } }) =>
            handleBotRestError(
              rest.addGuildMemberRole(guildId, userId, roleId).pipe(Effect.as({})),
              `Failed to add role ${roleId} to user ${userId} in guild ${guildId}`,
            ),
          )
          .handle("removeGuildMemberRole", ({ params: { guildId, userId, roleId } }) =>
            handleBotRestError(
              rest.deleteGuildMemberRole(guildId, userId, roleId).pipe(Effect.as({})),
              `Failed to remove role ${roleId} from user ${userId} in guild ${guildId}`,
            ),
          );
      }),
    ),
  ),
  Layer.merge(
    HttpApiBuilder.group(DiscordApi, "cache", (handlers) =>
      Effect.gen(function* () {
        const guildsCache = yield* GuildsCache;
        const channelsCache = yield* ChannelsCache;
        const rolesCache = yield* RolesCache;
        const membersCache = yield* MembersCache;

        return handlers
          .handle("getGuild", ({ params: { resourceId } }) =>
            handleCacheError(
              guildsCache.get(resourceId).pipe(Effect.map((value) => ({ value }))),
              `Guild ${resourceId} not found`,
            ),
          )
          .handle("getGuildSize", () =>
            handleSizeError(
              guildsCache.size.pipe(Effect.map((size) => ({ size }))),
              "Failed to get guild size",
            ),
          )
          .handle("getChannel", ({ params: { parentId, resourceId } }) =>
            handleCacheError(
              channelsCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
              `Channel ${resourceId} in guild ${parentId} not found`,
            ),
          )
          .handle("getRole", ({ params: { parentId, resourceId } }) =>
            handleCacheError(
              rolesCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
              `Role ${resourceId} in guild ${parentId} not found`,
            ),
          )
          .handle("getMember", ({ params: { parentId, resourceId } }) =>
            handleCacheError(
              membersCache.get(parentId, resourceId).pipe(Effect.map((value) => ({ value }))),
              `Member ${resourceId} in guild ${parentId} not found`,
            ),
          )
          .handle("getChannelsForParent", ({ params: { parentId } }) =>
            handleCacheError(
              channelsCache
                .getForParent(parentId)
                .pipe(Effect.map((map) => mapToEntries(map, parentId))),
              `No channels found for guild ${parentId}`,
            ),
          )
          .handle("getRolesForParent", ({ params: { parentId } }) =>
            handleCacheError(
              rolesCache
                .getForParent(parentId)
                .pipe(Effect.map((map) => mapToEntries(map, parentId))),
              `No roles found for guild ${parentId}`,
            ),
          )
          .handle("getMembersForParent", ({ params: { parentId } }) =>
            handleCacheError(
              membersCache
                .getForParent(parentId)
                .pipe(Effect.map((map) => mapToEntries(map, parentId))),
              `No members found for guild ${parentId}`,
            ),
          )
          .handle("getChannelsForResource", ({ params: { resourceId } }) =>
            handleCacheError(
              channelsCache
                .getForResource(resourceId)
                .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
              `Channel ${resourceId} not found in any guild`,
            ),
          )
          .handle("getRolesForResource", ({ params: { resourceId } }) =>
            handleCacheError(
              rolesCache
                .getForResource(resourceId)
                .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
              `Role ${resourceId} not found in any guild`,
            ),
          )
          .handle("getMembersForResource", ({ params: { resourceId } }) =>
            handleCacheError(
              membersCache
                .getForResource(resourceId)
                .pipe(Effect.map((map) => resourceMapToEntries(map, resourceId))),
              `Member ${resourceId} not found in any guild`,
            ),
          )
          .handle("getChannelsSize", () =>
            handleSizeError(
              channelsCache.size.pipe(Effect.map((size) => ({ size }))),
              "Failed to get channels size",
            ),
          )
          .handle("getRolesSize", () =>
            handleSizeError(
              rolesCache.size.pipe(Effect.map((size) => ({ size }))),
              "Failed to get roles size",
            ),
          )
          .handle("getMembersSize", () =>
            handleSizeError(
              membersCache.size.pipe(Effect.map((size) => ({ size }))),
              "Failed to get members size",
            ),
          )
          .handle("getChannelsSizeForParent", ({ params: { parentId } }) =>
            handleSizeError(
              channelsCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
              `Failed to get channels size for guild ${parentId}`,
            ),
          )
          .handle("getRolesSizeForParent", ({ params: { parentId } }) =>
            handleSizeError(
              rolesCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
              `Failed to get roles size for guild ${parentId}`,
            ),
          )
          .handle("getMembersSizeForParent", ({ params: { parentId } }) =>
            handleSizeError(
              membersCache.sizeForParent(parentId).pipe(Effect.map((size) => ({ size }))),
              `Failed to get members size for guild ${parentId}`,
            ),
          )
          .handle("getChannelsSizeForResource", ({ params: { resourceId } }) =>
            handleSizeError(
              channelsCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
              `Failed to get channels size for resource ${resourceId}`,
            ),
          )
          .handle("getRolesSizeForResource", ({ params: { resourceId } }) =>
            handleSizeError(
              rolesCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
              `Failed to get roles size for resource ${resourceId}`,
            ),
          )
          .handle("getMembersSizeForResource", ({ params: { resourceId } }) =>
            handleSizeError(
              membersCache.sizeForResource(resourceId).pipe(Effect.map((size) => ({ size }))),
              `Failed to get members size for resource ${resourceId}`,
            ),
          );
      }),
    ),
  ),
);
