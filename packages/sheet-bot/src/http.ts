import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
  Multipart,
} from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { DiscordREST } from "dfx";
import type * as Discord from "dfx/types";
import { DiscordApplication, DiscordLayer } from "dfx-discord-utils/discord";
import { ParentCachePageSize } from "dfx-discord-utils/cache";
import { DiscordApi } from "dfx-discord-utils/discord/api";
import {
  ChannelsCache,
  GuildsCache,
  MembersCache,
  RolesCache,
} from "dfx-discord-utils/discord/cache";
import {
  ChannelPermissionOverwrite,
  DiscordMessageRequestSchema,
  makeDiscordBotRestError,
  type DiscordBotRestError,
} from "dfx-discord-utils/discord/schema";
import { discordHttpApiHandlersLayer, handleBotRestError } from "dfx-discord-utils/discord/http";
import { Effect, Equal, FileSystem, Layer, Match, Predicate, Schema } from "effect";
import { createServer } from "http";
import { ClientDeliveryApi, DeliveryEmoji } from "sheet-ingress-api/client-delivery";
import {
  BotDependencyUnavailable,
  BotRateLimited,
  BotRequestRejected,
  BotResourceNotFound,
  SheetBotApi,
  maximumBotCollectionPageSize,
  type BotDeliveryOperation,
  type DeliveryKey,
  type DeliveryReceipt,
} from "sheet-bot-api";
import type {
  ClientRef,
  ConversationRef,
  MessageRef,
  SheetOutboundMessage,
} from "sheet-ingress-api/schemas/client";
import { makeArgumentError, makeUnknownError } from "typhoon-core/error";
import { cachesLayer, prefixedUnstorageLayer } from "./discord/cache";
import { discordConfigLayer } from "./discord/config";
import { config } from "./config";
import { toDiscordMessagePayload } from "./discord/renderSheetMessage";
import { sheetBotHttpAuthorizationLayer } from "./middlewares/discordHttpAuthorization/live";
import { BotCapabilityStore } from "./services/botCapabilityStore";
import {
  botConversationPage,
  botConversationView,
  botMemberPage,
  botMemberView,
  decodeBotCollectionCursor,
  type BotCollectionCursorContext,
} from "./services/botCachePagination";
import { getNumberField, getObjectField, getStringField } from "./services/unknownObjectFields";
import * as Data from "effect/Data";

class SheetBotHttpError extends Data.TaggedError("SheetBotHttpError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const UpdateOriginalInteractionResponseBodyPayloadSchema = Schema.Struct({
  interactionResponseToken: Schema.String,
  payload: DiscordMessageRequestSchema,
});

const UpdateOriginalInteractionResponseWithFilesBodyPayloadSchema = Schema.Struct({
  interactionResponseToken: Schema.String,
  payload: Schema.fromJsonString(DiscordMessageRequestSchema),
  files: Multipart.FilesSchema,
});

const disabledMentions = () => ({ parse: [] });

const withoutMessageMentions = <A extends object>(payload: A): A => ({
  ...payload,
  allowed_mentions: disabledMentions(),
});

const directMessagePayload = <A extends { readonly message_reference?: unknown }>(payload: A) => ({
  ...payload,
  message_reference: undefined,
  allowed_mentions: disabledMentions(),
});

class SheetBotClientDeliveryApi extends HttpApi.make("sheet-bot-client-delivery").add(
  ClientDeliveryApi,
) {}

const clientRef = (clientId: string): ClientRef => ({ platform: "discord", clientId });

const conversationToMessageRef = (
  client: ClientRef,
  conversation: ConversationRef,
  message: { readonly id: string; readonly channel_id: string },
): MessageRef => ({
  conversation: {
    workspace: {
      client,
      workspaceId: conversation.workspace.workspaceId,
    },
    conversationId: message.channel_id,
  },
  messageId: message.id,
});

const discordMessageToRef = (
  client: ClientRef,
  workspaceId: string,
  message: { readonly id: string; readonly channel_id: string },
): MessageRef => ({
  conversation: {
    workspace: {
      client,
      workspaceId,
    },
    conversationId: message.channel_id,
  },
  messageId: message.id,
});

