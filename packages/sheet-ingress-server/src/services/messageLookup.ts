import { Cache, Context, Duration, Effect, Exit, Layer, Option, Predicate } from "effect";
import { ClientRef } from "sheet-ingress-api/schemas/client";
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

const defaultClientRef: ClientRef = {
  platform: "discord",
  clientId: "discord-main",
};

const parseCacheKey = (cacheKey: string): { clientRef: ClientRef; messageId: string } => {
  const lastColonIndex = cacheKey.lastIndexOf(":");
  if (lastColonIndex === -1) {
    // Fallback for malformed keys — treat entire key as messageId with default clientRef
    return { clientRef: defaultClientRef, messageId: cacheKey };
  }
  const platformAndClientId = cacheKey.slice(0, lastColonIndex);
  const messageId = cacheKey.slice(lastColonIndex + 1);

  const secondColonIndex = platformAndClientId.indexOf(":");
  if (secondColonIndex === -1) {
    // Legacy format: just clientId (no platform)
    const clientId = platformAndClientId;
    return {
      clientRef:
        clientId === defaultClientRef.clientId
          ? defaultClientRef
          : { platform: "discord" as const, clientId },
      messageId,
    };
  }

  const platform = platformAndClientId.slice(0, secondColonIndex);
  const clientId = platformAndClientId.slice(secondColonIndex + 1);
  return {
    clientRef: { platform: platform as ClientRef["platform"], clientId },
    messageId,
  };
};

const messageKey = (clientRef: ClientRef, messageId: string) => ({
  clientPlatform: clientRef.platform,
  clientId: clientRef.clientId,
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
    >((cacheKey) => {
      const { clientRef, messageId } = parseCacheKey(cacheKey);
      return sheetApisRpcTokens.withServiceUser(
        sheetApisForwardingClient.messageCheckin
          .getMessageCheckinData({ query: messageKey(clientRef, messageId) })
          .pipe(Effect.option),
      );
    }, cacheOptions);
    const messageCheckinMembersCache = yield* Cache.makeWith<
      string,
      ReadonlyArray<MessageCheckinMember>,
      unknown
    >((cacheKey) => {
      const { clientRef, messageId } = parseCacheKey(cacheKey);
      return sheetApisRpcTokens.withServiceUser(
        sheetApisForwardingClient.messageCheckin.getMessageCheckinMembers({
          query: messageKey(clientRef, messageId),
        }),
      );
    }, cacheOptions);
    const messageRoomOrderCache = yield* Cache.makeWith<
      string,
      Option.Option<MessageRoomOrder>,
      unknown
    >((cacheKey) => {
      const { clientRef, messageId } = parseCacheKey(cacheKey);
      return sheetApisRpcTokens.withServiceUser(
        sheetApisForwardingClient.messageRoomOrder
          .getMessageRoomOrder({ query: messageKey(clientRef, messageId) })
          .pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              isMissingMessageRoomOrderError(error)
                ? Effect.succeed(Option.none())
                : Effect.fail(error),
            ),
          ),
      );
    }, cacheOptions);
    const messageSlotDataCache = yield* Cache.makeWith<string, Option.Option<MessageSlot>, unknown>(
      (cacheKey) => {
        const { clientRef, messageId } = parseCacheKey(cacheKey);
        return sheetApisRpcTokens.withServiceUser(
          sheetApisForwardingClient.messageSlot
            .getMessageSlotData({ query: messageKey(clientRef, messageId) })
            .pipe(Effect.option),
        );
      },
      cacheOptions,
    );

    const cacheKey = (clientRef: ClientRef | undefined, messageId: string) =>
      `${clientRef?.platform ?? defaultClientRef.platform}:${clientRef?.clientId ?? defaultClientRef.clientId}:${messageId}`;

    return {
      getMessageCheckinData: Effect.fn("MessageLookup.getMessageCheckinData")(function* (
        messageId: string,
        clientRef?: ClientRef,
      ) {
        return yield* Cache.get(messageCheckinDataCache, cacheKey(clientRef, messageId));
      }),
      getMessageCheckinMembers: Effect.fn("MessageLookup.getMessageCheckinMembers")(function* (
        messageId: string,
        clientRef?: ClientRef,
      ) {
        return yield* Cache.get(messageCheckinMembersCache, cacheKey(clientRef, messageId));
      }),
      getMessageRoomOrder: Effect.fn("MessageLookup.getMessageRoomOrder")(function* (
        messageId: string,
        clientRef?: ClientRef,
      ) {
        return yield* Cache.get(messageRoomOrderCache, cacheKey(clientRef, messageId));
      }),
      getMessageSlotData: Effect.fn("MessageLookup.getMessageSlotData")(function* (
        messageId: string,
        clientRef?: ClientRef,
      ) {
        return yield* Cache.get(messageSlotDataCache, cacheKey(clientRef, messageId));
      }),
    } satisfies {
      readonly getMessageCheckinData: (
        messageId: string,
        clientRef?: ClientRef,
      ) => Effect.Effect<Option.Option<MessageCheckin>, unknown>;
      readonly getMessageCheckinMembers: (
        messageId: string,
        clientRef?: ClientRef,
      ) => Effect.Effect<ReadonlyArray<MessageCheckinMember>, unknown>;
      readonly getMessageRoomOrder: (
        messageId: string,
        clientRef?: ClientRef,
      ) => Effect.Effect<Option.Option<MessageRoomOrder>, unknown>;
      readonly getMessageSlotData: (
        messageId: string,
        clientRef?: ClientRef,
      ) => Effect.Effect<Option.Option<MessageSlot>, unknown>;
    };
  }),
}) {
  static layer = Layer.effect(MessageLookup, this.make).pipe(
    Layer.provide([SheetApisForwardingClient.layer, SheetApisRpcTokens.layer]),
  );
}
