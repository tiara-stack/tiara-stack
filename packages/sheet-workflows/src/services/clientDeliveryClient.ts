import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { Cache, Context, Duration, Effect, Exit, Layer, Redacted } from "effect";
import { createOAuthClientCredentialsToken } from "sheet-auth/client";
import { DISCORD_SERVICE_USER_ID_SENTINEL } from "sheet-auth/oauth";
import { SheetIngressClientDeliveryApi } from "sheet-ingress-api/api";
import type {
  ClientRef,
  ConversationRef,
  InteractionRef,
  MessageRef,
  SheetOutboundFile,
  SheetOutboundMessage,
  WorkspaceRef,
} from "sheet-ingress-api/schemas/client";
import { config } from "@/config";
import { SheetAuthClient } from "./sheetAuthClient";

type TokenCacheEntry = {
  readonly token: Redacted.Redacted<string> | undefined;
  readonly timeToLive: Duration.Duration;
  readonly failed: boolean;
};

type DeliveryMessage = {
  readonly id: string;
  readonly conversation_id: string;
};

type LegacyConversationEntry = {
  readonly parentId: string;
  readonly resourceId: string;
  readonly value: {
    readonly id: string;
    readonly type: number;
    readonly workspace_id?: string;
    readonly name?: string;
    readonly position?: number;
  };
};

type LegacyMemberEntry = {
  readonly parentId: string;
  readonly resourceId: string;
  readonly value: {
    readonly user: { readonly id: string };
    readonly roles: ReadonlyArray<string>;
  };
};

