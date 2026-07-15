import { DiscordBotNotFoundError } from "dfx-discord-utils/discord/schema";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { Context, Effect, Layer, Predicate, Schema } from "effect";
import {
  ClientConversation,
  DeliveryEmoji,
  ClientMember,
  ClientWorkspace,
  DeliveryMessage,
} from "sheet-ingress-api/handlers/clientDelivery/api";
import {
  ClientUserRef,
  ConversationRef,
  InteractionRef,
  MessageRef,
  SheetOutboundMessage,
  WorkspaceRef,
} from "sheet-ingress-api/schemas/client";
import { makeUnknownError, Unauthorized, UnknownError } from "typhoon-core/error";
import { ClientRegistry } from "./clientRegistry";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const urlFor = (baseUrl: string, path: string) =>
  new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

const jsonRequest = {
  PATCH: HttpClientRequest.patch,
  POST: HttpClientRequest.post,
} as const;

const SendMessagePayload = Schema.Struct({
  conversation: ConversationRef,
  message: SheetOutboundMessage,
});

const SendDirectMessagePayload = Schema.Struct({
  recipient: ClientUserRef,
  message: SheetOutboundMessage,
});

const UpdateMessagePayload = Schema.Struct({
  messageRef: MessageRef,
  message: SheetOutboundMessage,
});

const UpdateInteractionPayload = Schema.Struct({
  interaction: InteractionRef,
  message: SheetOutboundMessage,
});

const MessageRefPayload = Schema.Struct({
  messageRef: MessageRef,
});

const MessageReactionPayload = Schema.Struct({
  messageRef: MessageRef,
  emoji: DeliveryEmoji,
});

const MemberRolePayload = Schema.Struct({
  workspace: WorkspaceRef,
  userId: Schema.String,
  roleId: Schema.String,
});

const isUnauthorized = (error: unknown): error is Unauthorized =>
  Predicate.isError(error) && Predicate.isTagged(error, "Unauthorized");

const mapForwardingError = (message: string) => (error: unknown) => {
  if (isUnauthorized(error)) {
    return error;
  }
  return makeUnknownError(message, error);
};

type ForwardingError = Unauthorized | UnknownError | DiscordBotNotFoundError;

const failForwardingError =
  (message: string) =>
  (error: unknown): Effect.Effect<never, ForwardingError> => {
    if (
      HttpClientError.isHttpClientError(error) &&
      Predicate.isTagged(error.reason, "StatusCodeError") &&
      error.reason.response.status === 404
    ) {
      return error.reason.response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(DiscordBotNotFoundError)),
        Effect.matchEffect({
          onFailure: () => Effect.fail(mapForwardingError(message)(error)),
          onSuccess: Effect.fail,
        }),
      );
    }
    return Effect.fail(mapForwardingError(message)(error));
  };

