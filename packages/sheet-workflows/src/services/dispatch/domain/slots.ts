import { Effect } from "effect";
import type {
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotListDispatchPayload,
  SlotListDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchRequester } from "sheet-ingress-api/sheet-workflows-workflows";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { slotActionRow } from "../../messageComponents";
import * as MessageText from "../../messageText";
import { logNonInterruptFailure, reconcileDeliveryPersistence } from "../clients/messageDelivery";
import { makeSheetApisServices } from "../clients/sheetApis";
import { makeDeliveryNonce } from "../pure/deliveryNonce";
import { makeWebScheduleEmbed } from "../pure/rendering";
import type { SlotEmbedRenderer } from "./slotRendering";

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;

export const makeSlotOperations = ({
  botClient,
  makeSlotEmbeds,
  messageSlotService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly makeSlotEmbeds: SlotEmbedRenderer;
  readonly messageSlotService: SheetApisServices["messageSlotService"];
}) => ({
  slotButton: Effect.fn("DispatchService.slotButton")(function* (
    payload: SlotButtonDispatchPayload,
    requester: DispatchRequester,
  ) {
    yield* Effect.annotateCurrentSpan({
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      day: payload.day,
      "requester.accountId": requester.accountId,
      "requester.userId": requester.userId,
    });
    const message = yield* botClient.sendMessage(payload.conversationId, {
      content: [
        MessageText.text(
          `Press the button below to get the current open slots for day ${payload.day}`,
        ),
      ],
      components: [slotActionRow()],
      nonce: makeDeliveryNonce(payload.dispatchRequestId),
      enforceNonce: true,
    });

    yield* messageSlotService
      .upsertMessageSlotData(message.id, {
        day: payload.day,
        workspaceId: payload.workspaceId,
        conversationId: payload.conversationId,
        createdByUserId: requester.userId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          reconcileDeliveryPersistence({
            cause,
            cleanup: botClient.deleteMessage(message.conversation_id, message.id),
            lookup: messageSlotService.getMessageSlotData(message.id),
            lookupFailureAnnotations: {
              conversationId: payload.conversationId,
              messageId: message.id,
            },
            lookupFailureMessage:
              "Failed to reconcile interrupted slot persistence; delivered message preserved",
          }),
        ),
      );

    yield* botClient
      .updateOriginalInteractionResponse(payload.interactionResponseToken, {
        content: [MessageText.text("Slot button sent!")],
        visibility: "ephemeral",
      })
      .pipe(
        logNonInterruptFailure(
          "Failed to update slot button interaction response",
          {
            workspaceId: payload.workspaceId,
            conversationId: payload.conversationId,
            messageId: message.id,
          },
          Effect.void,
        ),
      );

    return {
      messageId: message.id,
      messageConversationId: message.conversation_id,
      day: payload.day,
    } satisfies SlotButtonDispatchResult;
  }),
  slotList: Effect.fn("DispatchService.slotList")(function* (payload: SlotListDispatchPayload) {
    yield* Effect.annotateCurrentSpan({
      workspaceId: payload.workspaceId,
      day: payload.day,
      messageType: payload.messageType,
    });
    const slotEmbeds = yield* makeSlotEmbeds(payload.workspaceId, payload.day);

    yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
      embeds: [...slotEmbeds, makeWebScheduleEmbed()],
    });

    return {
      workspaceId: payload.workspaceId,
      day: payload.day,
      messageType: payload.messageType,
    } satisfies SlotListDispatchResult;
  }),
});
