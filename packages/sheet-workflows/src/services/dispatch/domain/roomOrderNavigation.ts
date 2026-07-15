import { Cause, Effect, Option, Random } from "effect";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type { RoomOrderButtonResult } from "sheet-ingress-api/sheet-apis-rpc";
import { makeUnknownError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { recoverNonInterruptCause } from "../pure/failure";
import {
  ignoreInteractionUpdateFailure,
  releaseRoomOrderClaim,
  type MessagePayload,
  type MessageRoomOrderService,
  type RoomOrderCommon,
  type RoomOrderButtonMode,
  type RoomOrderButtonPayloadBase,
} from "./roomOrderCommon";

type RoomOrderRankDirection = "previous" | "next";
type RankMutation = (
  messageId: string,
  payload: { readonly expectedRank: number; readonly tentativeUpdateClaimId: string },
) => ReturnType<MessageRoomOrderService["incrementMessageRoomOrderRank"]>;

export const makeRoomOrderNavigation = ({
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
    roomOrderButtonResult,
  } = common;

  const rankDirections = {
    previous: {
      delta: -1,
      rollbackDelta: 1,
      apply: messageRoomOrderService.decrementMessageRoomOrderRank,
      rollback: messageRoomOrderService.incrementMessageRoomOrderRank,
    },
    next: {
      delta: 1,
      rollbackDelta: -1,
      apply: messageRoomOrderService.incrementMessageRoomOrderRank,
      rollback: messageRoomOrderService.decrementMessageRoomOrderRank,
    },
  } satisfies Record<
    RoomOrderRankDirection,
    {
      readonly delta: number;
      readonly rollbackDelta: number;
      readonly apply: RankMutation;
      readonly rollback: RankMutation;
    }
  >;

  const releaseTentativeUpdateClaim = (messageId: string, updateClaimId: string) =>
    releaseRoomOrderClaim(
      messageRoomOrderService.releaseMessageRoomOrderTentativeUpdateClaim(messageId, updateClaimId),
      (cause) =>
        makeUnknownError(
          "Failed to release tentative room-order update claim; claim preserved for recovery",
          Cause.pretty(cause),
        ),
    );

  const rollbackRoomOrderRankUpdate = (
    payload: RoomOrderButtonPayloadBase,
    updateClaimId: string,
    updatedRank: MessageRoomOrder,
    direction: RoomOrderRankDirection,
    updateInteraction: (content: string) => Effect.Effect<unknown, unknown>,
    cause: Cause.Cause<unknown>,
  ) => {
    const rankDirection = rankDirections[direction];
    const rollback = rankDirection.rollback(payload.messageId, {
      expectedRank: updatedRank.rank,
      tentativeUpdateClaimId: updateClaimId,
    });
    const expectedRank = updatedRank.rank + rankDirection.rollbackDelta;

    return rollback.pipe(
      Effect.catchCause((rollbackCause) =>
        recoverNonInterruptCause(rollbackCause, () =>
          Effect.logError("Failed to roll back room-order rank update").pipe(
            Effect.annotateLogs({ messageId: payload.messageId, updateClaimId }),
            Effect.andThen(Effect.logError(cause)),
            Effect.andThen(
              Effect.fail(
                makeUnknownError(
                  "Failed to roll back room-order rank update; update claim preserved",
                  rollbackCause,
                ),
              ),
            ),
          ),
        ),
      ),
      Effect.filterOrFail(
        (rolledBack) =>
          rolledBack.rank === expectedRank &&
          Option.contains(rolledBack.tentativeUpdateClaimId, updateClaimId),
        (rolledBack) =>
          makeUnknownError(
            "Room-order rank rollback could not be verified; update claim preserved",
            { expectedRank, rolledBackRank: rolledBack.rank, updateClaimId },
          ),
      ),
      Effect.andThen(releaseTentativeUpdateClaim(payload.messageId, updateClaimId)),
      Effect.andThen(
        ignoreInteractionUpdateFailure(updateInteraction("room order could not be updated.")),
      ),
      Effect.andThen(
        Effect.fail(
          markInteractionFailureHandled(
            makeUnknownError("Failed to update room-order button interaction", cause),
          ),
        ),
      ),
    );
  };

  const requireTentativeUpdateClaim = Effect.fn("DispatchService.requireTentativeUpdateClaim")(
    function* ({
      claimedRoomOrder,
      getRoomOrderBusyDetail,
      messageConversationId,
      payload,
      updateClaimId,
      updateInteraction,
    }: {
      readonly claimedRoomOrder: MessageRoomOrder;
      readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
      readonly messageConversationId: string;
      readonly payload: RoomOrderButtonPayloadBase;
      readonly updateClaimId: string;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      if (
        Option.isSome(claimedRoomOrder.tentativePinnedAt) ||
        Option.isSome(claimedRoomOrder.tentativePinClaimId) ||
        !Option.contains(claimedRoomOrder.tentativeUpdateClaimId, updateClaimId)
      ) {
        return Option.some(
          yield* denyRoomOrderButton({
            detail: getRoomOrderBusyDetail(claimedRoomOrder),
            messageConversationId,
            payload,
            updateInteraction,
          }),
        );
      }

      return Option.none<RoomOrderButtonResult>();
    },
  );

  const resolveUnexpectedRoomOrderRankUpdate = Effect.fn(
    "DispatchService.resolveUnexpectedRoomOrderRankUpdate",
  )(function* ({
    expectedRank,
    getRoomOrderBusyDetail,
    initialRoomOrder,
    messageConversationId,
    payload,
    updatedRank,
    updateClaimId,
    updateInteraction,
  }: {
    readonly expectedRank: number;
    readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
    readonly initialRoomOrder: MessageRoomOrder;
    readonly messageConversationId: string;
    readonly payload: RoomOrderButtonPayloadBase;
    readonly updatedRank: MessageRoomOrder;
    readonly updateClaimId: string;
    readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
  }) {
    const ownsUpdateClaim = Option.contains(updatedRank.tentativeUpdateClaimId, updateClaimId);
    if (ownsUpdateClaim && updatedRank.rank !== initialRoomOrder.rank) {
      return yield* Effect.fail(
        makeUnknownError(
          "Room-order rank update returned an ambiguous persisted state; update claim preserved",
          {
            initialRank: initialRoomOrder.rank,
            expectedRank,
            updatedRank: updatedRank.rank,
            updateClaimId,
          },
        ),
      );
    }

    const detail =
      Option.isSome(updatedRank.sendClaimId) ||
      Option.isSome(updatedRank.tentativeUpdateClaimId) ||
      Option.isSome(updatedRank.tentativePinnedAt) ||
      Option.isSome(updatedRank.tentativePinClaimId)
        ? getRoomOrderBusyDetail(updatedRank)
        : "room order could not be updated.";
    if (ownsUpdateClaim) {
      yield* releaseTentativeUpdateClaim(payload.messageId, updateClaimId);
    }
    return {
      _tag: "denied" as const,
      result: yield* denyRoomOrderButton({
        detail,
        messageConversationId,
        payload,
        updateInteraction,
      }),
    };
  });

  const updateRoomOrderRank = Effect.fn("DispatchService.updateRoomOrderRank")(function* ({
    direction,
    getRoomOrderBusyDetail,
    initialRoomOrder,
    messageConversationId,
    payload,
    updateClaimId,
    updateInteraction,
  }: {
    readonly direction: RoomOrderRankDirection;
    readonly getRoomOrderBusyDetail: (roomOrder: MessageRoomOrder) => string;
    readonly initialRoomOrder: MessageRoomOrder;
    readonly messageConversationId: string;
    readonly payload: RoomOrderButtonPayloadBase;
    readonly updateClaimId: string;
    readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
  }) {
    const rankDirection = rankDirections[direction];
    const expectedRank = initialRoomOrder.rank + rankDirection.delta;
    const updatedRank = yield* rankDirection
      .apply(payload.messageId, {
        expectedRank: initialRoomOrder.rank,
        tentativeUpdateClaimId: updateClaimId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          recoverNonInterruptCause(cause, () =>
            messageRoomOrderService.getMessageRoomOrder(payload.messageId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      makeUnknownError(
                        "Room-order rank update could not be reconciled; update claim preserved for recovery",
                        Cause.pretty(cause),
                      ),
                    ),
                  onSome: (currentRoomOrder) => {
                    const ownsUpdateClaim = Option.contains(
                      currentRoomOrder.tentativeUpdateClaimId,
                      updateClaimId,
                    );
                    if (ownsUpdateClaim && currentRoomOrder.rank === expectedRank) {
                      return Effect.succeed(currentRoomOrder);
                    }
                    if (ownsUpdateClaim && currentRoomOrder.rank === initialRoomOrder.rank) {
                      return releaseTentativeUpdateClaim(payload.messageId, updateClaimId).pipe(
                        Effect.andThen(Effect.failCause(cause)),
                      );
                    }
                    return Effect.fail(
                      makeUnknownError(
                        "Room-order rank update has an ambiguous persisted state; update claim preserved for recovery",
                        Cause.pretty(cause),
                      ),
                    );
                  },
                }),
              ),
            ),
          ),
        ),
      );
    if (
      updatedRank.rank === expectedRank &&
      Option.contains(updatedRank.tentativeUpdateClaimId, updateClaimId)
    ) {
      return { _tag: "updated" as const, roomOrder: updatedRank };
    }
    return yield* resolveUnexpectedRoomOrderRankUpdate({
      expectedRank,
      getRoomOrderBusyDetail,
      initialRoomOrder,
      messageConversationId,
      payload,
      updatedRank,
      updateClaimId,
      updateInteraction,
    });
  });

  const publishRoomOrderRankUpdate = Effect.fn("DispatchService.publishRoomOrderRankUpdate")(
    function* ({
      direction,
      interactionResponseType,
      messageConversationId,
      mode,
      payload,
      renderReply,
      updateClaimId,
      updatedRank,
      updateInteraction,
    }: {
      readonly direction: RoomOrderRankDirection;
      readonly interactionResponseType: "reply" | "update";
      readonly messageConversationId: string;
      readonly mode: RoomOrderButtonMode;
      readonly payload: RoomOrderButtonPayloadBase;
      readonly renderReply: (roomOrder: MessageRoomOrder) => Effect.Effect<MessagePayload, unknown>;
      readonly updateClaimId: string;
      readonly updatedRank: MessageRoomOrder;
      readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
    }) {
      const rollback = (cause: Cause.Cause<unknown>): Effect.Effect<never, unknown, never> => {
        return recoverNonInterruptCause(cause, () =>
          rollbackRoomOrderRankUpdate(
            payload,
            updateClaimId,
            updatedRank,
            direction,
            updateInteraction,
            cause,
          ),
        );
      };
      const preserveAmbiguousPublication = (cause: Cause.Cause<unknown>) =>
        recoverNonInterruptCause(cause, () =>
          Effect.fail(
            makeUnknownError(
              "Room-order message update could not be confirmed; update claim preserved",
              Cause.pretty(cause),
            ),
          ),
        );
      const reply = yield* renderReply(updatedRank).pipe(Effect.catchCause(rollback));

      if (mode === "tentative" || interactionResponseType === "reply") {
        yield* botClient
          .updateMessage(messageConversationId, payload.messageId, reply)
          .pipe(Effect.catchCause(preserveAmbiguousPublication));
        yield* releaseTentativeUpdateClaim(payload.messageId, updateClaimId);
        yield* acknowledgeRoomOrderButton(
          updateInteraction,
          mode === "tentative" ? "updated tentative room order." : "updated room order.",
        );
        return;
      }

      yield* botClient
        .updateOriginalInteractionResponse(payload.interactionResponseToken, reply)
        .pipe(Effect.catchCause(preserveAmbiguousPublication));
      yield* releaseTentativeUpdateClaim(payload.messageId, updateClaimId);
    },
  );

  const handleRoomOrderRankButton = Effect.fn("DispatchService.handleRoomOrderRankButton")(
    function* (
      payload: RoomOrderButtonPayloadBase,
      authorizedRoomOrder: MessageRoomOrder | undefined,
      direction: RoomOrderRankDirection,
    ) {
      yield* Effect.annotateCurrentSpan({
        workspaceId: payload.workspaceId,
        conversationId: payload.messageConversationId,
        messageId: payload.messageId,
        direction,
      });
      const maybeInitialRoomOrder = yield* loadInitialRoomOrder(payload, authorizedRoomOrder);
      const initialRoomOrder = yield* requireInitialRoomOrder(payload, maybeInitialRoomOrder);
      const {
        trustedMessageConversationId,
        mode,
        interactionResponseType,
        renderReply,
        updateInteraction,
        getRoomOrderBusyDetail,
        requireCurrentRoomOrderMatch,
      } = yield* loadRequiredRoomOrderContext(payload, initialRoomOrder);
      if (mode === "tentative" && Option.isSome(initialRoomOrder.tentativePinnedAt)) {
        return yield* denyRoomOrderButton({
          detail: "tentative room order is already pinned.",
          messageConversationId: trustedMessageConversationId,
          payload,
          updateInteraction,
        });
      }

      yield* requireCurrentRoomOrderMatch();
      const updateClaimId = `room-order-update:${yield* Random.nextUUIDv4}`;
      const claimedRoomOrder = yield* messageRoomOrderService.claimMessageRoomOrderTentativeUpdate(
        payload.messageId,
        updateClaimId,
      );
      yield* requireClaimedRoomOrderMatch(
        payload,
        claimedRoomOrder,
        messageRoomOrderService.releaseMessageRoomOrderTentativeUpdateClaim(
          payload.messageId,
          updateClaimId,
        ),
      );
      const unavailableClaim = yield* requireTentativeUpdateClaim({
        claimedRoomOrder,
        getRoomOrderBusyDetail,
        messageConversationId: trustedMessageConversationId,
        payload,
        updateClaimId,
        updateInteraction,
      });
      if (Option.isSome(unavailableClaim)) {
        return unavailableClaim.value;
      }

      const rankUpdate = yield* updateRoomOrderRank({
        direction,
        getRoomOrderBusyDetail,
        initialRoomOrder: claimedRoomOrder,
        messageConversationId: trustedMessageConversationId,
        payload,
        updateClaimId,
        updateInteraction,
      });
      if (rankUpdate._tag === "denied") {
        return rankUpdate.result;
      }

      yield* publishRoomOrderRankUpdate({
        direction,
        interactionResponseType,
        messageConversationId: trustedMessageConversationId,
        mode,
        payload,
        renderReply,
        updateClaimId,
        updatedRank: rankUpdate.roomOrder,
        updateInteraction,
      });

      return roomOrderButtonResult(payload, trustedMessageConversationId, "updated", null);
    },
  );

  return { handleRoomOrderRankButton };
};
