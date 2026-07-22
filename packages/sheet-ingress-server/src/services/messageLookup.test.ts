import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE } from "sheet-ingress-api/sheet-apis-rpc";
import { makeArgumentError } from "typhoon-core/error";
import { MessageLookup } from "./messageLookup";
import { SheetApisForwardingClient } from "./sheetApisForwardingClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";

const makeSheetApisForwardingClient = ({
  roomOrderError,
}: {
  readonly roomOrderError?: unknown;
} = {}) => {
  const getMessageCheckinData = vi.fn(
    ({ query }: { query: { messageId: string; clientPlatform: string; clientId: string } }) =>
      Effect.succeed({
        messageId: query.messageId,
        messageChannelId: "channel-1",
        checkinChannelId: "checkin-channel-1",
        checkinMessageId: "checkin-message-1",
        title: "Checkin",
      }),
  );
  const getMessageCheckinMembers = vi.fn(
    ({ query }: { query: { messageId: string; clientPlatform: string; clientId: string } }) =>
      Effect.succeed([
        {
          messageId: query.messageId,
          memberId: "member-1",
          checkinAt: null,
        },
      ]),
  );
  const getMessageRoomOrder = vi.fn(
    ({ query }: { query: { messageId: string; clientPlatform: string; clientId: string } }) =>
      roomOrderError === undefined
        ? Effect.succeed({
            messageId: query.messageId,
            messageChannelId: "channel-1",
            roomOrderMessageId: "room-order-message-1",
            title: "Room order",
          })
        : Effect.fail(roomOrderError),
  );
  const getMessageSlotData = vi.fn(
    ({ query }: { query: { messageId: string; clientPlatform: string; clientId: string } }) =>
      Effect.succeed({
        messageId: query.messageId,
        messageChannelId: "channel-1",
        slotMessageId: "slot-message-1",
        title: "Slot",
      }),
  );

  return {
    client: {
      messageCheckin: {
        getMessageCheckinData,
        getMessageCheckinMembers,
      },
      messageRoomOrder: {
        getMessageRoomOrder,
      },
      messageSlot: {
        getMessageSlotData,
      },
    } as never,
    getMessageCheckinData,
    getMessageCheckinMembers,
    getMessageRoomOrder,
    getMessageSlotData,
  };
};

const runLookup = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  sheetApisForwardingClient: typeof SheetApisForwardingClient.Service,
) =>
  effect.pipe(
    Effect.provide(Layer.effect(MessageLookup, MessageLookup.make)),
    Effect.provideService(SheetApisForwardingClient, sheetApisForwardingClient),
    Effect.provideService(SheetApisRpcTokens, {
      getServiceUser: () =>
        Effect.succeed({
          accountId: "service",
          userId: "service-user",
          permissions: new Set(["service"]) as never,
          token: {} as never,
        }),
      withServiceUser: <A, E, R>(serviceEffect: Effect.Effect<A, E, R>) => serviceEffect,
    } as never),
  );

const defaultClientRef = { platform: "discord" as const, clientId: "discord-main" };
const altClientRef = { platform: "discord" as const, clientId: "discord-alt" };