type ClientDeliveryApiClient = {
  readonly clientDelivery: {
    readonly sendMessage: (args: {
      readonly payload: {
        readonly conversation: ConversationRef;
        readonly message: SheetOutboundMessage;
      };
    }) => Effect.Effect<MessageRef, unknown>;
    readonly updateMessage: (args: {
      readonly payload: {
        readonly messageRef: MessageRef;
        readonly message: SheetOutboundMessage;
      };
    }) => Effect.Effect<MessageRef, unknown>;
    readonly updateInteraction: (args: {
      readonly payload: {
        readonly interaction: InteractionRef;
        readonly message: SheetOutboundMessage;
      };
    }) => Effect.Effect<MessageRef, unknown>;
    readonly pinMessage: (args: {
      readonly payload: { readonly messageRef: MessageRef };
    }) => Effect.Effect<void, unknown>;
    readonly deleteMessage: (args: {
      readonly payload: { readonly messageRef: MessageRef };
    }) => Effect.Effect<void, unknown>;
    readonly getWorkspace: (args: {
      readonly params: {
        readonly platform: string;
        readonly clientId: string;
        readonly workspaceId: string;
      };
    }) => Effect.Effect<{ readonly id: string; readonly name: string }, unknown>;
    readonly getConversations: (args: {
      readonly params: {
        readonly platform: string;
        readonly clientId: string;
        readonly workspaceId: string;
      };
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly type: number;
        readonly workspaceId?: string;
        readonly name?: string;
        readonly position?: number;
      }>,
      unknown
    >;
    readonly getMembers: (args: {
      readonly params: {
        readonly platform: string;
        readonly clientId: string;
        readonly workspaceId: string;
      };
    }) => Effect.Effect<
      ReadonlyArray<{
        readonly userId: string;
        readonly roleIds: ReadonlyArray<string>;
      }>,
      unknown
    >;
    readonly addMemberRole: (args: {
      readonly payload: {
        readonly workspace: WorkspaceRef;
        readonly userId: string;
        readonly roleId: string;
      };
    }) => Effect.Effect<void, unknown>;
    readonly removeMemberRole: (args: {
      readonly payload: {
        readonly workspace: WorkspaceRef;
        readonly userId: string;
        readonly roleId: string;
      };
    }) => Effect.Effect<void, unknown>;
  };
};

const defaultClient: ClientRef = { platform: "discord", clientId: "discord-main" };

export const ClientDeliveryClientRef = Context.Reference<ClientRef>("ClientDeliveryClientRef", {
  defaultValue: () => defaultClient,
});

const workspaceRef = (client: ClientRef, workspaceId: string): WorkspaceRef => ({
  client,
  workspaceId,
});

const conversationRef = (
  client: ClientRef,
  conversationId: string,
  workspaceId = "",
): ConversationRef => ({
  workspace: workspaceRef(client, workspaceId),
  conversationId,
});

const messageRef = (
  client: ClientRef,
  conversationId: string,
  messageId: string,
  workspaceId = "",
): MessageRef => ({
  conversation: conversationRef(client, conversationId, workspaceId),
  messageId,
});

const interactionRef = (client: ClientRef, token: string): InteractionRef => ({
  client,
  token,
  deadlineEpochMs: Date.now() + Duration.toMillis(Duration.minutes(15)),
});

const deliveryMessageFromRef = (ref: MessageRef): DeliveryMessage => ({
  id: ref.messageId,
  conversation_id: ref.conversation.conversationId,
});

export class ClientDeliveryClient extends Context.Service<ClientDeliveryClient>()(
  "ClientDeliveryClient",
  {
    make: Effect.gen(function* () {
      const baseUrl = yield* config.sheetIngressBaseUrl;
      const sheetAuthClient = yield* SheetAuthClient;
      const baseHttpClient = yield* HttpClient.HttpClient;
      const oauthClientId = yield* config.sheetAuthOAuthClientId;
      const oauthClientSecret = yield* config.sheetAuthOAuthClientSecret;

      const tokenCache = yield* Cache.makeWith<string, TokenCacheEntry>(
        Effect.fn("ClientDeliveryClient.lookupServiceToken")((serviceUserId) =>
          createOAuthClientCredentialsToken(sheetAuthClient, {
            clientId: oauthClientId,
            clientSecret: oauthClientSecret,
            scope: ["service"],
            resource: "sheet-ingress",
          }).pipe(
            Effect.map((oauthToken) => ({
              token: oauthToken.accessToken,
              timeToLive: Duration.max(
                Duration.seconds(oauthToken.expiresAt - Math.floor(Date.now() / 1000) - 60),
                Duration.seconds(15),
              ),
              failed: false,
            })),
            Effect.tap((entry) =>
              Effect.annotateCurrentSpan({
                serviceUserId,
                tokenAvailable: true,
                timeToLiveMillis: Duration.toMillis(entry.timeToLive),
              }),
            ),
            Effect.matchEffect({
              onSuccess: Effect.succeed,
              onFailure: (error) =>
                Effect.logError("Failed to create OAuth service token for client delivery", {
                  error,
                  serviceUserId,
                }).pipe(
                  Effect.as({
                    token: undefined,
                    timeToLive: Duration.minutes(1),
                    failed: true,
                  }),
                ),
            }),
          ),
        ),
        {
          capacity: 1,
          timeToLive: Exit.match({
            onFailure: () => Duration.minutes(1),
            onSuccess: ({ timeToLive }) => timeToLive,
          }),
        },
      );

      const httpClient = HttpClient.mapRequestEffect(baseHttpClient, (request) =>
        Effect.gen(function* () {
          const { failed, token } = yield* Cache.get(tokenCache, DISCORD_SERVICE_USER_ID_SENTINEL);

          yield* Effect.annotateCurrentSpan({ tokenAvailable: !failed && token !== undefined });
          if (failed || !token) {
            return yield* Effect.fail(new Error("Failed to create OAuth service token"));
          }
          return HttpClientRequest.bearerToken(request, Redacted.value(token));
        }).pipe(Effect.withSpan("ClientDeliveryClient.mapAuthRequest")),
      ) as unknown as HttpClient.HttpClient;

      const apiClient = (yield* HttpApiClient.makeWith(SheetIngressClientDeliveryApi as never, {
        baseUrl,
        httpClient,
      }).pipe(
        Effect.withSpan("ClientDeliveryClient.makeWith", { attributes: { baseUrl } }),
      )) as ClientDeliveryApiClient;

      const makeBoundClient = (boundClientRef?: ClientRef) => ({
        sendMessage: Effect.fn("ClientDeliveryClient.sendMessage")(function* (
          conversationId: string,
          payload: SheetOutboundMessage,
        ) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          const ref = yield* apiClient.clientDelivery.sendMessage({
            payload: { conversation: conversationRef(clientRef, conversationId), message: payload },
          });
          return deliveryMessageFromRef(ref);
        }),
        updateMessage: Effect.fn("ClientDeliveryClient.updateMessage")(function* (
          conversationId: string,
          messageId: string,
          payload: SheetOutboundMessage,
        ) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          const ref = yield* apiClient.clientDelivery.updateMessage({
            payload: {
              messageRef: messageRef(clientRef, conversationId, messageId),
              message: payload,
            },
          });
          return deliveryMessageFromRef(ref);
        }),
        updateOriginalInteractionResponse: Effect.fn(
          "ClientDeliveryClient.updateOriginalInteractionResponse",
        )(function* (token: string, payload: SheetOutboundMessage) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          const ref = yield* apiClient.clientDelivery.updateInteraction({
            payload: { interaction: interactionRef(clientRef, token), message: payload },
          });
          return deliveryMessageFromRef(ref);
        }),
        updateOriginalInteractionResponseWithFiles: Effect.fn(
          "ClientDeliveryClient.updateOriginalInteractionResponseWithFiles",
        )(function* (
          token: string,
          payload: SheetOutboundMessage,
          files: ReadonlyArray<SheetOutboundFile>,
        ) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          const ref = yield* apiClient.clientDelivery.updateInteraction({
            payload: {
              interaction: interactionRef(clientRef, token),
              message: { ...payload, files },
            },
          });
          return deliveryMessageFromRef(ref);
        }),
        createPin: Effect.fn("ClientDeliveryClient.createPin")(function* (
          conversationId: string,
          messageId: string,
        ) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          return yield* apiClient.clientDelivery.pinMessage({
            payload: { messageRef: messageRef(clientRef, conversationId, messageId) },
          });
        }),
        deleteMessage: Effect.fn("ClientDeliveryClient.deleteMessage")(function* (
          conversationId: string,
          messageId: string,
        ) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          return yield* apiClient.clientDelivery.deleteMessage({
            payload: { messageRef: messageRef(clientRef, conversationId, messageId) },
          });
        }),
        addWorkspaceMemberRole: Effect.fn("ClientDeliveryClient.addWorkspaceMemberRole")(function* (
          workspaceId: string,
          userId: string,
          roleId: string,
        ) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          return yield* apiClient.clientDelivery.addMemberRole({
            payload: { workspace: workspaceRef(clientRef, workspaceId), userId, roleId },
          });
        }),
        removeWorkspaceMemberRole: Effect.fn("ClientDeliveryClient.removeWorkspaceMemberRole")(
          function* (workspaceId: string, userId: string, roleId: string) {
            const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
            return yield* apiClient.clientDelivery.removeMemberRole({
              payload: { workspace: workspaceRef(clientRef, workspaceId), userId, roleId },
            });
          },
        ),
        getWorkspace: Effect.fn("ClientDeliveryClient.getWorkspace")(function* (
          workspaceId: string,
        ) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          return yield* apiClient.clientDelivery.getWorkspace({
            params: {
              platform: clientRef.platform,
              clientId: clientRef.clientId,
              workspaceId: workspaceId,
            },
          });
        }),
        getMembersForParent: Effect.fn("ClientDeliveryClient.getMembersForParent")(function* (
          workspaceId: string,
        ) {
          const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
          const members = yield* apiClient.clientDelivery.getMembers({
            params: {
              platform: clientRef.platform,
              clientId: clientRef.clientId,
              workspaceId: workspaceId,
            },
          });
          return members.map(
            (member): LegacyMemberEntry => ({
              parentId: workspaceId,
              resourceId: member.userId,
              value: { user: { id: member.userId }, roles: member.roleIds },
            }),
          );
        }),
        getConversationsForParent: Effect.fn("ClientDeliveryClient.getConversationsForParent")(
          function* (workspaceId: string) {
            const clientRef = boundClientRef ?? (yield* ClientDeliveryClientRef);
            const conversations = yield* apiClient.clientDelivery.getConversations({
              params: {
                platform: clientRef.platform,
                clientId: clientRef.clientId,
                workspaceId: workspaceId,
              },
            });
            return conversations.map(
              (conversation): LegacyConversationEntry => ({
                parentId: workspaceId,
                resourceId: conversation.id,
                value: {
                  id: conversation.id,
                  type: conversation.type,
                  workspace_id: conversation.workspaceId,
                  name: conversation.name,
                  position: conversation.position,
                },
              }),
            );
          },
        ),
      });

      return {
        ...makeBoundClient(),
        forClient: (clientRef: ClientRef | undefined) =>
          makeBoundClient(clientRef ?? defaultClient),
      };
    }),
  },
) {
  static layer = Layer.effect(ClientDeliveryClient, this.make).pipe(
    Layer.provide(SheetAuthClient.layer),
  );
}
