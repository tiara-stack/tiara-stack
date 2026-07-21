import { Effect } from "effect";
import { ClientDeliveryForwardingClient } from "../../services/clientDeliveryForwardingClient";
import { forwardSheetBot } from "../../services/sheetBotProxy";
import { requireService } from "../authorization";
import type { IngressHandlerTable } from "../types";

const requireServiceBefore = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  requireService().pipe(Effect.andThen(effect));

export const clientDeliveryHandlers = {
  application: (handlers) =>
    handlers.handle("getApplication", forwardSheetBot("application", "getApplication")),
  clientDelivery: (handlers) =>
    handlers
      .handle("sendMessage", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.sendMessage(payload.conversation, payload.message);
          }),
        ),
      )
      .handle("sendDirectMessage", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.sendDirectMessage(payload.recipient, payload.message);
          }),
        ),
      )
      .handle("updateMessage", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.updateMessage(payload.messageRef, payload.message);
          }),
        ),
      )
      .handle("updateConversation", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.updateConversation(
              payload.conversation,
              payload.permissionOverwrites,
            );
          }),
        ),
      )
      .handle("updateInteraction", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.updateInteraction(payload.interaction, payload.message);
          }),
        ),
      )
      .handle("pinMessage", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.pinMessage(payload.messageRef);
          }),
        ),
      )
      .handle("deleteMessage", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.deleteMessage(payload.messageRef);
          }),
        ),
      )
      .handle("addMessageReaction", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.addMessageReaction(payload.messageRef, payload.emoji);
          }),
        ),
      )
      .handle("removeMessageReaction", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.removeMessageReaction(payload.messageRef, payload.emoji);
          }),
        ),
      )
      .handle("listClients", () =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.listClients();
          }),
        ),
      )
      .handle("getWorkspace", ({ params }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.getWorkspace({
              client: { platform: params.platform, clientId: params.clientId },
              workspaceId: params.workspaceId,
            });
          }),
        ),
      )
      .handle("getConversations", ({ params }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.getConversations({
              client: { platform: params.platform, clientId: params.clientId },
              workspaceId: params.workspaceId,
            });
          }),
        ),
      )
      .handle("getMembers", ({ params }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.getMembers({
              client: { platform: params.platform, clientId: params.clientId },
              workspaceId: params.workspaceId,
            });
          }),
        ),
      )
      .handle("addMemberRole", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.addMemberRole(payload.workspace, payload.userId, payload.roleId);
          }),
        ),
      )
      .handle("removeMemberRole", ({ payload }) =>
        requireServiceBefore(
          Effect.gen(function* () {
            const client = yield* ClientDeliveryForwardingClient;
            return yield* client.removeMemberRole(
              payload.workspace,
              payload.userId,
              payload.roleId,
            );
          }),
        ),
      ),
} satisfies Pick<IngressHandlerTable, "application" | "clientDelivery">;
