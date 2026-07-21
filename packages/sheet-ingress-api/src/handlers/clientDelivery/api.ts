import {
  ChannelPermissionOverwrite,
  DiscordBotNotFoundError,
} from "dfx-discord-utils/discord/schema";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { ArgumentError, UnknownError, Unauthorized } from "typhoon-core/error";
import {
  ClientUserRef,
  ClientPlatform,
  ConversationRef,
  InteractionRef,
  MessageRef,
  SheetOutboundMessage,
  WorkspaceRef,
} from "../../schemas/client";
import { SupportedNotificationClient } from "../../schemas/userConfig";

export { DiscordBotNotFoundError };

export const DeliveryMessage = MessageRef;

export const DeliveryEmoji = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
});

export const ClientWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

export const ClientConversation = Schema.Struct({
  id: Schema.String,
  type: Schema.Number,
  workspaceId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
});

export const ClientMember = Schema.Struct({
  userId: Schema.String,
  roleIds: Schema.Array(Schema.String),
});

const DeliveryErrors = [
  ArgumentError,
  DiscordBotNotFoundError,
  Unauthorized,
  UnknownError,
] as const;

export class ClientDeliveryApi extends HttpApiGroup.make("clientDelivery")
  .add(
    HttpApiEndpoint.post("sendMessage", "/clients/messages/send", {
      payload: Schema.Struct({
        conversation: ConversationRef,
        message: SheetOutboundMessage,
      }),
      success: DeliveryMessage,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("sendDirectMessage", "/clients/users/messages/send", {
      payload: Schema.Struct({
        recipient: ClientUserRef,
        message: SheetOutboundMessage,
      }),
      success: DeliveryMessage,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateConversation", "/clients/conversations/update", {
      payload: Schema.Struct({
        conversation: ConversationRef,
        permissionOverwrites: Schema.Array(ChannelPermissionOverwrite),
      }),
      success: Schema.Void,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateMessage", "/clients/messages/update", {
      payload: Schema.Struct({
        messageRef: MessageRef,
        message: SheetOutboundMessage,
      }),
      success: DeliveryMessage,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.patch("updateInteraction", "/clients/interactions/original-response", {
      payload: Schema.Struct({
        interaction: InteractionRef,
        message: SheetOutboundMessage,
      }),
      success: DeliveryMessage,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("pinMessage", "/clients/messages/pin", {
      payload: Schema.Struct({
        messageRef: MessageRef,
      }),
      success: Schema.Void,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("deleteMessage", "/clients/messages/delete", {
      payload: Schema.Struct({
        messageRef: MessageRef,
      }),
      success: Schema.Void,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("addMessageReaction", "/clients/messages/reactions/add", {
      payload: Schema.Struct({
        messageRef: MessageRef,
        emoji: DeliveryEmoji,
      }),
      success: Schema.Void,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("removeMessageReaction", "/clients/messages/reactions/remove", {
      payload: Schema.Struct({
        messageRef: MessageRef,
        emoji: DeliveryEmoji,
      }),
      success: Schema.Void,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("listClients", "/clients", {
      success: Schema.Array(SupportedNotificationClient),
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get("getWorkspace", "/clients/:platform/:clientId/workspaces/:workspaceId", {
      params: Schema.Struct({
        platform: ClientPlatform,
        clientId: Schema.String,
        workspaceId: Schema.String,
      }),
      success: ClientWorkspace,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.get(
      "getConversations",
      "/clients/:platform/:clientId/workspaces/:workspaceId/conversations",
      {
        params: Schema.Struct({
          platform: ClientPlatform,
          clientId: Schema.String,
          workspaceId: Schema.String,
        }),
        success: Schema.Array(ClientConversation),
        error: DeliveryErrors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.get(
      "getMembers",
      "/clients/:platform/:clientId/workspaces/:workspaceId/members",
      {
        params: Schema.Struct({
          platform: ClientPlatform,
          clientId: Schema.String,
          workspaceId: Schema.String,
        }),
        success: Schema.Array(ClientMember),
        error: DeliveryErrors,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("addMemberRole", "/clients/members/roles/add", {
      payload: Schema.Struct({
        workspace: WorkspaceRef,
        userId: Schema.String,
        roleId: Schema.String,
      }),
      success: Schema.Void,
      error: DeliveryErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("removeMemberRole", "/clients/members/roles/remove", {
      payload: Schema.Struct({
        workspace: WorkspaceRef,
        userId: Schema.String,
        roleId: Schema.String,
      }),
      success: Schema.Void,
      error: DeliveryErrors,
    }),
  )
  .annotate(OpenApi.Title, "Client Delivery")
  .annotate(OpenApi.Description, "Ingress-routed messaging client delivery endpoints") {}