describe("MessageLookup", () => {
  it.effect("caches message checkin data lookups by message id", () =>
    Effect.gen(function* () {
      const { client, getMessageCheckinData } = makeSheetApisForwardingClient();

      const result = yield* runLookup(
        Effect.gen(function* () {
          const lookup = yield* MessageLookup;
          const first = yield* lookup.getMessageCheckinData("message-1");
          const second = yield* lookup.getMessageCheckinData("message-1");
          return { first, second };
        }),
        client,
      );

      expect(getMessageCheckinData).toHaveBeenCalledTimes(1);
      expect(Option.isSome(result.first)).toBe(true);
      expect(result.second).toEqual(result.first);
    }),
  );

  it.effect("caches checkin member, room order, and slot lookups independently", () =>
    Effect.gen(function* () {
      const { client, getMessageCheckinMembers, getMessageRoomOrder, getMessageSlotData } =
        makeSheetApisForwardingClient();

      const result = yield* runLookup(
        Effect.gen(function* () {
          const lookup = yield* MessageLookup;
          const members = yield* lookup.getMessageCheckinMembers("message-1");
          yield* lookup.getMessageCheckinMembers("message-1");
          yield* lookup.getMessageRoomOrder("message-1");
          yield* lookup.getMessageRoomOrder("message-1");
          yield* lookup.getMessageSlotData("message-1");
          yield* lookup.getMessageSlotData("message-1");
          return { members };
        }),
        client,
      );

      expect(getMessageCheckinMembers).toHaveBeenCalledTimes(1);
      expect(result.members[0]?.messageId).toBe("message-1");
      expect(getMessageRoomOrder).toHaveBeenCalledTimes(1);
      expect(getMessageSlotData).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("maps missing room-order records to none and preserves lookup failures", () =>
    Effect.gen(function* () {
      const missingClient = makeSheetApisForwardingClient({
        roomOrderError: makeArgumentError(MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE),
      });

      const missing = yield* runLookup(
        Effect.gen(function* () {
          const lookup = yield* MessageLookup;
          return yield* lookup.getMessageRoomOrder("missing-message-1");
        }),
        missingClient.client,
      );

      expect(Option.isNone(missing)).toBe(true);

      const failureClient = makeSheetApisForwardingClient({
        roomOrderError: new Error("database unavailable"),
      });

      const exit = yield* Effect.exit(
        runLookup(
          Effect.gen(function* () {
            const lookup = yield* MessageLookup;
            return yield* lookup.getMessageRoomOrder("message-1");
          }),
          failureClient.client,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("database unavailable");
      }
    }),
  );

  it.effect("uses default client ref when no clientRef is provided", () =>
    Effect.gen(function* () {
      const { client, getMessageCheckinData } = makeSheetApisForwardingClient();

      yield* runLookup(
        Effect.gen(function* () {
          const lookup = yield* MessageLookup;
          return yield* lookup.getMessageCheckinData("message-1");
        }),
        client,
      );

      expect(getMessageCheckinData).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({
            clientPlatform: "discord",
            clientId: "discord-main",
            messageId: "message-1",
          }),
        }),
      );
    }),
  );

  it.effect("uses provided clientRef in sheet API query keys", () =>
    Effect.gen(function* () {
      const { client, getMessageCheckinData, getMessageRoomOrder, getMessageSlotData } =
        makeSheetApisForwardingClient();

      yield* runLookup(
        Effect.gen(function* () {
          const lookup = yield* MessageLookup;
          yield* lookup.getMessageCheckinData("message-1", altClientRef);
          yield* lookup.getMessageRoomOrder("message-1", altClientRef);
          yield* lookup.getMessageSlotData("message-1", altClientRef);
        }),
        client,
      );

      expect(getMessageCheckinData).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({
            clientPlatform: "discord",
            clientId: "discord-alt",
            messageId: "message-1",
          }),
        }),
      );
      expect(getMessageRoomOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({
            clientPlatform: "discord",
            clientId: "discord-alt",
            messageId: "message-1",
          }),
        }),
      );
      expect(getMessageSlotData).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({
            clientPlatform: "discord",
            clientId: "discord-alt",
            messageId: "message-1",
          }),
        }),
      );
    }),
  );

  it.effect("caches lookups separately for different clientRefs", () =>
    Effect.gen(function* () {
      const { client, getMessageCheckinData } = makeSheetApisForwardingClient();

      yield* runLookup(
        Effect.gen(function* () {
          const lookup = yield* MessageLookup;
          yield* lookup.getMessageCheckinData("message-1", defaultClientRef);
          yield* lookup.getMessageCheckinData("message-1", altClientRef);
          yield* lookup.getMessageCheckinData("message-1", defaultClientRef);
          yield* lookup.getMessageCheckinData("message-1", altClientRef);
        }),
        client,
      );

      expect(getMessageCheckinData).toHaveBeenCalledTimes(2);
    }),
  );
});
