import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { Context, Effect, Layer, Schema } from "effect";
import {
  ClientConversation,
  ClientMember,
  ClientWorkspace,
  DeliveryMessage,
} from "sheet-ingress-api/handlers/clientDelivery/api";
import type {
  ConversationRef,
  InteractionRef,
  MessageRef,
  SheetOutboundMessage,
  WorkspaceRef,
} from "sheet-ingress-api/schemas/client";
import { makeUnknownError, Unauthorized } from "typhoon-core/error";
import { ClientRegistry } from "./clientRegistry";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const urlFor = (baseUrl: string, path: string) =>
  new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();

const mapForwardingError = (message: string) => (error: unknown) =>
  error instanceof Unauthorized ? error : makeUnknownError(message, error);

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

      const postJson = <A>(
        entry: { readonly baseUrl: string; readonly serviceTokenResource: string },
        path: string,
        payload: unknown,
        schema: Schema.Schema<A>,
      ) =>
        Effect.gen(function* () {
          const httpClient = authedHttpClientFor(entry);
          return yield* HttpClientRequest.post(urlFor(entry.baseUrl, path)).pipe(
            HttpClientRequest.bodyJson(payload),
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.mapError(mapForwardingError(`Failed to forward client request to ${path}`)),
          );
        });

      return {
        sendMessage: Effect.fn("ClientDeliveryForwardingClient.sendMessage")(function* (
          conversation: ConversationRef,
          message: SheetOutboundMessage,
        ) {
          const entry = yield* registry.resolve(conversation.workspace.client);
          return yield* postJson(
            entry,
            "/clients/messages/send",
            { conversation, message },
            DeliveryMessage,
          );
        }),
        updateMessage: Effect.fn("ClientDeliveryForwardingClient.updateMessage")(function* (
          messageRef: MessageRef,
          message: SheetOutboundMessage,
        ) {
          const entry = yield* registry.resolve(messageRef.conversation.workspace.client);
          return yield* postJson(
            entry,
            "/clients/messages/update",
            { messageRef, message },
            DeliveryMessage,
          );
        }),
        updateInteraction: Effect.fn("ClientDeliveryForwardingClient.updateInteraction")(function* (
          interaction: InteractionRef,
          message: SheetOutboundMessage,
        ) {
          const entry = yield* registry.resolve(interaction.client);
          return yield* postJson(
            entry,
            "/clients/interactions/original-response",
            { interaction, message },
            DeliveryMessage,
          );
        }),
        pinMessage: Effect.fn("ClientDeliveryForwardingClient.pinMessage")(function* (
          messageRef: MessageRef,
        ) {
          const entry = yield* registry.resolve(messageRef.conversation.workspace.client);
          const httpClient = authedHttpClientFor(entry);
          return yield* HttpClientRequest.post(urlFor(entry.baseUrl, "/clients/messages/pin")).pipe(
            HttpClientRequest.bodyJson({ messageRef }),
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.asVoid,
            Effect.mapError(mapForwardingError("Failed to forward client pin request")),
          );
        }),
        deleteMessage: Effect.fn("ClientDeliveryForwardingClient.deleteMessage")(function* (
          messageRef: MessageRef,
        ) {
          const entry = yield* registry.resolve(messageRef.conversation.workspace.client);
          const httpClient = authedHttpClientFor(entry);
          return yield* HttpClientRequest.post(
            urlFor(entry.baseUrl, "/clients/messages/delete"),
          ).pipe(
            HttpClientRequest.bodyJson({ messageRef }),
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.asVoid,
            Effect.mapError(mapForwardingError("Failed to forward client delete request")),
          );
        }),
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
            Effect.mapError(mapForwardingError("Failed to forward client workspace request")),
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
            Effect.mapError(mapForwardingError("Failed to forward client conversations request")),
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
            Effect.mapError(mapForwardingError("Failed to forward client members request")),
          );
        }),
        addMemberRole: Effect.fn("ClientDeliveryForwardingClient.addMemberRole")(function* (
          workspace: WorkspaceRef,
          userId: string,
          roleId: string,
        ) {
          const entry = yield* registry.resolve(workspace.client);
          const httpClient = authedHttpClientFor(entry);
          return yield* HttpClientRequest.post(
            urlFor(entry.baseUrl, "/clients/members/roles/add"),
          ).pipe(
            HttpClientRequest.bodyJson({ workspace, userId, roleId }),
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.asVoid,
            Effect.mapError(mapForwardingError("Failed to forward client add-role request")),
          );
        }),
        removeMemberRole: Effect.fn("ClientDeliveryForwardingClient.removeMemberRole")(function* (
          workspace: WorkspaceRef,
          userId: string,
          roleId: string,
        ) {
          const entry = yield* registry.resolve(workspace.client);
          const httpClient = authedHttpClientFor(entry);
          return yield* HttpClientRequest.post(
            urlFor(entry.baseUrl, "/clients/members/roles/remove"),
          ).pipe(
            HttpClientRequest.bodyJson({ workspace, userId, roleId }),
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.asVoid,
            Effect.mapError(mapForwardingError("Failed to forward client remove-role request")),
          );
        }),
      };
    }),
  },
) {
  static layer = Layer.effect(ClientDeliveryForwardingClient, this.make).pipe(
    Layer.provide(ClientRegistry.layer),
  );
}
