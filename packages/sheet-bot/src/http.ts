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
import { DiscordApi } from "dfx-discord-utils/discord/api";
import { ChannelsCache, GuildsCache, MembersCache } from "dfx-discord-utils/discord/cache";
import {
  DiscordMessageRequestSchema,
  makeDiscordBotRestError,
  type DiscordBotRestError,
} from "dfx-discord-utils/discord/schema";
import { discordHttpApiHandlersLayer, handleBotRestError } from "dfx-discord-utils/discord/http";
import { Effect, FileSystem, Layer, Predicate, Schema } from "effect";
import { createServer } from "http";
import { ClientDeliveryApi } from "sheet-ingress-api/handlers/clientDelivery/api";
import type {
  ClientRef,
  ConversationRef,
  MessageRef,
  SheetOutboundMessage,
} from "sheet-ingress-api/schemas/client";
import { makeArgumentError, makeUnknownError } from "typhoon-core/error";
import { cachesLayer } from "./discord/cache";
import { discordConfigLayer } from "./discord/config";
import { config } from "./config";
import { toDiscordMessagePayload } from "./discord/renderSheetMessage";
import { sheetBotHttpAuthorizationLayer } from "./middlewares/discordHttpAuthorization/live";

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

const getObjectField = (value: unknown, field: string): unknown =>
  Predicate.isObject(value) ? value[field] : undefined;

const getStringField = (value: unknown, field: string): string | undefined => {
  const fieldValue = getObjectField(value, field);
  return Predicate.isString(fieldValue) ? fieldValue : undefined;
};

const getNumberField = (value: unknown, field: string): number | undefined => {
  const fieldValue = getObjectField(value, field);
  return Predicate.isNumber(fieldValue) ? fieldValue : undefined;
};

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

const mapClientDeliveryAdapterError =
  (message: string) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, ReturnType<typeof makeUnknownError>, R> =>
    effect.pipe(Effect.mapError((error) => makeUnknownError(message, error)));

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
        client.platform === "discord" && client.clientId === configuredClientId
          ? Effect.void
          : Effect.fail(
              makeArgumentError(`Unknown Discord client ${client.platform}:${client.clientId}`),
            );

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
                withoutMessageMentions(
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
          catch: (error) => error,
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
