import { Effect, Layer, Predicate } from "effect";
import { type BotConversation, type ConversationRef, conversationRefFrom } from "sheet-bot-api";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveDeliveryRejected,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
  mapDeliveryFailure,
} from "../shared/interactive";
import { loadWorkspaceConversations, selectWorkspaceConversation } from "./conversationSelection";
import {
  WorkspaceWelcomeWorkflowOperations,
  WorkspaceWelcomeWorkflowOperationsError,
} from "./service";

const operationError = (operation: string, cause: unknown) =>
  new WorkspaceWelcomeWorkflowOperationsError({ operation, cause });

const selectOperation = "workspaces.deliverWelcome.select-welcome-conversation";
const deliverOperation = "workspaces.deliverWelcome.deliver-workspace-welcome";
export const selectWorkspaceWelcomeConversation = (
  conversations: ReadonlyArray<BotConversation>,
  systemConversationId: string | undefined,
): BotConversation | undefined => selectWorkspaceConversation(conversations, systemConversationId);

const sameConversationReference = (left: ConversationRef, right: ConversationRef): boolean =>
  left.workspace.client.platform === right.workspace.client.platform &&
  left.workspace.client.clientId === right.workspace.client.clientId &&
  left.workspace.workspaceId === right.workspace.workspaceId &&
  left.conversationId === right.conversationId;

export const workspaceWelcomeWorkflowOperationsLayer = Layer.effect(
  WorkspaceWelcomeWorkflowOperations,
  Effect.gen(function* () {
    const cache = yield* SheetBotCacheClient;
    const delivery = yield* SheetBotDeliveryClient;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const selectConversation: WorkspaceWelcomeWorkflowOperations["Service"]["selectConversation"] =
      (input, policy) =>
        Effect.gen(function* () {
          const conversations = yield* loadWorkspaceConversations({
            cache: cache.get().cache,
            client,
            workspaceId: input.workspaceId,
            policy,
            operation: selectOperation,
            operationError,
          });
          const selected = selectWorkspaceWelcomeConversation(
            conversations,
            input.systemConversationId,
          );
          return Predicate.isUndefined(selected)
            ? yield* Effect.fail(interactiveResourceNotFound("sendable workspace conversation"))
            : conversationRefFrom(client, input.workspaceId, selected.id);
        });

    const deliverWelcome: WorkspaceWelcomeWorkflowOperations["Service"]["deliverWelcome"] = (
      input,
      conversation,
      message,
      deliveryKey,
      policy,
    ) => {
      const expected = conversationRefFrom(client, input.workspaceId, conversation.conversationId);
      if (!sameConversationReference(conversation, expected)) {
        return Effect.fail(
          interactiveInvalidRequest(
            "ConversationWorkspaceMismatch",
            "The selected conversation must belong to the configured client and workspace",
          ),
        );
      }
      const rejected = () =>
        interactiveDeliveryRejected(
          deliverOperation,
          "The workspace welcome message was rejected",
          false,
        );
      return delivery
        .get()
        .delivery.sendMessage({ payload: { conversation, deliveryKey, message } })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((error) => {
            const mapped = mapDeliveryFailure(
              policy,
              deliverOperation,
              "conversation",
              false,
              "The workspace welcome message was rejected",
              operationError,
            )(error);
            return Predicate.isTagged("ResourceNotFound")(mapped) ? rejected() : mapped;
          }),
          Effect.filterOrFail(
            (receipt) =>
              receipt.deliveryKey === deliveryKey &&
              sameConversationReference(receipt.target.message.conversation, conversation),
            () =>
              operationError(
                deliverOperation,
                "The bot returned a delivery receipt for a different welcome target",
              ),
          ),
        );
    };

    return { selectConversation, deliverWelcome };
  }),
);