export const discordInteractionMessageToRef = (
  client: ClientRef,
  message: { readonly id: string; readonly channel_id: string; readonly guild_id?: string },
) =>
  discordMessageToRef(
    client,
    Predicate.isString(message.guild_id) ? message.guild_id : "",
    message,
  );

const renderFiles = (message: SheetOutboundMessage) =>
  message.files?.map(
    (file) =>
      new File([file.content as BlobPart], file.name, {
        type: file.contentType,
      }),
  ) ?? [];

const messageFromError = (message: string, error: unknown): string => {
  const detail = getObjectField(error, "message");
  return Predicate.isString(detail) ? `${message}: ${detail}` : message;
};

const handleFallbackPayloadError = <A, R>(
  effect: Effect.Effect<A, unknown, R>,
  message: string,
): Effect.Effect<A, DiscordBotRestError, R> =>
  effect.pipe(
    Effect.mapError((error) =>
      makeDiscordBotRestError({
        message: messageFromError(message, error),
        status: 400,
      }),
    ),
  );

const botRestErrorStatuses = {
  DiscordBotBadRequestError: 400,
  DiscordBotUnauthorizedError: 401,
  DiscordBotForbiddenError: 403,
  DiscordBotNotFoundError: 404,
  DiscordBotUnprocessableError: 422,
  DiscordBotRateLimitedError: 429,
  DiscordBotUpstreamError: 502,
} satisfies Record<DiscordBotRestError["_tag"], number>;

const isDiscordBotRestError = (error: unknown): error is DiscordBotRestError => {
  const tag = getObjectField(error, "_tag");
  return Predicate.isString(tag) && Predicate.hasProperty(botRestErrorStatuses, tag);
};

const statusFromBotRestError = (error: DiscordBotRestError): number =>
  error._tag === "DiscordBotUpstreamError" && Predicate.isNumber(error.status)
    ? error.status
    : botRestErrorStatuses[error._tag];

const botRestErrorResponse = (error: unknown) =>
  isDiscordBotRestError(error)
    ? HttpServerResponse.json(error, { status: statusFromBotRestError(error) })
    : Effect.fail(error);

const capabilityProviderError = (resource: string, error: unknown) => {
  if (!isDiscordBotRestError(error)) {
    return new BotDependencyUnavailable({ message: `Discord ${resource} request failed` });
  }

  return Match.value(error).pipe(
    Match.tagsExhaustive({
      DiscordBotBadRequestError: () =>
        new BotRequestRejected({ message: `Discord rejected the ${resource} request` }),
      DiscordBotUnauthorizedError: () =>
        new BotDependencyUnavailable({ message: `Discord ${resource} is unavailable` }),
      DiscordBotForbiddenError: () =>
        new BotRequestRejected({ message: `Discord forbids the ${resource} request` }),
      DiscordBotNotFoundError: () =>
        new BotResourceNotFound({ resource, message: `${resource} was not found` }),
      DiscordBotUnprocessableError: () =>
        new BotRequestRejected({ message: `Discord rejected the ${resource} request` }),
      DiscordBotRateLimitedError: () =>
        new BotRateLimited({ message: `Discord rate limited the ${resource} request` }),
      DiscordBotUpstreamError: () =>
        new BotDependencyUnavailable({ message: `Discord ${resource} is unavailable` }),
    }),
  );
};

const mapCapabilityProviderError =
  (resource: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((error) => capabilityProviderError(resource, error)));

const mapCapabilityCacheError =
  (resource: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((error) => {
        const mapped = capabilityProviderError(resource, error);
        return Predicate.isTagged("BotResourceNotFound")(mapped)
          ? mapped
          : new BotDependencyUnavailable({ message: `Discord ${resource} cache is unavailable` });
      }),
    );

const decodeCachePageSize = (limit: number) =>
  Schema.decodeUnknownEffect(ParentCachePageSize)(limit).pipe(
    Effect.mapError(
      () =>
        new BotRequestRejected({
          message: `Collection page limit must be between 1 and ${maximumBotCollectionPageSize}`,
        }),
    ),
  );

const canReleaseDeliveryReservation = (error: unknown) =>
  Predicate.isTagged("BotResourceNotFound")(error) ||
  Predicate.isTagged("BotRequestRejected")(error) ||
  // A provider 429 rejects the mutation; releasing the reservation lets the same key retry safely.
  Predicate.isTagged("BotRateLimited")(error) ||
  Predicate.isTagged("BotResponseExpired")(error);

