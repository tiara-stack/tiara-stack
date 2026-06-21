import { Cache, Context, Duration, Effect, Exit, Layer, Option, Predicate } from "effect";
import { MessageCheckin, MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import { MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE } from "sheet-ingress-api/sheet-apis-rpc";
import { SheetApisForwardingClient } from "./sheetApisForwardingClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const isMissingMessageRoomOrderError = (error: unknown) =>
  Predicate.isTagged("ArgumentError")(error) &&
  Predicate.hasProperty(error, "message") &&
  error.message === MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE;

const defaultMessageKey = (messageId: string) => ({
  clientPlatform: "discord" as const,
  clientId: "discord-main",
  messageId,
});

export class MessageLookup extends Context.Service<MessageLookup>()("MessageLookup", {
  make: Effect.gen(function* () {
    const sheetApisForwardingClient = yield* SheetApisForwardingClient;
    const sheetApisRpcTokens = yield* SheetApisRpcTokens;
    const cacheOptions = {
      capacity: 1_000,
      timeToLive: Exit.match({
        onFailure: () => Duration.seconds(1),
        onSuccess: () => Duration.seconds(5),
      }),
    };

    const messageCheckinDataCache = yield* Cache.makeWith<
      string,
      Option.Option<MessageCheckin>,
      unknown
    >(
      (messageId) =>
        sheetApisRpcTokens.withServiceUser(
          sheetApisForwardingClient.messageCheckin
            .getMessageCheckinData({ query: defaultMessageKey(messageId) })
            .pipe(Effect.option),
        ),
      cacheOptions,
    );
    const messageCheckinMembersCache = yield* Cache.makeWith<
      string,
      ReadonlyArray<MessageCheckinMember>,
      unknown
    >(
      (messageId) =>
        sheetApisRpcTokens.withServiceUser(
          sheetApisForwardingClient.messageCheckin.getMessageCheckinMembers({
            query: defaultMessageKey(messageId),
          }),
        ),
      cacheOptions,
    );
    const messageRoomOrderCache = yield* Cache.makeWith<
      string,
      Option.Option<MessageRoomOrder>,
      unknown
    >(
      (messageId) =>
        sheetApisRpcTokens.withServiceUser(
          sheetApisForwardingClient.messageRoomOrder
            .getMessageRoomOrder({ query: defaultMessageKey(messageId) })
            .pipe(
              Effect.map(Option.some),
              Effect.catch((error) =>
                isMissingMessageRoomOrderError(error)
                  ? Effect.succeed(Option.none())
                  : Effect.fail(error),
              ),
            ),
        ),
      cacheOptions,
    );
    const messageSlotDataCache = yield* Cache.makeWith<string, Option.Option<MessageSlot>, unknown>(
      (messageId) =>
        sheetApisRpcTokens.withServiceUser(
          sheetApisForwardingClient.messageSlot
            .getMessageSlotData({ query: defaultMessageKey(messageId) })
            .pipe(Effect.option),
        ),
      cacheOptions,
    );

    return {
      getMessageCheckinData: Effect.fn("MessageLookup.getMessageCheckinData")(function* (
        messageId: string,
      ) {
        return yield* Cache.get(messageCheckinDataCache, messageId);
      }),
      getMessageCheckinMembers: Effect.fn("MessageLookup.getMessageCheckinMembers")(function* (
        messageId: string,
      ) {
        return yield* Cache.get(messageCheckinMembersCache, messageId);
      }),
      getMessageRoomOrder: Effect.fn("MessageLookup.getMessageRoomOrder")(function* (
        messageId: string,
      ) {
        return yield* Cache.get(messageRoomOrderCache, messageId);
      }),
      getMessageSlotData: Effect.fn("MessageLookup.getMessageSlotData")(function* (
        messageId: string,
      ) {
        return yield* Cache.get(messageSlotDataCache, messageId);
      }),
    } satisfies {
      readonly getMessageCheckinData: (
        messageId: string,
      ) => Effect.Effect<Option.Option<MessageCheckin>, unknown>;
      readonly getMessageCheckinMembers: (
        messageId: string,
      ) => Effect.Effect<ReadonlyArray<MessageCheckinMember>, unknown>;
      readonly getMessageRoomOrder: (
        messageId: string,
      ) => Effect.Effect<Option.Option<MessageRoomOrder>, unknown>;
      readonly getMessageSlotData: (
        messageId: string,
      ) => Effect.Effect<Option.Option<MessageSlot>, unknown>;
    };
  }),
}) {
  static layer = Layer.effect(MessageLookup, this.make).pipe(
    Layer.provide([SheetApisForwardingClient.layer, SheetApisRpcTokens.layer]),
  );
}
