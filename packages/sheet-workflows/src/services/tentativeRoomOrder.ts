import { Cause, Effect } from "effect";
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import type {
  GeneratedRoomOrderEntry,
  RoomOrderGenerateResult,
} from "sheet-ingress-api/schemas/roomOrder";
import { shouldSendTentativeRoomOrder } from "sheet-ingress-api/clientActions";
import { tentativeRoomOrderPinActionRow } from "sheet-message-content/components";
import {
  generatingRoomOrderMessage,
  tentativeRoomOrderContent,
  tentativeRoomOrderMessage,
} from "sheet-message-content/roomOrderMessage";
import { ClientDeliveryClient } from "./clientDeliveryClient";
import * as MessageText from "sheet-message-content/text";
import { logEnableFailure } from "./dispatch/clients/messageDelivery";
import { recoverNonInterruptCause } from "./dispatch/pure/failure";
import { messageEnableRetrySchedule } from "./dispatch/pure/retry";

type RoomOrderService = {
  readonly generate: (payload: {
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly hour: number;
  }) => Effect.Effect<RoomOrderGenerateResult, unknown>;
};

type PersistTentativeRoomOrderPayload = {
  readonly data: {
    readonly previousFills: ReadonlyArray<string>;
    readonly fills: ReadonlyArray<string>;
    readonly hour: number;
    readonly rank: number;
    readonly tentative: true;
    readonly monitor: string | null;
    readonly workspaceId: string;
    readonly conversationId: string;
    readonly createdByUserId: string | null;
  };
  readonly entries: ReadonlyArray<GeneratedRoomOrderEntry>;
};

type MessageRoomOrderService = {
  readonly persistMessageRoomOrder: (
    messageId: string,
    payload: PersistTentativeRoomOrderPayload,
  ) => Effect.Effect<unknown, unknown>;
};

const alertDegradedTentativeRoomOrder = (cause: Cause.Cause<unknown>) =>
  Effect.logError("Tentative room-order finalization requires intervention").pipe(
    Effect.annotateLogs({ cause: Cause.pretty(cause) }),
  );

export const sendTentativeRoomOrder = Effect.fn("sendTentativeRoomOrder")(function* ({
  workspaceId,
  runningConversationId,
  hour,
  fillCount,
  createdByUserId,
  client,
  botClient,
  roomOrderService,
  messageRoomOrderService,
  logPrefix,
}: {
  readonly workspaceId: string;
  readonly runningConversationId: string;
  readonly hour: number;
  readonly fillCount: number;
  readonly createdByUserId: string | null;
  readonly client: ClientRef;
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly roomOrderService: RoomOrderService;
  readonly messageRoomOrderService: MessageRoomOrderService;
  readonly logPrefix: string;
}) {
  const logSubject =
    logPrefix.length === 0 ? "tentative room order" : `${logPrefix} tentative room order`;
  yield* Effect.annotateCurrentSpan({
    workspaceId,
    conversationId: runningConversationId,
    hour,
    fillCount,
  });
  if (!shouldSendTentativeRoomOrder(fillCount)) {
    return null;
  }

  return yield* Effect.gen(function* () {
    const generated = yield* roomOrderService.generate({
      workspaceId,
      conversationId: runningConversationId,
      hour,
    });
    const content = MessageText.materializeGeneratedText(client, workspaceId, generated.content);

    const sentMessage = yield* botClient.sendMessage(runningConversationId, {
      ...generatingRoomOrderMessage(tentativeRoomOrderContent(content)),
    });

    const persisted = yield* messageRoomOrderService
      .persistMessageRoomOrder(sentMessage.id, {
        data: {
          previousFills: generated.previousFills,
          fills: generated.fills,
          hour: generated.hour,
          rank: generated.rank,
          tentative: true,
          monitor: generated.monitor,
          workspaceId,
          conversationId: sentMessage.conversation_id,
          createdByUserId,
        },
        entries: generated.entries,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          recoverNonInterruptCause(cause, () =>
            Effect.logError(`Failed to persist ${logSubject}`).pipe(
              Effect.annotateLogs({
                workspaceId,
                runningConversationId,
                hour,
                messageId: sentMessage.id,
              }),
              Effect.andThen(Effect.logError(cause)),
              Effect.andThen(
                botClient
                  .updateMessage(sentMessage.conversation_id, sentMessage.id, {
                    ...tentativeRoomOrderMessage(content, generated.range, generated.rank),
                    components: [tentativeRoomOrderPinActionRow()],
                  })
                  .pipe(
                    Effect.catchCause((updateCause) =>
                      recoverNonInterruptCause(updateCause, () =>
                        Effect.logError(
                          `Failed to persist ${logSubject} and downgrade buttons`,
                        ).pipe(
                          Effect.annotateLogs({
                            workspaceId,
                            runningConversationId,
                            hour,
                            messageId: sentMessage.id,
                          }),
                          Effect.andThen(Effect.logError(cause)),
                          Effect.andThen(Effect.logError(updateCause)),
                        ),
                      ),
                    ),
                  ),
              ),
            ),
          ).pipe(Effect.as(false)),
        ),
      );

    if (persisted) {
      yield* botClient
        .updateMessage(
          sentMessage.conversation_id,
          sentMessage.id,
          tentativeRoomOrderMessage(content, generated.range, generated.rank),
        )
        .pipe(
          Effect.retry(messageEnableRetrySchedule),
          Effect.catchCause((cause) =>
            recoverNonInterruptCause(cause, () =>
              logEnableFailure(
                "Failed to finalize tentative room-order message after persistence; dispatch is degraded",
              )(cause).pipe(
                Effect.andThen(alertDegradedTentativeRoomOrder(cause)),
                Effect.andThen(Effect.failCause(cause)),
              ),
            ),
          ),
        );
    }

    return {
      messageId: sentMessage.id,
      messageConversationId: sentMessage.conversation_id,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      recoverNonInterruptCause(cause, () =>
        Effect.logError(`Failed to send ${logSubject}`).pipe(
          Effect.annotateLogs({
            workspaceId,
            runningConversationId,
            hour,
          }),
          Effect.andThen(Effect.logError(cause)),
          Effect.as(null),
        ),
      ),
    ),
  );
});