export class ClientDeliveryForwardingClient extends Context.Service<ClientDeliveryForwardingClient>()(
  "ClientDeliveryForwardingClient",
  {
    make: Effect.gen(function* () {
      const registry = yield* ClientRegistry;
      const baseHttpClient = yield* HttpClient.HttpClient;
      const tokens = yield* SheetApisRpcTokens;

      const authedHttpClientFor = (entry: { readonly serviceTokenResource: string }) =>
        HttpClient.mapRequestEffect(baseHttpClient, (request) =>
          getIngressRpcHeaders({ serviceTokenResource: entry.serviceTokenResource }).pipe(
            Effect.provideService(SheetApisRpcTokens, tokens),
            Effect.map((headers) => HttpClientRequest.setHeaders(request, headers)),
            Effect.mapError(
              (error) =>
                new Unauthorized({
                  message: "Failed to create client forwarding OAuth token",
                  cause: error,
                }),
            ),
          ),
        );

      const sendJson = <A>(
        method: keyof typeof jsonRequest,
        entry: { readonly baseUrl: string; readonly serviceTokenResource: string },
        path: string,
        payload: unknown,
        payloadSchema: Schema.Codec<unknown, unknown, never, never>,
        schema: Schema.Schema<A>,
      ) =>
        Effect.gen(function* () {
          const httpClient = authedHttpClientFor(entry);
          const encodedPayload = yield* Schema.encodeUnknownEffect(payloadSchema)(payload).pipe(
            Effect.mapError(mapForwardingError(`Failed to encode client request to ${path}`)),
          );
          return yield* jsonRequest[method](urlFor(entry.baseUrl, path)).pipe(
            HttpClientRequest.bodyJson(encodedPayload),
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.catch(failForwardingError(`Failed to forward client request to ${path}`)),
          );
        });

      const sendJsonVoid = (
        method: keyof typeof jsonRequest,
        entry: { readonly baseUrl: string; readonly serviceTokenResource: string },
        path: string,
        payload: unknown,
        payloadSchema: Schema.Codec<unknown, unknown, never, never>,
        message: string,
      ) =>
        Effect.gen(function* () {
          const httpClient = authedHttpClientFor(entry);
          const encodedPayload = yield* Schema.encodeUnknownEffect(payloadSchema)(payload).pipe(
            Effect.mapError(mapForwardingError(`Failed to encode client request to ${path}`)),
          );
          return yield* jsonRequest[method](urlFor(entry.baseUrl, path)).pipe(
            HttpClientRequest.bodyJson(encodedPayload),
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.asVoid,
            Effect.catch(failForwardingError(message)),
          );
        });

      return {
        listClients: Effect.fn("ClientDeliveryForwardingClient.listClients")(function* () {
          return yield* registry.list();
        }),
        sendMessage: Effect.fn("ClientDeliveryForwardingClient.sendMessage")(function* (
          conversation: ConversationRef,
          message: SheetOutboundMessage,
        ) {
          const entry = yield* registry.resolve(conversation.workspace.client);
          return yield* sendJson(
            "POST",
            entry,
            "/clients/messages/send",
            { conversation, message },
            SendMessagePayload,
            DeliveryMessage,
          );
        }),
        sendDirectMessage: Effect.fn("ClientDeliveryForwardingClient.sendDirectMessage")(function* (
          recipient: ClientUserRef,
          message: SheetOutboundMessage,
        ) {
          const entry = yield* registry.resolve(recipient.client);
          return yield* sendJson(
            "POST",
            entry,
            "/clients/users/messages/send",
            { recipient, message },
            SendDirectMessagePayload,
            DeliveryMessage,
          );
        }),
        updateMessage: Effect.fn("ClientDeliveryForwardingClient.updateMessage")(function* (
          messageRef: MessageRef,
          message: SheetOutboundMessage,
        ) {
          const entry = yield* registry.resolve(messageRef.conversation.workspace.client);
          return yield* sendJson(
            "PATCH",
            entry,
            "/clients/messages/update",
            { messageRef, message },
            UpdateMessagePayload,
            DeliveryMessage,
          );
        }),
        updateInteraction: Effect.fn("ClientDeliveryForwardingClient.updateInteraction")(function* (
          interaction: InteractionRef,
          message: SheetOutboundMessage,
        ) {
          const entry = yield* registry.resolve(interaction.client);
          return yield* sendJson(
            "PATCH",
            entry,
            "/clients/interactions/original-response",
            { interaction, message },
            UpdateInteractionPayload,
            DeliveryMessage,
          );
        }),
        pinMessage: Effect.fn("ClientDeliveryForwardingClient.pinMessage")(function* (
          messageRef: MessageRef,
        ) {
          const entry = yield* registry.resolve(messageRef.conversation.workspace.client);
          return yield* sendJsonVoid(
            "POST",
            entry,
            "/clients/messages/pin",
            { messageRef },
            MessageRefPayload,
            "Failed to forward client pin request",
          );
        }),
        deleteMessage: Effect.fn("ClientDeliveryForwardingClient.deleteMessage")(function* (
          messageRef: MessageRef,
        ) {
          const entry = yield* registry.resolve(messageRef.conversation.workspace.client);
          return yield* sendJsonVoid(
            "POST",
            entry,
            "/clients/messages/delete",
            { messageRef },
            MessageRefPayload,
            "Failed to forward client delete request",
          );
        }),
        addMessageReaction: Effect.fn("ClientDeliveryForwardingClient.addMessageReaction")(
          function* (messageRef: MessageRef, emoji: typeof DeliveryEmoji.Type) {
            const entry = yield* registry.resolve(messageRef.conversation.workspace.client);
            return yield* sendJsonVoid(
              "POST",
              entry,
              "/clients/messages/reactions/add",
              { messageRef, emoji },
              MessageReactionPayload,
              "Failed to forward client add-reaction request",
            );
          },
        ),
        removeMessageReaction: Effect.fn("ClientDeliveryForwardingClient.removeMessageReaction")(
          function* (messageRef: MessageRef, emoji: typeof DeliveryEmoji.Type) {
            const entry = yield* registry.resolve(messageRef.conversation.workspace.client);
            return yield* sendJsonVoid(
              "POST",
              entry,
              "/clients/messages/reactions/remove",
              { messageRef, emoji },
              MessageReactionPayload,
              "Failed to forward client remove-reaction request",
            );
          },
        ),
        getWorkspace: Effect.fn("ClientDeliveryForwardingClient.getWorkspace")(function* (
          workspace: WorkspaceRef,
        ) {
          const entry = yield* registry.resolve(workspace.client);
          const httpClient = authedHttpClientFor(entry);
          const url = urlFor(
            entry.baseUrl,
            `/clients/${workspace.client.platform}/${encodeURIComponent(
              workspace.client.clientId,
            )}/workspaces/${encodeURIComponent(workspace.workspaceId)}`,
          );
          return yield* HttpClientRequest.get(url).pipe(
            httpClient.execute,
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ClientWorkspace)),
            Effect.catch(failForwardingError("Failed to forward client workspace request")),
          );
        }),
        getConversations: Effect.fn("ClientDeliveryForwardingClient.getConversations")(function* (
          workspace: WorkspaceRef,
        ) {
          const entry = yield* registry.resolve(workspace.client);
          const httpClient = authedHttpClientFor(entry);
          const url = urlFor(
            entry.baseUrl,
            `/clients/${workspace.client.platform}/${encodeURIComponent(
              workspace.client.clientId,
            )}/workspaces/${encodeURIComponent(workspace.workspaceId)}/conversations`,
          );
          return yield* HttpClientRequest.get(url).pipe(
            httpClient.execute,
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(ClientConversation))),
            Effect.catch(failForwardingError("Failed to forward client conversations request")),
          );
        }),
        getMembers: Effect.fn("ClientDeliveryForwardingClient.getMembers")(function* (
          workspace: WorkspaceRef,
        ) {
          const entry = yield* registry.resolve(workspace.client);
          const httpClient = authedHttpClientFor(entry);
          const url = urlFor(
            entry.baseUrl,
            `/clients/${workspace.client.platform}/${encodeURIComponent(
              workspace.client.clientId,
            )}/workspaces/${encodeURIComponent(workspace.workspaceId)}/members`,
          );
          return yield* HttpClientRequest.get(url).pipe(
            httpClient.execute,
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(ClientMember))),
            Effect.catch(failForwardingError("Failed to forward client members request")),
          );
        }),
        addMemberRole: Effect.fn("ClientDeliveryForwardingClient.addMemberRole")(function* (
          workspace: WorkspaceRef,
          userId: string,
          roleId: string,
        ) {
          const entry = yield* registry.resolve(workspace.client);
          return yield* sendJsonVoid(
            "POST",
            entry,
            "/clients/members/roles/add",
            { workspace, userId, roleId },
            MemberRolePayload,
            "Failed to forward client add-role request",
          );
        }),
        removeMemberRole: Effect.fn("ClientDeliveryForwardingClient.removeMemberRole")(function* (
          workspace: WorkspaceRef,
          userId: string,
          roleId: string,
        ) {
          const entry = yield* registry.resolve(workspace.client);
          return yield* sendJsonVoid(
            "POST",
            entry,
            "/clients/members/roles/remove",
            { workspace, userId, roleId },
            MemberRolePayload,
            "Failed to forward client remove-role request",
          );
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(ClientDeliveryForwardingClient, this.make).pipe(
    Layer.provide(ClientRegistry.layer),
    Layer.provide(SheetApisRpcTokens.layer),
  );
}