const ignoreMissingRemoval = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchIf(Predicate.isTagged("DiscordBotNotFoundError"), () => Effect.void),
    Effect.asVoid,
  );

const mapClientDeliveryAdapterError =
  (message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, ReturnType<typeof makeUnknownError>, R> =>
    effect.pipe(Effect.mapError((error) => makeUnknownError(message, error)));

type UpdateConversationHandlerRequest = {
  readonly payload: {
    readonly conversation: ConversationRef;
    readonly permissionOverwrites: ReadonlyArray<typeof ChannelPermissionOverwrite.Type>;
  };
};

type UpdateConversationRest = {
  readonly updateChannel: (
    channelId: string,
    payload: {
      readonly permission_overwrites: ReadonlyArray<typeof ChannelPermissionOverwrite.Type>;
    },
  ) => Effect.Effect<unknown, unknown>;
};

const isThisDiscordClient = (configuredClientId: string): Predicate.Predicate<ClientRef> =>
  Predicate.Struct({
    platform: Equal.equals("discord"),
    clientId: Equal.equals(configuredClientId),
  });

const requireThisPlatformAndClient = (configuredClientId: string, client: ClientRef) =>
  Effect.succeed(client).pipe(
    Effect.filterOrFail(isThisDiscordClient(configuredClientId), ({ platform, clientId }) =>
      makeArgumentError(`Unknown Discord client ${platform}:${clientId}`),
    ),
    Effect.asVoid,
  );

const requireCapabilityClient = (configuredClientId: string, client: ClientRef) =>
  Effect.succeed(client).pipe(
    Effect.filterOrFail(
      isThisDiscordClient(configuredClientId),
      ({ platform, clientId }) =>
        new BotResourceNotFound({
          resource: "client",
          message: `Unknown Discord client ${platform}:${clientId}`,
        }),
    ),
    Effect.asVoid,
  );

export const makeUpdateConversationHandler = (
  configuredClientId: string,
  rest: UpdateConversationRest,
) =>
  Effect.fn("SheetBotClientDelivery.updateConversation")(function* ({
    payload,
  }: UpdateConversationHandlerRequest) {
    const client = payload.conversation.workspace.client;
    yield* requireThisPlatformAndClient(configuredClientId, client);
    yield* handleBotRestError(
      rest.updateChannel(payload.conversation.conversationId, {
        permission_overwrites: [...payload.permissionOverwrites],
      }),
      `Failed to update conversation ${payload.conversation.conversationId}`,
    ).pipe(mapClientDeliveryAdapterError("Failed to update client conversation"));
  });

const discordHandlersLayer = discordHttpApiHandlersLayer.pipe(
  Layer.provide(DiscordApplication.restLayer),
  Layer.provide(DiscordLayer),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide([discordConfigLayer, cachesLayer]),
);

const clientDeliveryHandlersLayer = HttpApiBuilder.group(
  SheetBotClientDeliveryApi,
  "clientDelivery",
  (handlers) =>
    Effect.gen(function* () {
      const application = yield* DiscordApplication;
      const rest = yield* DiscordREST;
      const guildsCache = yield* GuildsCache;
      const channelsCache = yield* ChannelsCache;
      const membersCache = yield* MembersCache;
      const configuredClientId = yield* config.sheetBotClientId;
      const configuredClient = clientRef(configuredClientId);

      const requireThisClient = (client: ClientRef) =>
        requireThisPlatformAndClient(configuredClientId, client);

      const reactionRouteEmoji = (emoji: typeof DeliveryEmoji.Type) =>
        encodeURIComponent(emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name);

      return handlers
        .handle("sendMessage", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.conversation.workspace.client);
            const message = yield* handleBotRestError(
              rest.createMessage(
                payload.conversation.conversationId,
                toDiscordMessagePayload(payload.message),
              ),
              `Failed to send message to channel ${payload.conversation.conversationId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to send client message"));
            return conversationToMessageRef(configuredClient, payload.conversation, message);
          }),
        )
        .handle("sendDirectMessage", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.recipient.client);
            const dmChannel = yield* handleBotRestError(
              rest.createDm({
                recipient_id: payload.recipient.userId,
              } as Discord.CreatePrivateChannelRequest),
              `Failed to open direct message channel for user ${payload.recipient.userId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to open client direct message"));
            const message = yield* handleBotRestError(
              rest.createMessage(
                dmChannel.id,
                directMessagePayload(
                  toDiscordMessagePayload(payload.message),
                ) as Discord.MessageCreateRequest,
              ),
              `Failed to send direct message to user ${payload.recipient.userId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to send client direct message"));
            return discordMessageToRef(configuredClient, "", message);
          }),
        )
        .handle("listClients", () => Effect.succeed([configuredClient]))
        .handle("updateMessage", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.messageRef.conversation.workspace.client);
            const message = yield* handleBotRestError(
              rest.updateMessage(
                payload.messageRef.conversation.conversationId,
                payload.messageRef.messageId,
                toDiscordMessagePayload(payload.message),
              ),
              `Failed to update message ${payload.messageRef.messageId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to update client message"));
            return conversationToMessageRef(
              configuredClient,
              payload.messageRef.conversation,
              message,
            );
          }),
        )
        .handle("updateConversation", makeUpdateConversationHandler(configuredClientId, rest))
        .handle("updateInteraction", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.interaction.client);
            const files = renderFiles(payload.message);
            const update = rest.updateOriginalWebhookMessage(
              application.id,
              payload.interaction.token,
              {
                payload: toDiscordMessagePayload(payload.message),
              },
            );
            const message = yield* handleBotRestError(
              files.length > 0 ? rest.withFiles(files)(update) : update,
              "Failed to update original interaction response",
            ).pipe(mapClientDeliveryAdapterError("Failed to update client interaction"));
            return discordInteractionMessageToRef(configuredClient, message);
          }),
        )
        .handle("pinMessage", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.messageRef.conversation.workspace.client);
            yield* handleBotRestError(
              rest.createPin(
                payload.messageRef.conversation.conversationId,
                payload.messageRef.messageId,
              ),
              `Failed to pin message ${payload.messageRef.messageId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to pin client message"));
          }),
        )
        .handle("deleteMessage", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.messageRef.conversation.workspace.client);
            yield* handleBotRestError(
              rest.deleteMessage(
                payload.messageRef.conversation.conversationId,
                payload.messageRef.messageId,
              ),
              `Failed to delete message ${payload.messageRef.messageId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to delete client message"));
          }),
        )
        .handle("addMessageReaction", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.messageRef.conversation.workspace.client);
            yield* handleBotRestError(
              rest.addMyMessageReaction(
                payload.messageRef.conversation.conversationId,
                payload.messageRef.messageId,
                reactionRouteEmoji(payload.emoji),
              ),
              `Failed to add reaction to message ${payload.messageRef.messageId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to add client message reaction"));
          }),
        )
        .handle("removeMessageReaction", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.messageRef.conversation.workspace.client);
            yield* handleBotRestError(
              rest.deleteMyMessageReaction(
                payload.messageRef.conversation.conversationId,
                payload.messageRef.messageId,
                reactionRouteEmoji(payload.emoji),
              ),
              `Failed to remove reaction from message ${payload.messageRef.messageId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to remove client message reaction"));
          }),
        )
        .handle("getWorkspace", ({ params }) =>
          Effect.gen(function* () {
            yield* requireThisClient({ platform: params.platform, clientId: params.clientId });
            const guild = yield* guildsCache
              .get(params.workspaceId)
              .pipe(mapClientDeliveryAdapterError("Failed to get client workspace"));
            return { id: guild.id, name: guild.name };
          }),
        )
        .handle("getConversations", ({ params }) =>
          Effect.gen(function* () {
            yield* requireThisClient({ platform: params.platform, clientId: params.clientId });
            const channels = yield* channelsCache
              .getForParent(params.workspaceId)
              .pipe(mapClientDeliveryAdapterError("Failed to get client conversations"));
            return Array.from(channels.entries()).map(([id, value]) => ({
              id,
              type: value.type,
              workspaceId: getStringField(value, "guild_id"),
              name: getStringField(value, "name"),
              position: getNumberField(value, "position"),
            }));
          }),
        )
        .handle("getMembers", ({ params }) =>
          Effect.gen(function* () {
            yield* requireThisClient({ platform: params.platform, clientId: params.clientId });
            const members = yield* membersCache
              .getForParent(params.workspaceId)
              .pipe(mapClientDeliveryAdapterError("Failed to get client members"));
            return Array.from(members.entries()).map(([userId, value]) => ({
              userId,
              roleIds: [...value.roles],
            }));
          }),
        )
        .handle("addMemberRole", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.workspace.client);
            yield* handleBotRestError(
              rest.addGuildMemberRole(
                payload.workspace.workspaceId,
                payload.userId,
                payload.roleId,
              ),
              `Failed to add role ${payload.roleId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to add client member role"));
          }),
        )
        .handle("removeMemberRole", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireThisClient(payload.workspace.client);
            yield* handleBotRestError(
              rest.deleteGuildMemberRole(
                payload.workspace.workspaceId,
                payload.userId,
                payload.roleId,
              ),
              `Failed to remove role ${payload.roleId}`,
            ).pipe(mapClientDeliveryAdapterError("Failed to remove client member role"));
          }),
        );
    }),
).pipe(
  Layer.provide(DiscordApplication.restLayer),
  Layer.provide(DiscordLayer),
  Layer.provide([discordConfigLayer, cachesLayer]),
);

const permissionOverwriteType = {
  role: 0,
  member: 1,
} as const;

const botCapabilityCacheHandlersLayer = HttpApiBuilder.group(SheetBotApi, "cache", (handlers) =>
  Effect.gen(function* () {
    const application = yield* DiscordApplication;
    const guildsCache = yield* GuildsCache;
    const channelsCache = yield* ChannelsCache;
    const rolesCache = yield* RolesCache;
    const membersCache = yield* MembersCache;
    const configuredClientId = yield* config.sheetBotClientId;

    const requireClientParams = (params: {
      readonly platform: string;
      readonly clientId: string;
    }) => requireCapabilityClient(configuredClientId, params);

    const collectionContext = (
      collection: BotCollectionCursorContext["collection"],
      params: {
        readonly platform: string;
        readonly clientId: string;
        readonly workspaceId: string;
      },
    ): BotCollectionCursorContext => ({ collection, ...params });

    return handlers
      .handle("getApplication", ({ params }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const ownerId =
            getStringField(getObjectField(application, "owner"), "id") ??
            getStringField(getObjectField(application, "team"), "owner_user_id");
          if (ownerId === undefined) {
            return yield* new BotDependencyUnavailable({
              message: "Discord application owner is unavailable",
            });
          }
          return { ownerId };
        }),
      )
      .handle("getWorkspace", ({ params }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const workspace = yield* guildsCache
            .get(params.workspaceId)
            .pipe(mapCapabilityCacheError("workspace"));
          return { id: workspace.id, name: workspace.name, ownerId: workspace.owner_id };
        }),
      )
      .handle("getConversation", ({ params }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const conversation = yield* channelsCache
            .get(params.workspaceId, params.conversationId)
            .pipe(mapCapabilityCacheError("conversation"));
          return botConversationView(conversation.id, conversation);
        }),
      )
      .handle("listConversations", ({ params, query }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const context = collectionContext("conversations", params);
          const cursor = yield* decodeBotCollectionCursor(query.cursor, context);
          const limit = yield* decodeCachePageSize(query.limit);
          const conversations = yield* channelsCache
            .getPageForParent(params.workspaceId, cursor, limit)
            .pipe(mapCapabilityCacheError("conversations"));
          return botConversationPage(context, conversations);
        }),
      )
      .handle("getRole", ({ params }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const role = yield* rolesCache
            .get(params.workspaceId, params.roleId)
            .pipe(mapCapabilityCacheError("role"));
          return {
            id: role.id,
            name: role.name,
            permissions: role.permissions,
            position: role.position,
            managed: role.managed,
          };
        }),
      )
      .handle("listRoles", ({ params }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const roles = yield* rolesCache
            .getForParent(params.workspaceId)
            .pipe(mapCapabilityCacheError("roles"));
          return Array.from(roles.values()).map((role) => ({
            id: role.id,
            name: role.name,
            permissions: role.permissions,
            position: role.position,
            managed: role.managed,
          }));
        }),
      )
      .handle("getMember", ({ params }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const member = yield* membersCache
            .get(params.workspaceId, params.userId)
            .pipe(mapCapabilityCacheError("member"));
          return botMemberView(params.userId, member);
        }),
      )
      .handle("listMembers", ({ params, query }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const context = collectionContext("members", params);
          const cursor = yield* decodeBotCollectionCursor(query.cursor, context);
          const limit = yield* decodeCachePageSize(query.limit);
          const members = yield* membersCache
            .getPageForParent(params.workspaceId, cursor, limit)
            .pipe(mapCapabilityCacheError("members"));
          return botMemberPage(context, members);
        }),
      );
  }),
);

const botCapabilityDeliveryHandlersLayer = HttpApiBuilder.group(
  SheetBotApi,
  "delivery",
  (handlers) =>
    Effect.gen(function* () {
      const rest = yield* DiscordREST;
      const store = yield* BotCapabilityStore;
      const configuredClientId = yield* config.sheetBotClientId;
      const configuredClient = clientRef(configuredClientId);

      const execute = <A extends DeliveryReceipt, E, R>(
        operation: BotDeliveryOperation,
        deliveryKey: DeliveryKey,
        encodedInput: unknown,
        effect: Effect.Effect<A, E, R>,
      ) =>
        store.executeDelivery({
          operation,
          deliveryKey,
          encodedInput,
          effect,
          isDefinitiveFailure: canReleaseDeliveryReservation,
        });

      const requireClient = (client: ClientRef) =>
        requireCapabilityClient(configuredClientId, client);

      const reactionRouteEmoji = (emoji: {
        readonly id?: string | undefined;
        readonly name: string;
      }) => encodeURIComponent(emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name);

      return handlers
        .handle("respond", ({ payload }) =>
          execute(
            "respond",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              const response = yield* store.resolveResponseReference(payload.responseReference);
              if (!response.permittedOperations.includes("respond")) {
                return yield* new BotRequestRejected({
                  message: "Response Reference does not permit respond operations",
                });
              }
              yield* requireClient(response.client);
              const files = renderFiles(payload.message);
              const update = rest.updateOriginalWebhookMessage(
                response.applicationId,
                response.interactionToken,
                { payload: toDiscordMessagePayload(payload.message) },
              );
              const message = yield* handleBotRestError(
                files.length > 0 ? rest.withFiles(files)(update) : update,
                "Failed to respond to interaction",
              ).pipe(mapCapabilityProviderError("response"));
              return {
                deliveryKey: payload.deliveryKey,
                operation: "respond",
                target: {
                  _tag: "Response",
                  responseReference: payload.responseReference,
                  message: discordInteractionMessageToRef(configuredClient, message),
                },
              };
            }),
          ),
        )
        .handle("sendMessage", ({ payload }) =>
          execute(
            "sendMessage",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              yield* requireClient(payload.conversation.workspace.client);
              const message = yield* handleBotRestError(
                rest.createMessage(
                  payload.conversation.conversationId,
                  toDiscordMessagePayload(payload.message),
                ),
                `Failed to send message to conversation ${payload.conversation.conversationId}`,
              ).pipe(mapCapabilityProviderError("message delivery"));
              return {
                deliveryKey: payload.deliveryKey,
                operation: "sendMessage",
                target: {
                  _tag: "Message",
                  message: conversationToMessageRef(
                    configuredClient,
                    payload.conversation,
                    message,
                  ),
                },
              };
            }),
          ),
        )
        .handle("editMessage", ({ payload }) =>
          execute(
            "editMessage",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              yield* requireClient(payload.message.conversation.workspace.client);
              yield* handleBotRestError(
                rest.updateMessage(
                  payload.message.conversation.conversationId,
                  payload.message.messageId,
                  toDiscordMessagePayload(payload.content),
                ),
                `Failed to edit message ${payload.message.messageId}`,
              ).pipe(mapCapabilityProviderError("message edit"));
              return {
                deliveryKey: payload.deliveryKey,
                operation: "editMessage",
                target: { _tag: "Message", message: payload.message },
              };
            }),
          ),
        )
        .handle("deleteMessage", ({ payload }) =>
          execute(
            "deleteMessage",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              yield* requireClient(payload.message.conversation.workspace.client);
              yield* ignoreMissingRemoval(
                handleBotRestError(
                  rest.deleteMessage(
                    payload.message.conversation.conversationId,
                    payload.message.messageId,
                  ),
                  `Failed to delete message ${payload.message.messageId}`,
                ),
              ).pipe(mapCapabilityProviderError("message deletion"));
              return {
                deliveryKey: payload.deliveryKey,
                operation: "deleteMessage",
                target: { _tag: "Message", message: payload.message },
              };
            }),
          ),
        )
        .handle("setMessagePinned", ({ payload }) =>
          execute(
            "setMessagePinned",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              yield* requireClient(payload.message.conversation.workspace.client);
              const updatePinned = payload.present
                ? rest.createPin(
                    payload.message.conversation.conversationId,
                    payload.message.messageId,
                  )
                : rest.deletePin(
                    payload.message.conversation.conversationId,
                    payload.message.messageId,
                  );
              const handledUpdate = handleBotRestError(
                updatePinned,
                `Failed to update pinned state for message ${payload.message.messageId}`,
              );
              yield* (payload.present ? handledUpdate : ignoreMissingRemoval(handledUpdate)).pipe(
                mapCapabilityProviderError("message pin"),
              );
              return {
                deliveryKey: payload.deliveryKey,
                operation: "setMessagePinned",
                target: { _tag: "Message", message: payload.message },
              };
            }),
          ),
        )
        .handle("setMessageReaction", ({ payload }) =>
          execute(
            "setMessageReaction",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              yield* requireClient(payload.message.conversation.workspace.client);
              const emoji = reactionRouteEmoji(payload.emoji);
              const updateReaction = payload.present
                ? rest.addMyMessageReaction(
                    payload.message.conversation.conversationId,
                    payload.message.messageId,
                    emoji,
                  )
                : rest.deleteMyMessageReaction(
                    payload.message.conversation.conversationId,
                    payload.message.messageId,
                    emoji,
                  );
              const handledUpdate = handleBotRestError(
                updateReaction,
                `Failed to update reaction for message ${payload.message.messageId}`,
              );
              yield* (payload.present ? handledUpdate : ignoreMissingRemoval(handledUpdate)).pipe(
                mapCapabilityProviderError("message reaction"),
              );
              return {
                deliveryKey: payload.deliveryKey,
                operation: "setMessageReaction",
                target: { _tag: "Message", message: payload.message },
              };
            }),
          ),
        )
        .handle("setMemberRole", ({ payload }) =>
          execute(
            "setMemberRole",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              yield* requireClient(payload.workspace.client);
              const updateRole = payload.present
                ? rest.addGuildMemberRole(
                    payload.workspace.workspaceId,
                    payload.userId,
                    payload.roleId,
                  )
                : rest.deleteGuildMemberRole(
                    payload.workspace.workspaceId,
                    payload.userId,
                    payload.roleId,
                  );
              const handledUpdate = handleBotRestError(
                updateRole,
                `Failed to update member role ${payload.roleId}`,
              );
              yield* (payload.present ? handledUpdate : ignoreMissingRemoval(handledUpdate)).pipe(
                mapCapabilityProviderError("member role"),
              );
              return {
                deliveryKey: payload.deliveryKey,
                operation: "setMemberRole",
                target: {
                  _tag: "MemberRole",
                  workspace: payload.workspace,
                  userId: payload.userId,
                  roleId: payload.roleId,
                },
              };
            }),
          ),
        )
        .handle("replaceConversationPermissionOverwrites", ({ payload }) =>
          execute(
            "replaceConversationPermissionOverwrites",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              yield* requireClient(payload.conversation.workspace.client);
              yield* handleBotRestError(
                rest.updateChannel(payload.conversation.conversationId, {
                  permission_overwrites: payload.permissionOverwrites.map((overwrite) => ({
                    id: overwrite.targetId,
                    type: permissionOverwriteType[overwrite.targetKind],
                    allow: overwrite.allow,
                    deny: overwrite.deny,
                  })),
                }),
                `Failed to update conversation ${payload.conversation.conversationId}`,
              ).pipe(mapCapabilityProviderError("conversation permission overwrites"));
              return {
                deliveryKey: payload.deliveryKey,
                operation: "replaceConversationPermissionOverwrites",
                target: { _tag: "Conversation", conversation: payload.conversation },
              };
            }),
          ),
        );
    }),
);

const botCapabilityHandlersLayer = Layer.merge(
  botCapabilityCacheHandlersLayer,
  botCapabilityDeliveryHandlersLayer,
).pipe(
  Layer.provide(BotCapabilityStore.layer),
  Layer.provide(prefixedUnstorageLayer),
  Layer.provide(DiscordApplication.restLayer),
  Layer.provide(DiscordLayer),
  Layer.provide([discordConfigLayer, cachesLayer]),
);

const updateOriginalInteractionResponseFallbackLayer = HttpRouter.add(
  "PATCH",
  "/bot/interactions/original-response",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const application = yield* DiscordApplication;
    const rest = yield* DiscordREST;
    const body = yield* request.text.pipe(
      Effect.flatMap((text) =>
        Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: (error) => new SheetBotHttpError({ message: String(error), cause: error }),
        }),
      ),
      Effect.flatMap(
        Schema.decodeUnknownEffect(UpdateOriginalInteractionResponseBodyPayloadSchema),
      ),
      (effect) =>
        handleFallbackPayloadError(effect, "Invalid original interaction response request"),
    );

    const message = yield* handleBotRestError(
      rest.updateOriginalWebhookMessage(application.id, body.interactionResponseToken, {
        payload: withoutMessageMentions(
          body.payload,
        ) as Discord.IncomingWebhookUpdateRequestPartial,
      }),
      "Failed to update original interaction response",
    );

    return HttpServerResponse.jsonUnsafe(message);
  }).pipe(Effect.catch(botRestErrorResponse)),
);

const updateOriginalInteractionResponseWithFilesFallbackLayer = HttpRouter.add(
  "PATCH",
  "/bot/interactions/original-response/files",
  Effect.gen(function* () {
    const application = yield* DiscordApplication;
    const rest = yield* DiscordREST;
    const fs = yield* FileSystem.FileSystem;
    const body = yield* handleFallbackPayloadError(
      HttpServerRequest.schemaBodyMultipart(
        UpdateOriginalInteractionResponseWithFilesBodyPayloadSchema,
      ),
      "Invalid original interaction response file request",
    );
    const files = yield* handleBotRestError(
      Effect.forEach(
        body.files,
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
      ),
      "Failed to prepare original interaction response files",
    );

    const message = yield* handleBotRestError(
      rest.withFiles(files)(
        rest.updateOriginalWebhookMessage(application.id, body.interactionResponseToken, {
          payload: withoutMessageMentions(
            body.payload,
          ) as Discord.IncomingWebhookUpdateRequestPartial,
        }),
      ),
      "Failed to update original interaction response with files",
    );

    return HttpServerResponse.jsonUnsafe(message);
  }).pipe(Effect.catch(botRestErrorResponse)),
);

const apiRoutesLayer = Layer.provide(HttpApiBuilder.layer(DiscordApi), [discordHandlersLayer]).pipe(
  Layer.merge(
    Layer.provide(HttpApiBuilder.layer(SheetBotClientDeliveryApi), [clientDeliveryHandlersLayer]),
  ),
  Layer.merge(Layer.provide(HttpApiBuilder.layer(SheetBotApi), [botCapabilityHandlersLayer])),
  Layer.merge(updateOriginalInteractionResponseFallbackLayer),
  Layer.merge(updateOriginalInteractionResponseWithFilesFallbackLayer),
  Layer.provide(sheetBotHttpAuthorizationLayer),
  Layer.merge(HttpRouter.add("GET", "/live", HttpServerResponse.empty({ status: 200 }))),
  Layer.merge(HttpRouter.add("GET", "/ready", HttpServerResponse.empty({ status: 200 }))),
  Layer.provide(HttpRouter.layer),
);

export const httpLayer = HttpRouter.serve(apiRoutesLayer).pipe(
  HttpServer.withLogAddress,
  Layer.provide(DiscordApplication.restLayer),
  Layer.provide(DiscordLayer),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(discordConfigLayer),
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 })),
);
