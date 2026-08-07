import { Effect, Option } from "effect";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import type { ClientRef } from "sheet-ingress-api/schemas/client";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import {
  MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE,
  type RoomOrderPinTentativeButtonPayload,
  type RoomOrderPreviousButtonPayload,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchAuthorizationSnapshot, DispatchRequester } from "sheet-ingress-api/internal";
import { makeArgumentError, Unauthorized } from "typhoon-core/error";
import { normalizeDispatchError } from "@/handlers/shared/dispatchError";
import type { RoomOrderButtonPayloadBase } from "@/services/dispatch/domain/roomOrderCommon";
import { decodeTagged } from "@/services/dispatch/persistenceDecoding";

const messageKeyForPayload = (payload: {
  readonly client: ClientRef;
  readonly messageId: string;
}) => ({
  clientPlatform: payload.client.platform,
  clientId: payload.client.clientId,
  messageId: payload.messageId,
});

export const requireCheckinButtonAccess = (
  payload: { readonly client: ClientRef; readonly messageId: string },
  requester: DispatchRequester,
) =>
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    const members = yield* persistence.checkinState
      .getMessageCheckinMembers(messageKeyForPayload(payload))
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
    const persistence = yield* TrustedSheetPersistence;
    return yield* Effect.gen(function* () {
      const roomOrder = yield* persistence.roomOrderState.getMessageRoomOrder(
        messageKeyForPayload(payload),
      );
      const requiredRoomOrder = yield* Option.match(roomOrder, {
        onNone: () =>
          Effect.fail(makeArgumentError(MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE)),
        onSome: Effect.succeed,
      });
      const decoded = yield* decodeTagged(MessageRoomOrder, "MessageRoomOrder", requiredRoomOrder);
      yield* requirePayloadRoomOrderMatch(decoded, payload);
      return decoded;
    }).pipe(Effect.mapError(normalizeDispatchError("Failed to verify room-order button access")));
  });

export const requireRoomOrderPinTentativeButtonAccess = (
  payload: RoomOrderPinTentativeButtonPayload,
) =>
  Effect.gen(function* () {
    const persistence = yield* TrustedSheetPersistence;
    return yield* persistence.roomOrderState
      .getMessageRoomOrder(messageKeyForPayload(payload))
      .pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.succeed(null),
            onSome: (roomOrder) =>
              decodeTagged(MessageRoomOrder, "MessageRoomOrder", roomOrder).pipe(
                Effect.flatMap((decoded) =>
                  requirePayloadRoomOrderMatch(decoded, payload).pipe(Effect.as(decoded)),
                ),
              ),
          }),
        ),
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
    const persistence = yield* TrustedSheetPersistence;
    return yield* Effect.gen(function* () {
      const messageSlot = yield* persistence.slotState.getMessageSlotData(
        messageKeyForPayload(payload),
      );
      const requiredMessageSlot = yield* Option.match(messageSlot, {
        onNone: () => Effect.fail(makeArgumentError("Message slot is not registered")),
        onSome: Effect.succeed,
      });
      const decoded = yield* decodeTagged(MessageSlot, "MessageSlot", requiredMessageSlot);

      if (Option.isNone(decoded.workspaceId) || Option.isNone(decoded.conversationId)) {
        return yield* Effect.fail(
          new Unauthorized({ message: "Legacy message slot records are no longer accessible" }),
        );
      }

      return decoded satisfies MessageSlot;
    }).pipe(Effect.mapError(normalizeDispatchError("Failed to verify slot button access")));
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
