import { NodeFileSystem, NodeHttpServer } from "@effect/platform-node";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { DiscordREST } from "dfx";
import type * as Discord from "dfx/types";
import { DiscordApplication, DiscordLayer } from "dfx-discord-utils/discord";
import { ParentCachePageSize } from "dfx-discord-utils/cache";
import {
  ChannelsCache,
  GuildsCache,
  MembersCache,
  RolesCache,
} from "dfx-discord-utils/discord/cache";
import type { DiscordBotRestError } from "dfx-discord-utils/discord/schema";
import { handleBotRestError } from "dfx-discord-utils/discord/http";
import { Effect, Equal, Layer, Match, Predicate, Schema } from "effect";
import { createServer } from "http";
import {
  BotDependencyUnavailable,
  type BotOutboundFile,
  BotRateLimited,
  BotRequestRejected,
  BotResourceNotFound,
  SheetBotApi,
  maximumBotCollectionPageSize,
  type BotDeliveryOperation,
  type DeliveryKey,
  type DeliveryReceipt,
} from "sheet-bot-api";
import type { ClientRef, ConversationRef, MessageRef } from "sheet-bot-api/references";
import type { BotOutboundMessage } from "sheet-bot-api/message";
import { cachesLayer, prefixedUnstorageLayer } from "./discord/cache";
import { discordConfigLayer } from "./discord/config";
import { config } from "./config";
import { toDiscordMessagePayload } from "./discord/renderSheetMessage";
import { sheetBotHttpAuthorizationLayer } from "./middlewares/discordHttpAuthorization/live";
import { BotCapabilityStore } from "./services/botCapabilityStore";
import { deliveryStoreInput } from "./services/botDeliveryBinding";
import {
  botConversationPage,
  botConversationView,
  botMemberPage,
  botMemberView,
  decodeBotCollectionCursor,
  type BotCollectionCursorContext,
} from "./services/botCachePagination";
import { getObjectField, getStringField } from "./services/unknownObjectFields";

const disabledMentions = () => ({ parse: [] });

const directMessagePayload = <A extends { readonly message_reference?: unknown }>(payload: A) => ({
  ...payload,
  message_reference: undefined,
  flags: undefined,
  allowed_mentions: disabledMentions(),
});

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
  workspaceId = Predicate.isString(message.guild_id) ? message.guild_id : "",
) => discordMessageToRef(client, workspaceId, message);

const renderFiles = (message: BotOutboundMessage) =>
  message.files?.map(
    (file) =>
      new File([file.content as BlobPart], file.name, {
        type: file.contentType,
      }),
  ) ?? [];

const deliveryFileEvidence = (files: ReadonlyArray<BotOutboundFile>) =>
  files.map(({ content, contentType, deliveryBinding, name }) => ({
    name,
    contentType,
    byteLength: content.byteLength,
    ...(Predicate.isUndefined(deliveryBinding) ? {} : { deliveryBinding }),
  }));

export const validateResponseWorkspaceBinding = (
  response: { readonly workspaceId?: string | undefined },
  requested: { readonly workspaceId: string } | undefined,
) =>
  Predicate.isUndefined(requested) || response.workspaceId === requested.workspaceId
    ? Effect.void
    : Effect.fail(
        new BotRequestRejected({
          message: "Response Reference does not match the requested workspace",
        }),
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

const isThisDiscordClient = (configuredClientId: string): Predicate.Predicate<ClientRef> =>
  Predicate.Struct({
    platform: Equal.equals("discord"),
    clientId: Equal.equals(configuredClientId),
  });

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
      .handle("getUserProfile", ({ params }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const memberships = yield* membersCache
            .getForResource(params.userId)
            .pipe(mapCapabilityCacheError("user profile"));
          const firstMember = memberships.values().next().value;
          if (Predicate.isUndefined(firstMember)) {
            return yield* new BotResourceNotFound({
              resource: "user profile",
              message: "Discord user is not present in the bot cache",
            });
          }
          const user = getObjectField(firstMember, "user");
          const username = getStringField(user, "username");
          if (Predicate.isUndefined(username)) {
            return yield* new BotDependencyUnavailable({
              message: "Discord user profile is incomplete",
            });
          }
          const displayName =
            getStringField(user, "global_name") ?? getStringField(firstMember, "nick") ?? null;
          const avatar = getStringField(user, "avatar") ?? null;
          const workspaces = yield* Effect.forEach(memberships.keys(), (workspaceId) =>
            guildsCache.get(workspaceId).pipe(
              mapCapabilityCacheError("workspace"),
              Effect.map((workspace) => ({
                id: workspace.id,
                name: workspace.name,
                icon: workspace.icon ?? null,
                ownerId: workspace.owner_id,
              })),
            ),
          );
          return {
            user: { id: params.userId, username, displayName, avatar },
            workspaces,
          };
        }),
      )
      .handle("getWorkspace", ({ params }) =>
        Effect.gen(function* () {
          yield* requireClientParams(params);
          const workspace = yield* guildsCache
            .get(params.workspaceId)
            .pipe(mapCapabilityCacheError("workspace"));
          return {
            id: workspace.id,
            name: workspace.name,
            icon: workspace.icon ?? null,
            ownerId: workspace.owner_id,
          };
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
            color: role.color,
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
            color: role.color,
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

export const botCapabilityDeliveryHandlersLayer = HttpApiBuilder.group(
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
            deliveryStoreInput(payload),
            Effect.gen(function* () {
              const response = yield* store.resolveResponseReference(payload.responseReference);
              if (!response.permittedOperations.includes("respond")) {
                return yield* new BotRequestRejected({
                  message: "Response Reference does not permit respond operations",
                });
              }
              yield* requireClient(response.client);
              if (!Predicate.isUndefined(payload.workspace)) {
                yield* requireClient(payload.workspace.client);
                yield* validateResponseWorkspaceBinding(response, payload.workspace);
              }
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
                  message: discordInteractionMessageToRef(
                    configuredClient,
                    message,
                    response.workspaceId,
                  ),
                },
                ...(payload.message.files === undefined
                  ? {}
                  : { files: deliveryFileEvidence(payload.message.files) }),
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
        .handle("sendDirectMessage", ({ payload }) =>
          execute(
            "sendDirectMessage",
            payload.deliveryKey,
            payload,
            Effect.gen(function* () {
              yield* requireClient(payload.recipient.client);
              const dmChannel = yield* handleBotRestError(
                rest.createDm({
                  recipient_id: payload.recipient.userId,
                } as Discord.CreatePrivateChannelRequest),
                `Failed to open direct message channel for user ${payload.recipient.userId}`,
              ).pipe(mapCapabilityProviderError("direct message channel"));
              const message = yield* handleBotRestError(
                rest.createMessage(
                  dmChannel.id,
                  directMessagePayload(
                    toDiscordMessagePayload(payload.message),
                  ) as Discord.MessageCreateRequest,
                ),
                `Failed to send direct message to user ${payload.recipient.userId}`,
              ).pipe(mapCapabilityProviderError("direct message"));
              return {
                deliveryKey: payload.deliveryKey,
                operation: "sendDirectMessage",
                target: {
                  _tag: "DirectMessage",
                  recipient: payload.recipient,
                  message: discordMessageToRef(configuredClient, "", message),
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

const apiRoutesLayer = Layer.provide(HttpApiBuilder.layer(SheetBotApi), [
  botCapabilityHandlersLayer,
]).pipe(
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
