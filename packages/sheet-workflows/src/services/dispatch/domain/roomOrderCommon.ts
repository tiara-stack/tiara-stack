import { Cause, Effect, Option, Predicate } from "effect";
import { hasTentativeRoomOrderPrefix } from "sheet-ingress-api/clientActions";
import type {
  SheetMessageComponent,
  SheetOutboundMessage,
  SheetTextPart,
} from "sheet-ingress-api/schemas/client";
import type { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type {
  RoomOrderButtonResult,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPreviousButtonPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import { makeArgumentError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { makeSheetApisServices } from "../clients/sheetApis";
import { compensateDeliveryFailure, logNonInterruptFailure } from "../clients/messageDelivery";
import { recoverNonInterruptCause } from "../pure/failure";
import { claimRetrySchedule } from "../pure/retry";

export type MessagePayload = SheetOutboundMessage & {
  readonly content: ReadonlyArray<SheetTextPart>;
};
export type RoomOrderButtonPayloadBase = Pick<
  RoomOrderPreviousButtonPayload,
  | "workspaceId"
  | "messageId"
  | "messageConversationId"
  | "interactionResponseToken"
  | "messageContent"
  | "interactionResponseType"
>;

export const releaseRoomOrderClaim = <A, E, E2>(
  release: Effect.Effect<A, E, never>,
  mapReleaseFailure: (cause: Cause.Cause<E>) => E2,
): Effect.Effect<A, E | E2, never> =>
  release.pipe(
    Effect.retry(claimRetrySchedule),
    Effect.catchCause((cause) =>
      recoverNonInterruptCause(cause, () => Effect.fail(mapReleaseFailure(cause))),
    ),
  );

export const ignoreInteractionUpdateFailure = <A, R>(effect: Effect.Effect<A, unknown, R>) =>
  effect.pipe(Effect.catchCause((cause) => recoverNonInterruptCause(cause, () => Effect.void)));

export type RoomOrderButtonMode = "normal" | "tentative";
type RoomOrderServices = ReturnType<typeof makeSheetApisServices>;
export type MessageRoomOrderService = RoomOrderServices["messageRoomOrderService"];

export type RoomOrderHelperDependencies = {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly messageRoomOrderService: RoomOrderServices["messageRoomOrderService"];
  readonly renderRoomOrderReply: (params: {
    readonly workspaceId: string;
    readonly messageId: string;
    readonly mode: "normal" | "tentative";
    readonly roomOrder: MessageRoomOrder;
    readonly sheetService: RoomOrderServices["sheetService"];
    readonly messageRoomOrderService: RoomOrderServices["messageRoomOrderService"];
  }) => Effect.Effect<MessagePayload, unknown, never>;
  readonly sheetService: RoomOrderServices["sheetService"];
  readonly workspaceConfigService: RoomOrderServices["workspaceConfigService"];
};

export const makeRoomOrderCommon = ({
  botClient,
  messageRoomOrderService,
  renderRoomOrderReply,
  sheetService,
  workspaceConfigService,
}: RoomOrderHelperDependencies) => {
  const failRoomOrderInteraction = (
    payload: RoomOrderButtonPayloadBase,
    content: string,
    errorMessage: string,
  ) =>
    botClient
      .updateOriginalInteractionResponse(payload.interactionResponseToken, {
        content,
        components: [],
      })
      .pipe(
        Effect.andThen(Effect.fail(markInteractionFailureHandled(makeArgumentError(errorMessage)))),
      );

  const requireRoomOrderMatch = (
    payload: RoomOrderButtonPayloadBase,
    roomOrder: MessageRoomOrder,
  ) =>
    Effect.gen(function* () {
      if (
        !Option.contains(roomOrder.workspaceId, payload.workspaceId) ||
        !Option.contains(roomOrder.conversationId, payload.messageConversationId)
      ) {
        return yield* failRoomOrderInteraction(
          payload,
          "This room-order message authorization changed.",
          "Cannot handle room-order button, authorization changed",
        );
      }
    });

  const requireClaimedRoomOrderMatch = (
    payload: RoomOrderButtonPayloadBase,
    roomOrder: MessageRoomOrder,
    releaseClaim: Effect.Effect<unknown, unknown, never>,
  ) =>
    requireRoomOrderMatch(payload, roomOrder).pipe(
      Effect.catchCause((cause) =>
        compensateDeliveryFailure(cause, releaseClaim).pipe(
          Effect.annotateLogs({ messageId: payload.messageId }),
        ),
      ),
    );

  const loadInitialRoomOrder = Effect.fn("DispatchService.loadInitialRoomOrder")(function* (
    payload: RoomOrderButtonPayloadBase,
    authorizedRoomOrder?: MessageRoomOrder | null,
  ) {
    return Predicate.isNullish(authorizedRoomOrder)
      ? yield* messageRoomOrderService.getMessageRoomOrder(payload.messageId)
      : Option.some(authorizedRoomOrder);
  });

  const handleFallbackTentativePin = Effect.fn(
    "DispatchService.roomOrderPinTentativeButton.handleFallbackTentativePin",
  )(function* (payload: RoomOrderPinTentativeButtonPayload) {
    const fallbackConversation = yield* workspaceConfigService.getWorkspaceConversationById({
      workspaceId: payload.workspaceId,
      conversationId: payload.messageConversationId,
      running: true,
    });
    if (Option.isNone(fallbackConversation)) {
      yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
        content: "This conversation is not a registered running conversation.",
        components: [],
      });
      return yield* Effect.fail(
        markInteractionFailureHandled(
          makeArgumentError(
            "Cannot handle room-order button, message conversation is not a registered running conversation",
          ),
        ),
      );
    }

    const pinned = yield* botClient
      .createPin(payload.messageConversationId, payload.messageId)
      .pipe(
        Effect.as(true),
        logNonInterruptFailure(
          "Failed to pin fallback tentative room order",
          {
            workspaceId: payload.workspaceId,
            conversationId: payload.messageConversationId,
            messageId: payload.messageId,
          },
          Effect.succeed(false),
        ),
      );

    // A transport failure from createPin is ambiguous: the remote pin may have
    // succeeded. Always remove the controls so an untracked pinned message
    // cannot remain actionable.
    const cleanedUp = yield* botClient
      .updateMessage(payload.messageConversationId, payload.messageId, {
        components: [],
      })
      .pipe(
        Effect.as(true),
        logNonInterruptFailure(
          "Failed to clean up fallback tentative room order",
          {
            workspaceId: payload.workspaceId,
            conversationId: payload.messageConversationId,
            messageId: payload.messageId,
          },
          Effect.succeed(false),
        ),
      );

    const detail = pinned
      ? cleanedUp
        ? "pinned tentative room order!"
        : "pinned tentative room order, but failed to clean up the message."
      : cleanedUp
        ? "tentative room-order pin could not be confirmed; message controls were removed."
        : "tentative room order could not be pinned or cleaned up.";
    yield* botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
      content: detail,
      components: [],
    });

    return {
      messageId: payload.messageId,
      messageConversationId: payload.messageConversationId,
      status: pinned ? (cleanedUp ? "pinned" : "partial") : cleanedUp ? "partial" : "failed",
      detail,
    } satisfies RoomOrderButtonResult;
  });

  const loadRequiredRoomOrderContext = Effect.fn("DispatchService.loadRequiredRoomOrderContext")(
    function* (payload: RoomOrderButtonPayloadBase, initialRoomOrder: MessageRoomOrder) {
      const trustedWorkspaceId = yield* Option.match(initialRoomOrder.workspaceId, {
        onSome: Effect.succeed,
        onNone: () =>
          failRoomOrderInteraction(
            payload,
            "This room-order message workspace is not registered.",
            "Cannot handle room-order button, message workspace is not registered",
          ),
      });
      const trustedMessageConversationId = yield* Option.match(initialRoomOrder.conversationId, {
        onSome: Effect.succeed,
        onNone: () =>
          failRoomOrderInteraction(
            payload,
            "This room-order message conversation is not registered.",
            "Cannot handle room-order button, message conversation is not registered",
          ),
      });
      yield* requireRoomOrderMatch(payload, initialRoomOrder);
      const messageHasTentativePrefix = hasTentativeRoomOrderPrefix(payload.messageContent ?? "");
      const effectiveInitialRoomOrder =
        !initialRoomOrder.tentative && messageHasTentativePrefix
          ? yield* messageRoomOrderService.markMessageRoomOrderTentative(payload.messageId).pipe(
              logNonInterruptFailure(
                "Failed to repair legacy tentative room-order flag",
                {
                  workspaceId: trustedWorkspaceId,
                  messageId: payload.messageId,
                  conversationId: trustedMessageConversationId,
                },
                Effect.succeed(initialRoomOrder),
              ),
            )
          : initialRoomOrder;
      const mode: RoomOrderButtonMode =
        effectiveInitialRoomOrder.tentative || messageHasTentativePrefix ? "tentative" : "normal";
      const interactionResponseType =
        payload.interactionResponseType ?? (mode === "tentative" ? "reply" : "update");
      const renderReply = (roomOrder: MessageRoomOrder, replyMode: "normal" | "tentative" = mode) =>
        renderRoomOrderReply({
          workspaceId: trustedWorkspaceId,
          messageId: payload.messageId,
          mode: replyMode,
          roomOrder,
          sheetService,
          messageRoomOrderService,
        });

      const updateInteraction = (
        content: string,
        components: ReadonlyArray<SheetMessageComponent> = [],
      ) =>
        botClient.updateOriginalInteractionResponse(payload.interactionResponseToken, {
          content,
          components,
        });

      const getRoomOrderBusyDetail = (roomOrder: MessageRoomOrder) => {
        if (Option.isSome(roomOrder.sendClaimId)) {
          return "room order is already being sent.";
        }
        if (Option.isSome(roomOrder.tentativeUpdateClaimId)) {
          return "tentative room order is already being updated.";
        }
        if (Option.isSome(roomOrder.tentativePinnedAt)) {
          return "tentative room order is already pinned.";
        }
        if (Option.isSome(roomOrder.tentativePinClaimId)) {
          return "tentative room order is already being pinned.";
        }
        return "room order is temporarily unavailable.";
      };

      const requireCurrentRoomOrderMatch = () =>
        Effect.gen(function* () {
          const maybeCurrentRoomOrder = yield* messageRoomOrderService.getMessageRoomOrder(
            payload.messageId,
          );
          const currentRoomOrder = yield* Option.match(maybeCurrentRoomOrder, {
            onSome: Effect.succeed,
            onNone: () =>
              failRoomOrderInteraction(
                payload,
                "This room-order message is not registered.",
                "Cannot handle room-order button, message is not registered",
              ),
          });
          yield* requireRoomOrderMatch(payload, currentRoomOrder);
          return currentRoomOrder;
        });

      return {
        initialRoomOrder,
        trustedWorkspaceId,
        trustedMessageConversationId,
        mode,
        interactionResponseType,
        renderReply,
        updateInteraction,
        getRoomOrderBusyDetail,
        requireCurrentRoomOrderMatch,
      };
    },
  );

  const requireInitialRoomOrder = (
    payload: RoomOrderButtonPayloadBase,
    maybeInitialRoomOrder: Option.Option<MessageRoomOrder>,
  ) =>
    Option.match(maybeInitialRoomOrder, {
      onSome: Effect.succeed,
      onNone: () =>
        botClient
          .updateOriginalInteractionResponse(payload.interactionResponseToken, {
            content: "This room-order message is not registered.",
            components: [],
          })
          .pipe(
            Effect.andThen(
              Effect.fail(
                markInteractionFailureHandled(
                  makeArgumentError("Cannot handle room-order button, message is not registered"),
                ),
              ),
            ),
          ),
    });

  const roomOrderButtonResult = (
    payload: RoomOrderButtonPayloadBase,
    messageConversationId: string,
    status: RoomOrderButtonResult["status"],
    detail: string | null,
  ) =>
    ({
      messageId: payload.messageId,
      messageConversationId,
      status,
      detail,
    }) satisfies RoomOrderButtonResult;

  const denyRoomOrderButton = Effect.fn("DispatchService.denyRoomOrderButton")(function* ({
    detail,
    messageConversationId,
    payload,
    updateInteraction,
  }: {
    readonly detail: string;
    readonly messageConversationId: string;
    readonly payload: RoomOrderButtonPayloadBase;
    readonly updateInteraction: (content: string) => Effect.Effect<unknown, unknown>;
  }) {
    yield* updateInteraction(detail);
    return roomOrderButtonResult(payload, messageConversationId, "denied", detail);
  });

  const acknowledgeRoomOrderButton = (
    updateInteraction: (content: string) => Effect.Effect<unknown, unknown>,
    content: string,
  ) =>
    updateInteraction(content).pipe(
      logNonInterruptFailure("Failed to update room-order button acknowledgement", {}, Effect.void),
    );

  return {
    acknowledgeRoomOrderButton,
    denyRoomOrderButton,
    failRoomOrderInteraction,
    handleFallbackTentativePin,
    loadInitialRoomOrder,
    loadRequiredRoomOrderContext,
    requireClaimedRoomOrderMatch,
    requireInitialRoomOrder,
    roomOrderButtonResult,
  };
};

export type RoomOrderCommon = ReturnType<typeof makeRoomOrderCommon>;
