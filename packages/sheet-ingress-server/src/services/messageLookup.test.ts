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
  const getMessageCheckinData = vi.fn(({ query }: { query: { messageId: string } }) =>
    Effect.succeed({
      messageId: query.messageId,
      messageChannelId: "channel-1",
      checkinChannelId: "checkin-channel-1",
      checkinMessageId: "checkin-message-1",
      title: "Checkin",
    }),
  );
  const getMessageCheckinMembers = vi.fn(({ query }: { query: { messageId: string } }) =>
    Effect.succeed([
      {
        messageId: query.messageId,
        memberId: "member-1",
        checkinAt: null,
      },
    ]),
  );
  const getMessageRoomOrder = vi.fn(({ query }: { query: { messageId: string } }) =>
    roomOrderError === undefined
      ? Effect.succeed({
          messageId: query.messageId,
          messageChannelId: "channel-1",
          roomOrderMessageId: "room-order-message-1",
          title: "Room order",
        })
      : Effect.fail(roomOrderError),
  );
  const getMessageSlotData = vi.fn(({ query }: { query: { messageId: string } }) =>
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

describe("MessageLookup", () => {
  it("caches message checkin data lookups by message id", async () => {
    const { client, getMessageCheckinData } = makeSheetApisForwardingClient();

    const result = await Effect.runPromise(
      runLookup(
        Effect.gen(function* () {
          const lookup = yield* MessageLookup;
          const first = yield* lookup.getMessageCheckinData("message-1");
          const second = yield* lookup.getMessageCheckinData("message-1");
          return { first, second };
        }),
        client,
      ),
    );

    expect(getMessageCheckinData).toHaveBeenCalledTimes(1);
    expect(Option.isSome(result.first)).toBe(true);
    expect(result.second).toEqual(result.first);
  });

  it("caches checkin member, room order, and slot lookups independently", async () => {
    const { client, getMessageCheckinMembers, getMessageRoomOrder, getMessageSlotData } =
      makeSheetApisForwardingClient();

    const result = await Effect.runPromise(
      runLookup(
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
      ),
    );

    expect(getMessageCheckinMembers).toHaveBeenCalledTimes(1);
    expect(result.members[0]?.messageId).toBe("message-1");
    expect(getMessageRoomOrder).toHaveBeenCalledTimes(1);
    expect(getMessageSlotData).toHaveBeenCalledTimes(1);
  });

  it("maps missing room-order records to none and preserves lookup failures", async () => {
    const missingClient = makeSheetApisForwardingClient({
      roomOrderError: makeArgumentError(MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE),
    });

    const missing = await Effect.runPromise(
      runLookup(
        Effect.gen(function* () {
          const lookup = yield* MessageLookup;
          return yield* lookup.getMessageRoomOrder("missing-message-1");
        }),
        missingClient.client,
      ),
    );

    expect(Option.isNone(missing)).toBe(true);

    const failureClient = makeSheetApisForwardingClient({
      roomOrderError: new Error("database unavailable"),
    });

    const exit = await Effect.runPromiseExit(
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
  });
});
