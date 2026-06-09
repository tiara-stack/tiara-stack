import { Effect, Option } from "effect";
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
import { MessageLookup } from "./messageLookup";

type ModernMessageRecord = {
  readonly guildId: Option.Option<string>;
  readonly messageChannelId: Option.Option<string>;
};

type RoomOrderButtonPayload = {
  readonly guildId: string;
  readonly messageId: string;
};

type RegisteredRoomOrderButtonPayload = {
  readonly messageId: string;
};

// fallow-ignore-next-line code-duplication
const getModernMessageGuildId = (record: ModernMessageRecord) =>
  Option.match(record.guildId, {
    onSome: (guildId) =>
      Option.isSome(record.messageChannelId) ? Option.some(guildId) : Option.none(),
    onNone: () => Option.none(),
  });

const missingRoomOrder = () => makeArgumentError(MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE);

const legacyRoomOrderDenied = () =>
  Effect.fail(
    new Unauthorized({ message: "Legacy message room order records are no longer accessible" }),
  );

const getRequiredModernGuildId = (record: ModernMessageRecord) =>
  Option.match(getModernMessageGuildId(record), {
    onSome: Effect.succeed,
    onNone: legacyRoomOrderDenied,
  });

const authorizationError = (cause: unknown) =>
  cause instanceof Unauthorized || cause instanceof ArgumentError
    ? cause
    : makeUnknownError("Failed to authorize message room order", cause);

const requireMonitorGuild = (guildId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    yield* authorization.requireMonitorGuild(guildId);
  });

export const requireRegisteredRoomOrderButton = (payload: RegisteredRoomOrderButtonPayload) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageRoomOrder(payload.messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingRoomOrder());
    }
    const guildId = yield* getRequiredModernGuildId(record.value);
    return yield* requireMonitorGuild(guildId);
  }).pipe(Effect.mapError(authorizationError));

export const requireRoomOrderPinTentativeButton = (payload: RoomOrderButtonPayload) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageRoomOrder(payload.messageId);
    if (Option.isSome(record)) {
      const guildId = yield* getRequiredModernGuildId(record.value);
      return yield* requireMonitorGuild(guildId);
    }

    return yield* requireMonitorGuild(payload.guildId);
  }).pipe(Effect.mapError(authorizationError));

export const roomOrderButtonProxyAuthorizers = {
  [DispatchRoomOrderButtonMethods.previous.endpointName]: requireRegisteredRoomOrderButton,
  [DispatchRoomOrderButtonMethods.next.endpointName]: requireRegisteredRoomOrderButton,
  [DispatchRoomOrderButtonMethods.send.endpointName]: requireRegisteredRoomOrderButton,
  [DispatchRoomOrderButtonMethods.pinTentative.endpointName]: requireRoomOrderPinTentativeButton,
} as const;
