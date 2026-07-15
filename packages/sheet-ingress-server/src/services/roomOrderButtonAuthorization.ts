import { Effect, Option } from "effect";
import { ClientRef } from "sheet-ingress-api/schemas/client";
import {
  MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE,
  DispatchRoomOrderButtonMethods,
} from "sheet-ingress-api/sheet-apis-rpc";
import {
  ArgumentError,
  makeArgumentError,
  makeUnknownError,
  Unauthorized,
} from "typhoon-core/error";
import { AuthorizationService } from "./authorization";
import { requireModernMessageGuildId } from "./messageAuthorization";
import { MessageLookup } from "./messageLookup";

type RoomOrderButtonPayload = {
  readonly workspaceId: string;
  readonly messageId: string;
};

type RegisteredRoomOrderButtonPayload = {
  readonly messageId: string;
};

const missingRoomOrder = () => makeArgumentError(MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE);

const legacyRoomOrderDenied = () =>
  Effect.fail(
    new Unauthorized({ message: "Legacy message room order records are no longer accessible" }),
  );

const authorizationError = (cause: unknown) =>
  cause instanceof Unauthorized || cause instanceof ArgumentError
    ? cause
    : makeUnknownError("Failed to authorize message room order", cause);

const requireMonitorWorkspace = (guildId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    yield* authorization.requireMonitorWorkspace(guildId);
  });

export const requireRegisteredRoomOrderButton = (
  payload: RegisteredRoomOrderButtonPayload,
  clientRef?: ClientRef,
) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageRoomOrder(payload.messageId, clientRef);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingRoomOrder());
    }
    const guildId = yield* requireModernMessageGuildId(record.value, legacyRoomOrderDenied);
    return yield* requireMonitorWorkspace(guildId);
  }).pipe(Effect.mapError(authorizationError));

export const requireRoomOrderPinTentativeButton = (
  payload: RoomOrderButtonPayload,
  clientRef?: ClientRef,
) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageRoomOrder(payload.messageId, clientRef);
    if (Option.isSome(record)) {
      const guildId = yield* requireModernMessageGuildId(record.value, legacyRoomOrderDenied);
      return yield* requireMonitorWorkspace(guildId);
    }

    return yield* requireMonitorWorkspace(payload.workspaceId);
  }).pipe(Effect.mapError(authorizationError));

export const roomOrderButtonProxyAuthorizers = {
  [DispatchRoomOrderButtonMethods.previous.endpointName]: requireRegisteredRoomOrderButton,
  [DispatchRoomOrderButtonMethods.next.endpointName]: requireRegisteredRoomOrderButton,
  [DispatchRoomOrderButtonMethods.send.endpointName]: requireRegisteredRoomOrderButton,
  [DispatchRoomOrderButtonMethods.pinTentative.endpointName]: requireRoomOrderPinTentativeButton,
} as const;
