import { Cause, Duration, Effect, Option, Schedule } from "effect";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type {
  RoomOrderButtonResult,
  RoomOrderSendButtonPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import {
  publishedRoomOrderMessage,
  roomOrderSendAcknowledgementMessage,
} from "sheet-message-content/roomOrderMessage";
import { makeUnknownError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { makeDeliveryNonce } from "../pure/deliveryNonce";
import { claimRetrySchedule } from "../pure/retry";
import { logNonInterruptFailure } from "../clients/messageDelivery";
import {
  ignoreInteractionUpdateFailure,
  releaseRoomOrderClaim,
  type MessagePayload,
  type MessageRoomOrderService,
  type RoomOrderCommon,
  type RoomOrderButtonMode,
} from "./roomOrderCommon";

export const makeRoomOrderSend = ({
  botClient,
  common,
  messageRoomOrderService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly common: RoomOrderCommon;
  readonly messageRoomOrderService: MessageRoomOrderService;
}) => {
  const {
    acknowledgeRoomOrderButton,
    denyRoomOrderButton,
    loadInitialRoomOrder,
    loadRequiredRoomOrderContext,
    requireClaimedRoomOrderMatch,
    requireInitialRoomOrder,
  } = common;

  const pinSentRoomOrder = Effect.fn("DispatchService.pinSentRoomOrder")(function* ({
    sentMessage,
    trustedWorkspaceId,
  }: {
    readonly sentMessage: { readonly id: string; readonly conversation_id: string };
    readonly trustedWorkspaceId: string;
  }) {
    return yield* botClient.createPin(sentMessage.conversation_id, sentMessage.id).pipe(
      Effect.retry(claimRetrySchedule),
      Effect.as(true),
      logNonInterruptFailure(
        "Failed to pin sent room order",
        {
          workspaceId: trustedWorkspaceId,
          conversationId: sentMessage.conversation_id,
          messageId: sentMessage.id,
        },
        Effect.succeed(false),
      ),
    );
  });

  const resolveAlreadySentRoomOrder = Effect.fn("DispatchService.resolveAlreadySentRoomOrder")(
    function* (
      roomOrder: MessageRoomOrder,
      trustedWorkspaceId: string,
      updateInteraction: (content: string) => Effect.Effect<unknown, unknown>,
    ) {
      if (Option.isNone(roomOrder.sentMessageId) || Option.isNone(roomOrder.sentConversationId)) {
        return Option.none<RoomOrderButtonResult>();
      }
      const sentMessage = {
        id: roomOrder.sentMessageId.value,
        conversation_id: roomOrder.sentConversationId.value,
      };
      const pinned = yield* pinSentRoomOrder({ sentMessage, trustedWorkspaceId });
      const detail = pinned
        ? "room order was already sent and is now pinned."
        : "room order was already sent, but pinning still failed.";
      yield* updateInteraction(detail);
      return Option.some({
        messageId: sentMessage.id,
        messageConversationId: sentMessage.conversation_id,
        status: pinned ? "pinned" : "partial",
        detail,
      } satisfies RoomOrderButtonResult);
    },
  );

  const requireRoomOrderSendPreflight = Effect.fn("DispatchService.requireRoomOrderSendPreflight")(
    function* ({
      initialRoomOrder,
      mode,
      payload,
      trustedMessageConversationId,
      trustedWorkspaceId,
      updateInteraction,
    }: {
      readonly initialRoomOrder: MessageRoomOrder;
      readonly mode: RoomOrderButtonMode;
      readonly payload: RoomOrderSendButtonPayload;
      readonly trustedMessageConversationId: string;
      readonly trustedWorkspaceId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      if (mode === "tentative") {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: "cannot send a tentative room order.",
            messageConversationId: trustedMessageConversationId,
            payload,
            updateInteraction,
          }),
        );
      }
      const alreadySent = yield* resolveAlreadySentRoomOrder(
        initialRoomOrder,
        trustedWorkspaceId,
        updateInteraction,
      );
      if (Option.isSome(alreadySent)) {
        return alreadySent;
      }
      if (Option.isSome(initialRoomOrder.tentativePinnedAt)) {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: "tentative room order is already pinned.",
            messageConversationId: trustedMessageConversationId,
            payload,
            updateInteraction,
          }),
        );
      }

      return Option.none<RoomOrderButtonResult>();
    },
  );

  const requireRoomOrderSendClaim = Effect.fn("DispatchService.requireRoomOrderSendClaim")(
    function* ({
      claimId,
      claimedRoomOrder,
      getRoomOrderBusyDetail,
      payload,
      trustedMessageConversationId,
      trustedWorkspaceId,
      updateInteraction,
    }: {
      readonly claimId: string;
      readonly claimedRoomOrder: MessageRoomOrder;
      readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
      readonly payload: RoomOrderSendButtonPayload;
      readonly trustedMessageConversationId: string;
      readonly trustedWorkspaceId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const alreadySent = yield* resolveAlreadySentRoomOrder(
        claimedRoomOrder,
        trustedWorkspaceId,
        updateInteraction,
      );
      if (Option.isSome(alreadySent)) {
        return alreadySent;
      }
      if (!Option.contains(claimedRoomOrder.sendClaimId, claimId)) {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: getRoomOrderBusyDetail(claimedRoomOrder),
            messageConversationId: trustedMessageConversationId,
            payload,
            updateInteraction,
          }),
        );
      }

      return Option.none<RoomOrderButtonResult>();
    },
  );

  const failRoomOrderSend = (
    payload: RoomOrderSendButtonPayload,
    claimId: string,
    updateInteraction: (content: string) => Effect.Effect<unknown, unknown>,
    cause: Cause.Cause<unknown>,
    releaseClaim = true,
  ) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : !releaseClaim
        ? updateInteraction(
            "room-order delivery could not be confirmed; its claim is preserved for recovery.",
          ).pipe(
            ignoreInteractionUpdateFailure,
            Effect.andThen(
              Effect.fail(
                markInteractionFailureHandled(
                  makeUnknownError(
                    "Failed to confirm room-order delivery; claim preserved for recovery",
                    cause,
                  ),
                ),
              ),
            ),
          )
        : releaseRoomOrderClaim(
            messageRoomOrderService.releaseMessageRoomOrderSendClaim(payload.messageId, claimId),
            (releaseCause) =>
              makeUnknownError(
                "Failed to release room-order send claim; claim preserved for recovery",
                {
                  operationCause: Cause.pretty(cause),
                  releaseCause: Cause.pretty(releaseCause),
                },
              ),
          ).pipe(
            Effect.andThen(
              ignoreInteractionUpdateFailure(updateInteraction("room order could not be sent.")),
            ),
            Effect.andThen(
              Effect.fail(
                markInteractionFailureHandled(
                  makeUnknownError("Failed to send room-order button interaction", cause),
                ),
              ),
            ),
          );

  const sendRoomOrderMessage = Effect.fn("DispatchService.sendRoomOrderMessage")(function* ({
    claimId,
    claimedRoomOrder,
    payload,
    renderReply,
    trustedMessageConversationId,
    updateInteraction,
  }: {
    readonly claimId: string;
    readonly claimedRoomOrder: MessageRoomOrder;
    readonly payload: RoomOrderSendButtonPayload;
    readonly renderReply: (
      roomOrder: MessageRoomOrder,
      replyMode: "normal",
    ) => Effect.Effect<MessagePayload, unknown>;
    readonly trustedMessageConversationId: string;
    readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
  }) {
    const reply = yield* renderReply(claimedRoomOrder, "normal").pipe(
      Effect.catchCause((cause) => {
        if (!Cause.hasInterrupts(cause)) {
          return failRoomOrderSend(payload, claimId, updateInteraction, cause);
        }
        return Effect.uninterruptible(
          messageRoomOrderService
            .releaseMessageRoomOrderSendClaim(payload.messageId, claimId)
            .pipe(Effect.retry(claimRetrySchedule)),
        ).pipe(
          Effect.catchCause(
            (releaseCause): Effect.Effect<never, unknown, never> =>
              Effect.failCause(Cause.combine(cause, releaseCause)),
          ),
          Effect.andThen(Effect.failCause(cause)),
        );
      }),
    );
    yield* Effect.logInfo("Sending room-order message").pipe(
      Effect.annotateLogs({
        workspaceId: payload.workspaceId,
        conversationId: trustedMessageConversationId,
        sourceMessageId: payload.messageId,
      }),
    );
    const sentMessage = yield* botClient
      .sendMessage(trustedMessageConversationId, {
        ...publishedRoomOrderMessage(reply.content),
        nonce: makeDeliveryNonce(`room-order-send:${payload.messageId}`),
        enforceNonce: true,
      })
      .pipe(
        Effect.catchCause((cause) =>
          failRoomOrderSend(payload, claimId, updateInteraction, cause, false),
        ),
      );
    yield* Effect.logInfo("Sent room-order message").pipe(
      Effect.annotateLogs({
        workspaceId: payload.workspaceId,
        conversationId: sentMessage.conversation_id,
        sourceMessageId: payload.messageId,
        sentMessageId: sentMessage.id,
      }),
    );
    return sentMessage;
  });

  const completeRoomOrderSendTracking = Effect.fn("DispatchService.completeRoomOrderSendTracking")(
    function* ({
      claimId,
      payload,
      sentMessage,
      updateInteraction,
    }: {
      readonly claimId: string;
      readonly payload: RoomOrderSendButtonPayload;
      readonly sentMessage: { readonly id: string; readonly conversation_id: string };
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const tracking = yield* messageRoomOrderService
        .completeMessageRoomOrderSend(payload.messageId, claimId, {
          id: sentMessage.id,
          conversationId: sentMessage.conversation_id,
        })
        .pipe(
          Effect.retry({ schedule: Schedule.exponential(Duration.millis(200)), times: 4 }),
          Effect.map((roomOrder) => ({ _tag: "tracked" as const, roomOrder })),
          logNonInterruptFailure(
            "Failed to track sent room-order message; send claim preserved",
            {
              conversationId: sentMessage.conversation_id,
              sourceMessageId: payload.messageId,
              sentMessageId: sentMessage.id,
              claimId,
            },
            Effect.succeed({ _tag: "ambiguous" as const }),
          ),
        );
      if (tracking._tag === "ambiguous") {
        const detail =
          "sent room order, but tracking could not be confirmed; the claim was preserved.";
        yield* ignoreInteractionUpdateFailure(updateInteraction(detail));
        return Option.some({
          messageId: sentMessage.id,
          messageConversationId: sentMessage.conversation_id,
          status: "partial",
          detail,
        } satisfies RoomOrderButtonResult);
      }
      const completedRoomOrder = tracking.roomOrder;
      if (
        Option.isNone(completedRoomOrder.sendClaimId) &&
        Option.contains(completedRoomOrder.sentMessageId, sentMessage.id) &&
        Option.contains(completedRoomOrder.sentConversationId, sentMessage.conversation_id)
      ) {
        yield* Effect.logInfo("Tracked sent room-order message").pipe(
          Effect.annotateLogs({
            conversationId: sentMessage.conversation_id,
            sourceMessageId: payload.messageId,
            sentMessageId: sentMessage.id,
          }),
        );
        return Option.none<RoomOrderButtonResult>();
      }

      const detail = "sent room order, but failed to track it.";
      yield* ignoreInteractionUpdateFailure(updateInteraction(detail));
      return Option.some({
        messageId: sentMessage.id,
        messageConversationId: sentMessage.conversation_id,
        status: "partial",
        detail,
      } satisfies RoomOrderButtonResult);
    },
  );

  const handleRoomOrderSendButton = Effect.fn("DispatchService.roomOrderSendButton")(function* (
    payload: RoomOrderSendButtonPayload,
    authorizedRoomOrder?: MessageRoomOrder,
  ) {
    yield* Effect.annotateCurrentSpan({
      workspaceId: payload.workspaceId,
      conversationId: payload.messageConversationId,
      messageId: payload.messageId,
    });
    const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
    const initialRoomOrder = yield* requireInitialRoomOrder(payload, maybeInitialRoomOrder);
    const {
      trustedWorkspaceId,
      trustedMessageConversationId,
      mode,
      renderReply,
      updateInteraction,
      getRoomOrderBusyDetail,
      requireCurrentRoomOrderMatch,
    } = yield* loadRequiredRoomOrderContext(payload, initialRoomOrder);
    const preflightResult = yield* requireRoomOrderSendPreflight({
      initialRoomOrder,
      mode,
      payload,
      trustedMessageConversationId,
      trustedWorkspaceId,
      updateInteraction,
    });
    if (Option.isSome(preflightResult)) {
      yield* Effect.logInfo("Room-order send preflight returned without sending").pipe(
        Effect.annotateLogs({
          workspaceId: trustedWorkspaceId,
          conversationId: trustedMessageConversationId,
          messageId: payload.messageId,
          status: preflightResult.value.status,
          detail: preflightResult.value.detail ?? "",
        }),
      );
      return preflightResult.value;
    }

    yield* requireCurrentRoomOrderMatch();
    const claimId = `room-order-send:${payload.messageId}`;
    const claimedRoomOrder = yield* messageRoomOrderService.claimMessageRoomOrderSend(
      payload.messageId,
      claimId,
    );
    yield* requireClaimedRoomOrderMatch(
      payload,
      claimedRoomOrder,
      messageRoomOrderService.releaseMessageRoomOrderSendClaim(payload.messageId, claimId),
    );
    const claimResult = yield* requireRoomOrderSendClaim({
      claimId,
      claimedRoomOrder,
      getRoomOrderBusyDetail,
      payload,
      trustedMessageConversationId,
      trustedWorkspaceId,
      updateInteraction,
    });
    if (Option.isSome(claimResult)) {
      return claimResult.value;
    }

    const sentMessage = yield* sendRoomOrderMessage({
      claimId,
      claimedRoomOrder,
      payload,
      renderReply,
      trustedMessageConversationId,
      updateInteraction,
    });
    const trackingResult = yield* completeRoomOrderSendTracking({
      claimId,
      payload,
      sentMessage,
      updateInteraction,
    });
    if (Option.isSome(trackingResult)) {
      return trackingResult.value;
    }

    const pinned = yield* pinSentRoomOrder({ sentMessage, trustedWorkspaceId });
    yield* Effect.logInfo("Completed room-order send button").pipe(
      Effect.annotateLogs({
        workspaceId: trustedWorkspaceId,
        conversationId: sentMessage.conversation_id,
        sourceMessageId: payload.messageId,
        sentMessageId: sentMessage.id,
        pinned,
      }),
    );

    const detail = roomOrderSendAcknowledgementMessage(pinned).content;
    yield* acknowledgeRoomOrderButton(updateInteraction, detail);

    return {
      messageId: sentMessage.id,
      messageConversationId: sentMessage.conversation_id,
      status: pinned ? "pinned" : "partial",
      detail,
    } satisfies RoomOrderButtonResult;
  });

  return { handleRoomOrderSendButton };
};
