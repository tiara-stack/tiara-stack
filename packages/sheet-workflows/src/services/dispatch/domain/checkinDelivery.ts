import { Cause, Effect, Option } from "effect";
import type { SheetTextPart } from "sheet-ingress-api/schemas/client";
import type {
  CheckinDispatchPayload,
  CheckinDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import {
  sendCheckinOpeningDmReminders,
  sendMonitorCheckinOpeningDmPing,
} from "../../checkinDmReminders";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { checkinActionRow } from "sheet-message-content/components";
import { checkinPromptMessage } from "sheet-message-content/checkinPrompt";
import { sendTentativeRoomOrder } from "../../tentativeRoomOrder";
import {
  compensateDeliveryFailure,
  logEnableFailure,
  logNonInterruptFailure,
  makeMessageSink,
  reconcileDeliveryPersistence,
} from "../clients/messageDelivery";
import { makeSheetApisServices } from "../clients/sheetApis";
import { makeDeliveryNonce } from "../pure/deliveryNonce";
import { messageEnableRetrySchedule } from "../pure/retry";

type MessageTextInput = string | ReadonlyArray<SheetTextPart>;
type SheetApisServices = ReturnType<typeof makeSheetApisServices>;
type GeneratedCheckin = Effect.Success<ReturnType<SheetApisServices["checkinService"]["generate"]>>;
type MessageSink = ReturnType<typeof makeMessageSink>;
type DeliveredMessage = Effect.Success<ReturnType<MessageSink["sendPrimary"]>>;
type MessageCheckinService = {
  readonly persistMessageCheckin: (
    messageId: string,
    payload: {
      readonly data: {
        readonly initialMessage: ReadonlyArray<SheetTextPart>;
        readonly hour: number;
        readonly runningConversationId: string;
        readonly roleId: string | null;
        readonly workspaceId: string;
        readonly conversationId: string;
        readonly createdByUserId: string;
      };
      readonly memberIds: ReadonlyArray<string>;
    },
  ) => Effect.Effect<unknown, unknown>;
  readonly getMessageCheckinData: (
    messageId: string,
  ) => Effect.Effect<Option.Option<unknown>, unknown>;
  readonly removeMessageCheckin: (messageId: string) => Effect.Effect<unknown, unknown>;
};
type MessageRoomOrderService = Parameters<
  typeof sendTentativeRoomOrder
>[0]["messageRoomOrderService"];
type RoomOrderService = Parameters<typeof sendTentativeRoomOrder>[0]["roomOrderService"];
type UserConfigService = Parameters<typeof sendCheckinOpeningDmReminders>[0]["userConfigService"];

export const deliverCheckin = Effect.fn("DispatchService.deliverCheckin")(function* ({
  autoCheckinConcurrency,
  botClient,
  createdByUserId,
  generated,
  initialMessage,
  messageCheckinService,
  messageRoomOrderService,
  payload,
  roomOrderService,
  userConfigService,
}: {
  readonly autoCheckinConcurrency: number;
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly createdByUserId: string;
  readonly generated: GeneratedCheckin;
  readonly initialMessage: ReadonlyArray<SheetTextPart>;
  readonly messageCheckinService: MessageCheckinService;
  readonly messageRoomOrderService: MessageRoomOrderService;
  readonly payload: CheckinDispatchPayload;
  readonly roomOrderService: RoomOrderService;
  readonly userConfigService: UserConfigService;
}) {
  const checkinMessage = yield* botClient.sendMessage(generated.checkinConversationId, {
    ...checkinPromptMessage(initialMessage, true),
    nonce: makeDeliveryNonce(payload.dispatchRequestId),
    enforceNonce: true,
  });
  yield* messageCheckinService
    .persistMessageCheckin(checkinMessage.id, {
      data: {
        initialMessage,
        hour: generated.hour,
        runningConversationId: generated.runningConversationId,
        roleId: generated.roleId,
        workspaceId: payload.workspaceId,
        conversationId: generated.checkinConversationId,
        createdByUserId,
      },
      memberIds: generated.fillIds,
    })
    .pipe(
      Effect.catchCause((cause) =>
        reconcileDeliveryPersistence({
          cause,
          cleanup: botClient.deleteMessage(checkinMessage.conversation_id, checkinMessage.id),
          lookup: messageCheckinService.getMessageCheckinData(checkinMessage.id),
          lookupFailureAnnotations: {
            conversationId: checkinMessage.conversation_id,
            messageId: checkinMessage.id,
          },
          lookupFailureMessage:
            "Failed to reconcile interrupted check-in persistence; delivered message preserved",
        }),
      ),
    );
  const cleanupAnnotations = {
    conversationId: checkinMessage.conversation_id,
    messageId: checkinMessage.id,
  };
  const cleanupFailedEnablement = Effect.all(
    [
      messageCheckinService
        .removeMessageCheckin(checkinMessage.id)
        .pipe(
          Effect.retry(messageEnableRetrySchedule),
          logNonInterruptFailure(
            "Failed to remove persisted check-in after enablement failure",
            cleanupAnnotations,
            Effect.void,
          ),
        ),
      botClient
        .deleteMessage(checkinMessage.conversation_id, checkinMessage.id)
        .pipe(
          Effect.retry(messageEnableRetrySchedule),
          logNonInterruptFailure(
            "Failed to delete disabled check-in message after enablement failure",
            cleanupAnnotations,
            Effect.void,
          ),
        ),
    ],
    { concurrency: 2, discard: true },
  );
  yield* botClient
    .updateMessage(checkinMessage.conversation_id, checkinMessage.id, {
      components: [checkinActionRow()],
    })
    .pipe(
      Effect.retry(messageEnableRetrySchedule),
      Effect.catchCause((cause) =>
        logEnableFailure("Failed to enable persisted check-in message")(cause).pipe(
          Effect.andThen(compensateDeliveryFailure(cause, cleanupFailedEnablement)),
        ),
      ),
    );
  const openingDmDelivery = {
    platform: payload.client.platform,
    workspaceId: payload.workspaceId,
    runningConversationId: generated.runningConversationId,
    runningConversationName: payload.conversationName,
    checkinConversationId: generated.checkinConversationId,
    hour: generated.hour,
    concurrency: autoCheckinConcurrency,
    userConfigService,
    botClient,
  };
  const processOpeningDmDelivery = <A, E, R>(
    delivery: Effect.Effect<A, E, R>,
    failureMessage: string,
  ) =>
    delivery.pipe(
      logNonInterruptFailure(
        failureMessage,
        {
          workspaceId: openingDmDelivery.workspaceId,
          checkinConversationId: openingDmDelivery.checkinConversationId,
          hour: openingDmDelivery.hour,
        },
        Effect.void,
      ),
    );
  yield* Effect.all(
    [
      processOpeningDmDelivery(
        sendCheckinOpeningDmReminders({
          ...openingDmDelivery,
          fillIds: generated.fillIds,
        }),
        "Failed to process check-in opening DM reminders",
      ),
      processOpeningDmDelivery(
        sendMonitorCheckinOpeningDmPing({
          ...openingDmDelivery,
          monitorUserId: generated.monitorUserId,
        }),
        "Failed to process check-in monitor DM ping",
      ),
    ],
    { concurrency: 2 },
  );
  const tentativeRoomOrderMessage = yield* sendTentativeRoomOrder({
    workspaceId: payload.workspaceId,
    runningConversationId: generated.runningConversationId,
    hour: generated.hour,
    fillCount: generated.fillCount,
    createdByUserId,
    client: payload.client,
    botClient,
    roomOrderService,
    messageRoomOrderService,
    logPrefix: "",
  }).pipe(
    logNonInterruptFailure(
      "Failed to send tentative room order after check-in delivery",
      {
        workspaceId: payload.workspaceId,
        runningConversationId: generated.runningConversationId,
        hour: generated.hour,
      },
      Effect.succeed(null),
    ),
  );
  return { checkinMessage, tentativeRoomOrderMessage };
});

export const finalizeCheckinPrimaryMessage = ({
  hasInteractionToken,
  messageContent,
  messageSink,
  primaryMessage,
  recoverUpdateFailure,
}: {
  readonly hasInteractionToken: boolean;
  readonly messageContent: MessageTextInput;
  readonly messageSink: MessageSink;
  readonly primaryMessage: DeliveredMessage;
  readonly recoverUpdateFailure: boolean;
}) => {
  if (!hasInteractionToken) {
    return Effect.succeed(primaryMessage);
  }
  const update = messageSink.updatePrimary(primaryMessage, {
    content: messageContent,
    visibility: "ephemeral",
  });
  return recoverUpdateFailure
    ? update.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : logEnableFailure(
                "Failed to update check-in primary response after persistence; leaving progress message",
              )(cause).pipe(Effect.as(primaryMessage)),
        ),
      )
    : update;
};

export const makeCheckinDispatchResult = ({
  checkinMessage,
  finalPrimaryMessage,
  generated,
  tentativeRoomOrderMessage,
}: {
  readonly checkinMessage: DeliveredMessage | null;
  readonly finalPrimaryMessage: DeliveredMessage;
  readonly generated: GeneratedCheckin;
  readonly tentativeRoomOrderMessage: {
    readonly messageId: string;
    readonly messageConversationId: string;
  } | null;
}): CheckinDispatchResult => ({
  hour: generated.hour,
  runningConversationId: generated.runningConversationId,
  checkinConversationId: generated.checkinConversationId,
  checkinMessageId: checkinMessage?.id ?? null,
  checkinMessageConversationId: checkinMessage?.conversation_id ?? null,
  primaryMessageId: finalPrimaryMessage.id,
  primaryMessageConversationId: finalPrimaryMessage.conversation_id,
  tentativeRoomOrderMessageId: tentativeRoomOrderMessage?.messageId ?? null,
  tentativeRoomOrderMessageConversationId: tentativeRoomOrderMessage?.messageConversationId ?? null,
});
