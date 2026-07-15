import { Effect, Option } from "effect";
import { hasTentativeRoomOrderPrefix } from "sheet-ingress-api/clientActions";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type {
  RoomOrderButtonResult,
  RoomOrderPinTentativeButtonPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { logNonInterruptFailure } from "../clients/messageDelivery";
import { claimRetrySchedule } from "../pure/retry";
import {
  ignoreInteractionUpdateFailure,
  type MessagePayload,
  type MessageRoomOrderService,
  type RoomOrderButtonMode,
  type RoomOrderCommon,
} from "./roomOrderCommon";

export const makeRoomOrderTentative = ({
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
    failRoomOrderInteraction,
    handleFallbackTentativePin,
    loadInitialRoomOrder,
    loadRequiredRoomOrderContext,
    requireClaimedRoomOrderMatch,
    roomOrderButtonResult,
  } = common;
  const retryBooleanOperation = <A, E, R>(
    operation: Effect.Effect<A, E, R>,
    failureMessage: string,
    annotations: Readonly<Record<string, unknown>>,
  ) =>
    operation.pipe(
      Effect.retry(claimRetrySchedule),
      Effect.as(true),
      logNonInterruptFailure(failureMessage, annotations, Effect.succeed(false)),
    );
  const releaseTentativePinClaim = (
    messageId: string,
    pinClaimId: string,
    context: { readonly workspaceId: string; readonly conversationId: string },
  ) =>
    messageRoomOrderService.releaseMessageRoomOrderTentativePinClaim(messageId, pinClaimId).pipe(
      Effect.retry(claimRetrySchedule),
      logNonInterruptFailure(
        "Failed to release tentative room-order pin claim; claim preserved for recovery",
        { messageId, ...context },
        (cause) => Effect.failCause(cause),
      ),
    );

  const requireTentativeFallbackPinPayload = (payload: RoomOrderPinTentativeButtonPayload) =>
    hasTentativeRoomOrderPrefix(payload.messageContent ?? "")
      ? Effect.void
      : failRoomOrderInteraction(
          payload,
          "This is not a tentative room-order message.",
          "Cannot handle tentative room-order pin button, message is not tentative",
        );

  const requireTentativePinMode = Effect.fn("DispatchService.requireTentativePinMode")(function* ({
    mode,
    payload,
    trustedMessageConversationId,
    updateInteraction,
  }: {
    readonly mode: RoomOrderButtonMode;
    readonly payload: RoomOrderPinTentativeButtonPayload;
    readonly trustedMessageConversationId: string;
    readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
  }) {
    if (mode === "tentative") {
      return Option.none<RoomOrderButtonResult>();
    }

    return Option.some(
      yield* denyRoomOrderButton({
        detail: "cannot pin a non-tentative room order.",
        messageConversationId: trustedMessageConversationId,
        payload,
        updateInteraction,
      }),
    );
  });

  const requireTentativePinClaim = Effect.fn("DispatchService.requireTentativePinClaim")(
    function* ({
      getRoomOrderBusyDetail,
      pinClaimId,
      pinClaimedRoomOrder,
      payload,
      trustedMessageConversationId,
      updateInteraction,
    }: {
      readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
      readonly pinClaimId: string;
      readonly pinClaimedRoomOrder: MessageRoomOrder;
      readonly payload: RoomOrderPinTentativeButtonPayload;
      readonly trustedMessageConversationId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      if (!Option.contains(pinClaimedRoomOrder.tentativePinClaimId, pinClaimId)) {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: getRoomOrderBusyDetail(pinClaimedRoomOrder),
            messageConversationId: trustedMessageConversationId,
            payload,
            updateInteraction,
          }),
        );
      }

      return Option.none<RoomOrderButtonResult>();
    },
  );

  const createTentativePin = Effect.fn("DispatchService.createTentativePin")(function* ({
    payload,
    trustedWorkspaceId,
    trustedMessageConversationId,
  }: {
    readonly payload: RoomOrderPinTentativeButtonPayload;
    readonly trustedWorkspaceId: string;
    readonly trustedMessageConversationId: string;
  }) {
    return yield* retryBooleanOperation(
      botClient.createPin(trustedMessageConversationId, payload.messageId),
      "Failed to pin tentative room order",
      {
        workspaceId: trustedWorkspaceId,
        conversationId: trustedMessageConversationId,
        messageId: payload.messageId,
      },
    );
  });

  const completeTentativePin = Effect.fn("DispatchService.completeTentativePin")(function* ({
    pinClaimId,
    payload,
    trustedWorkspaceId,
    trustedMessageConversationId,
    updateInteraction,
  }: {
    readonly pinClaimId: string;
    readonly payload: RoomOrderPinTentativeButtonPayload;
    readonly trustedWorkspaceId: string;
    readonly trustedMessageConversationId: string;
    readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
  }) {
    return yield* messageRoomOrderService
      .completeMessageRoomOrderTentativePin(payload.messageId, pinClaimId)
      .pipe(
        Effect.retry(claimRetrySchedule),
        Effect.map(Option.some),
        logNonInterruptFailure(
          "Failed to track pinned tentative room order",
          {
            workspaceId: trustedWorkspaceId,
            conversationId: trustedMessageConversationId,
            messageId: payload.messageId,
          },
          () =>
            updateInteraction("pinned tentative room order, but failed to track it.").pipe(
              ignoreInteractionUpdateFailure,
              Effect.as(Option.none<MessageRoomOrder>()),
            ),
        ),
      );
  });

  const cleanupTentativePin = Effect.fn("DispatchService.cleanupTentativePin")(function* ({
    initialRoomOrder,
    payload,
    pinnedRoomOrder,
    renderReply,
    trustedWorkspaceId,
    trustedMessageConversationId,
  }: {
    readonly initialRoomOrder: MessageRoomOrder;
    readonly payload: RoomOrderPinTentativeButtonPayload;
    readonly pinnedRoomOrder: MessageRoomOrder | null;
    readonly renderReply: (
      roomOrder: MessageRoomOrder,
      replyMode: "normal",
    ) => Effect.Effect<MessagePayload, unknown>;
    readonly trustedWorkspaceId: string;
    readonly trustedMessageConversationId: string;
  }) {
    const latestReply = yield* renderReply(pinnedRoomOrder ?? initialRoomOrder, "normal").pipe(
      Effect.map(Option.some),
      logNonInterruptFailure(
        "Failed to render pinned tentative room order cleanup",
        {
          workspaceId: trustedWorkspaceId,
          conversationId: trustedMessageConversationId,
          messageId: payload.messageId,
        },
        Effect.succeed(Option.none<MessagePayload>()),
      ),
    );
    return yield* retryBooleanOperation(
      botClient.updateMessage(trustedMessageConversationId, payload.messageId, {
        ...(Option.isSome(latestReply) ? { content: latestReply.value.content } : {}),
        components: [],
      }),
      "Failed to clean up pinned tentative room order",
      {
        workspaceId: trustedWorkspaceId,
        conversationId: trustedMessageConversationId,
        messageId: payload.messageId,
      },
    );
  });

  const publishTentativePin = Effect.fn("DispatchService.publishTentativePin")(function* ({
    initialRoomOrder,
    pinClaimId,
    payload,
    renderReply,
    trustedWorkspaceId,
    trustedMessageConversationId,
    updateInteraction,
  }: {
    readonly initialRoomOrder: MessageRoomOrder;
    readonly pinClaimId: string;
    readonly payload: RoomOrderPinTentativeButtonPayload;
    readonly renderReply: (
      roomOrder: MessageRoomOrder,
      replyMode: "normal",
    ) => Effect.Effect<MessagePayload, unknown>;
    readonly trustedWorkspaceId: string;
    readonly trustedMessageConversationId: string;
    readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
  }) {
    const pinned = yield* createTentativePin({
      payload,
      trustedWorkspaceId,
      trustedMessageConversationId,
    });
    if (!pinned) {
      const cleanedUp = yield* cleanupTentativePin({
        initialRoomOrder,
        payload,
        pinnedRoomOrder: null,
        renderReply,
        trustedWorkspaceId,
        trustedMessageConversationId,
      });
      const detail = cleanedUp
        ? "tentative room-order pin could not be confirmed; message controls were removed and its claim was preserved."
        : "tentative room-order pin could not be confirmed; cleanup failed and its claim was preserved.";
      yield* ignoreInteractionUpdateFailure(updateInteraction(detail));
      return roomOrderButtonResult(payload, trustedMessageConversationId, "partial", detail);
    }

    const maybePinnedRoomOrder = yield* completeTentativePin({
      pinClaimId,
      payload,
      trustedWorkspaceId,
      trustedMessageConversationId,
      updateInteraction,
    });
    if (Option.isNone(maybePinnedRoomOrder)) {
      yield* cleanupTentativePin({
        initialRoomOrder,
        payload,
        pinnedRoomOrder: null,
        renderReply,
        trustedWorkspaceId,
        trustedMessageConversationId,
      });
      return roomOrderButtonResult(
        payload,
        trustedMessageConversationId,
        "partial",
        "pinned tentative room order, but failed to track it.",
      );
    }

    const pinnedRoomOrder = maybePinnedRoomOrder.value;
    if (Option.isNone(pinnedRoomOrder.tentativePinnedAt)) {
      yield* cleanupTentativePin({
        initialRoomOrder,
        payload,
        pinnedRoomOrder,
        renderReply,
        trustedWorkspaceId,
        trustedMessageConversationId,
      });
      const detail = "pinned tentative room order, but failed to track it.";
      yield* ignoreInteractionUpdateFailure(updateInteraction(detail));
      return roomOrderButtonResult(payload, trustedMessageConversationId, "partial", detail);
    }

    const cleanedUp = yield* cleanupTentativePin({
      initialRoomOrder,
      payload,
      pinnedRoomOrder,
      renderReply,
      trustedWorkspaceId,
      trustedMessageConversationId,
    });
    const detail = cleanedUp
      ? "pinned tentative room order!"
      : "pinned tentative room order, but failed to clean up the message.";
    yield* acknowledgeRoomOrderButton(updateInteraction, detail);
    return roomOrderButtonResult(
      payload,
      trustedMessageConversationId,
      cleanedUp ? "pinned" : "partial",
      detail,
    );
  });

  const handleRoomOrderPinTentativeButton = Effect.fn(
    "DispatchService.roomOrderPinTentativeButton",
  )(function* (
    payload: RoomOrderPinTentativeButtonPayload,
    authorizedRoomOrder?: MessageRoomOrder | null,
  ) {
    yield* Effect.annotateCurrentSpan({
      workspaceId: payload.workspaceId,
      conversationId: payload.messageConversationId,
      messageId: payload.messageId,
    });
    const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
    if (Option.isNone(maybeInitialRoomOrder)) {
      yield* requireTentativeFallbackPinPayload(payload);
      return yield* handleFallbackTentativePin(payload);
    }
    const initialRoomOrder = maybeInitialRoomOrder.value;
    const {
      trustedWorkspaceId,
      trustedMessageConversationId,
      mode,
      renderReply,
      updateInteraction,
      getRoomOrderBusyDetail,
      requireCurrentRoomOrderMatch,
    } = yield* loadRequiredRoomOrderContext(payload, initialRoomOrder);
    const notTentative = yield* requireTentativePinMode({
      mode,
      payload,
      trustedMessageConversationId,
      updateInteraction,
    });
    if (Option.isSome(notTentative)) {
      return notTentative.value;
    }

    const pinClaimId = `room-order-pin:${payload.messageId}`;
    yield* requireCurrentRoomOrderMatch();
    const pinClaimedRoomOrder = yield* messageRoomOrderService.claimMessageRoomOrderTentativePin(
      payload.messageId,
      pinClaimId,
    );
    yield* requireClaimedRoomOrderMatch(
      payload,
      pinClaimedRoomOrder,
      releaseTentativePinClaim(payload.messageId, pinClaimId, {
        workspaceId: trustedWorkspaceId,
        conversationId: trustedMessageConversationId,
      }),
    );
    if (Option.isSome(pinClaimedRoomOrder.tentativePinnedAt)) {
      const cleanedUp = yield* cleanupTentativePin({
        initialRoomOrder,
        payload,
        pinnedRoomOrder: pinClaimedRoomOrder,
        renderReply,
        trustedWorkspaceId,
        trustedMessageConversationId,
      });
      const detail = cleanedUp
        ? "tentative room order is already pinned."
        : "tentative room order is pinned, but its message still needs cleanup.";
      yield* acknowledgeRoomOrderButton(updateInteraction, detail);
      return roomOrderButtonResult(
        payload,
        trustedMessageConversationId,
        cleanedUp ? "pinned" : "partial",
        detail,
      );
    }
    const unavailableClaim = yield* requireTentativePinClaim({
      getRoomOrderBusyDetail,
      pinClaimId,
      pinClaimedRoomOrder,
      payload,
      trustedMessageConversationId,
      updateInteraction,
    });
    if (Option.isSome(unavailableClaim)) {
      return unavailableClaim.value;
    }

    return yield* publishTentativePin({
      initialRoomOrder,
      pinClaimId,
      payload,
      renderReply,
      trustedWorkspaceId,
      trustedMessageConversationId,
      updateInteraction,
    });
  });

  return { handleRoomOrderPinTentativeButton };
};
