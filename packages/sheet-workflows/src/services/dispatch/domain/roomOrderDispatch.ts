import { Cause, Effect } from "effect";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type {
  RoomOrderDispatchPayload,
  RoomOrderDispatchResult,
  RoomOrderNextButtonPayload,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPreviousButtonPayload,
  RoomOrderSendButtonPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchRequester } from "sheet-ingress-api/sheet-workflows-workflows";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { roomOrderActionRow } from "sheet-message-content/components";
import { roomOrderDraftMessage } from "sheet-message-content/roomOrderMessage";
import * as MessageText from "sheet-message-content/text";
import {
  logEnableFailure,
  makeMessageSink,
  reconcileRoomOrderPersistence,
} from "../clients/messageDelivery";
import { makeSheetApisServices } from "../clients/sheetApis";
import { makeDeliveryNonce } from "../pure/deliveryNonce";
import { recoverNonInterruptCause } from "../pure/failure";
import { messageEnableRetrySchedule } from "../pure/retry";
import { makeRoomOrderHelpers } from "./roomOrder";

type SheetApisServices = ReturnType<typeof makeSheetApisServices>;
type RoomOrderHelpers = ReturnType<typeof makeRoomOrderHelpers>;

const alertDegradedRoomOrderDispatch = (cause: Cause.Cause<unknown>) =>
  Effect.logError("Room-order dispatch requires intervention").pipe(
    Effect.annotateLogs({ cause: Cause.pretty(cause) }),
  );

export const makeRoomOrderOperations = ({
  botClient,
  messageRoomOrderService,
  roomOrderService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly messageRoomOrderService: SheetApisServices["messageRoomOrderService"];
  readonly roomOrderService: SheetApisServices["roomOrderService"];
}) => ({
  roomOrder: Effect.fn("DispatchService.roomOrder")(function* (
    payload: RoomOrderDispatchPayload,
    requester: DispatchRequester,
  ) {
    yield* Effect.annotateCurrentSpan({
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      hour: payload.hour,
      "requester.accountId": requester.accountId,
      "requester.userId": requester.userId,
    });
    const createdByUserId = requester.accountId;
    const generated = yield* roomOrderService.generate(payload);
    const content = MessageText.materializeGeneratedText(
      payload.client,
      payload.workspaceId,
      generated.content,
    );
    const messageSink = makeMessageSink(
      botClient,
      generated.runningConversationId,
      payload.interactionResponseToken,
    );
    const message = yield* messageSink.sendPrimary({
      ...roomOrderDraftMessage(content, generated.range, generated.rank, true),
      nonce: makeDeliveryNonce(`room-order-dispatch:${payload.dispatchRequestId}`),
      enforceNonce: true,
    });

    yield* messageRoomOrderService
      .persistMessageRoomOrder(message.id, {
        data: {
          previousFills: generated.previousFills,
          fills: generated.fills,
          hour: generated.hour,
          rank: generated.rank,
          tentative: false,
          monitor: generated.monitor,
          workspaceId: payload.workspaceId,
          conversationId: message.conversation_id,
          createdByUserId,
        },
        entries: generated.entries,
      })
      .pipe(
        Effect.catchCause((cause) =>
          reconcileRoomOrderPersistence({
            botClient,
            cause,
            message,
            messageRoomOrderService,
          }),
        ),
      );

    yield* messageSink
      .updatePrimary(message, {
        components: [roomOrderActionRow(generated.range, generated.rank)],
      })
      .pipe(
        Effect.retry(messageEnableRetrySchedule),
        Effect.catchCause((cause) =>
          recoverNonInterruptCause(cause, () =>
            logEnableFailure(
              "Failed to enable room-order message after persistence; dispatch is degraded",
            )(cause).pipe(
              Effect.andThen(alertDegradedRoomOrderDispatch(cause)),
              Effect.andThen(Effect.failCause(cause)),
            ),
          ),
        ),
      );

    return {
      messageId: message.id,
      messageConversationId: message.conversation_id,
      hour: generated.hour,
      runningConversationId: generated.runningConversationId,
      rank: generated.rank,
    } satisfies RoomOrderDispatchResult;
  }),
});

export const makeRoomOrderButtonOperations = ({
  handleRoomOrderPinTentativeButton,
  handleRoomOrderRankButton,
  handleRoomOrderSendButton,
}: RoomOrderHelpers) => ({
  roomOrderPreviousButton(
    payload: RoomOrderPreviousButtonPayload,
    authorizedRoomOrder?: MessageRoomOrder,
  ) {
    return handleRoomOrderRankButton(payload, authorizedRoomOrder, "previous");
  },
  roomOrderNextButton(payload: RoomOrderNextButtonPayload, authorizedRoomOrder?: MessageRoomOrder) {
    return handleRoomOrderRankButton(payload, authorizedRoomOrder, "next");
  },
  roomOrderSendButton(payload: RoomOrderSendButtonPayload, authorizedRoomOrder?: MessageRoomOrder) {
    return handleRoomOrderSendButton(payload, authorizedRoomOrder);
  },
  roomOrderPinTentativeButton(
    payload: RoomOrderPinTentativeButtonPayload,
    authorizedRoomOrder?: MessageRoomOrder | null,
  ) {
    return handleRoomOrderPinTentativeButton(payload, authorizedRoomOrder);
  },
});
