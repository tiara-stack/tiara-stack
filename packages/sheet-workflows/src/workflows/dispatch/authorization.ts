import { Effect, Option, Predicate } from "effect";
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import type { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import {
  MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE,
  type RoomOrderPinTentativeButtonPayload,
  type RoomOrderPreviousButtonPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchAuthorizationSnapshot, DispatchRequester } from "sheet-ingress-api/internal";
import { Unauthorized } from "typhoon-core/error";
import { normalizeDispatchError } from "@/handlers/shared/dispatchError";
import { SheetApisClient } from "@/services";
import type { RoomOrderButtonPayloadBase } from "@/services/dispatch/domain/roomOrderCommon";

const messageKeyForPayload = (payload: {
  readonly client: ClientRef;
  readonly messageId: string;
}) => ({
  clientPlatform: payload.client.platform,
  clientId: payload.client.clientId,
  messageId: payload.messageId,
});

const isMissingMessageRoomOrderError = (error: unknown) =>
  Predicate.isTagged("ArgumentError")(error) &&
  Predicate.hasProperty(error, "message") &&
  error.message === MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE;

export const requireCheckinButtonAccess = (
  payload: { readonly client: ClientRef; readonly messageId: string },
  requester: DispatchRequester,
) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    const members = yield* sheetApis.messageCheckin
      .getMessageCheckinMembers({
        query: messageKeyForPayload(payload),
      })
      .pipe(Effect.mapError(normalizeDispatchError("Failed to verify check-in button access")));

    if (members.some((member) => member.memberId === requester.accountId)) {
      return;
    }

    return yield* Effect.fail(
      new Unauthorized({ message: "User is not a recorded participant on this check-in message" }),
    );
  });

const requirePayloadRoomOrderMatch = (
  roomOrder: MessageRoomOrder,
  payload: RoomOrderButtonPayloadBase,
) =>
  Effect.gen(function* () {
    if (Option.isNone(roomOrder.workspaceId) || Option.isNone(roomOrder.conversationId)) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Legacy message room order records are no longer accessible" }),
      );
    }

    if (
      roomOrder.workspaceId.value !== payload.workspaceId ||
      roomOrder.conversationId.value !== payload.messageConversationId
    ) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Room-order message authorization changed" }),
      );
    }
  });

export const requireRegisteredRoomOrderButtonAccess = (payload: RoomOrderPreviousButtonPayload) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    const roomOrder = yield* sheetApis.messageRoomOrder
      .getMessageRoomOrder({
        query: messageKeyForPayload(payload),
      })
      .pipe(Effect.mapError(normalizeDispatchError("Failed to verify room-order button access")));
    yield* requirePayloadRoomOrderMatch(roomOrder, payload);
    return roomOrder;
  });

export const requireRoomOrderPinTentativeButtonAccess = (
  payload: RoomOrderPinTentativeButtonPayload,
) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    return yield* sheetApis.messageRoomOrder
      .getMessageRoomOrder({
        query: messageKeyForPayload(payload),
      })
      .pipe(
        Effect.flatMap((roomOrder) =>
          requirePayloadRoomOrderMatch(roomOrder, payload).pipe(Effect.as(roomOrder)),
        ),
        Effect.catchIf(isMissingMessageRoomOrderError, () => Effect.succeed(null)),
        Effect.mapError(
          normalizeDispatchError("Failed to verify tentative room-order button access"),
        ),
      );
  });

export const requireSlotOpenButtonAccess = (payload: {
  readonly client: ClientRef;
  readonly messageId: string;
}) =>
  Effect.gen(function* () {
    const sheetApis = (yield* SheetApisClient).get();
    const messageSlot = yield* sheetApis.messageSlot
      .getMessageSlotData({
        query: messageKeyForPayload(payload),
      })
      .pipe(Effect.mapError(normalizeDispatchError("Failed to verify slot button access")));

    if (Option.isNone(messageSlot.workspaceId) || Option.isNone(messageSlot.conversationId)) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Legacy message slot records are no longer accessible" }),
      );
    }

    return messageSlot satisfies MessageSlot;
  });

export const requireAuthorizedWorkspace = (
  authorization: DispatchAuthorizationSnapshot | undefined,
  workspaceId: string,
  scope: DispatchAuthorizationSnapshot["scope"],
) =>
  Effect.gen(function* () {
    if (authorization?.workspaceId === workspaceId && authorization.scope === scope) {
      return;
    }

    return yield* Effect.fail(
      new Unauthorized({
        message: `Dispatch requester is not authorized to ${scope} workspace ${workspaceId}`,
      }),
    );
  });

export const requireSelfOrAuthorizedWorkspace = (
  request: {
    readonly requester: DispatchRequester;
    readonly authorization?: DispatchAuthorizationSnapshot | undefined;
    readonly payload: {
      readonly workspaceId: string;
      readonly targetUserId: string;
    };
  },
  scope: DispatchAuthorizationSnapshot["scope"],
) =>
  request.requester.accountId === request.payload.targetUserId
    ? Effect.void
    : requireAuthorizedWorkspace(request.authorization, request.payload.workspaceId, scope);
