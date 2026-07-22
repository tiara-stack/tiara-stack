import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import {
  DispatchRoomOrderButtonMethods,
  MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE,
} from "sheet-ingress-api/sheet-apis-rpc";
import { AuthorizationService } from "./authorization";
import { MessageLookup } from "./messageLookup";
import {
  requireRegisteredRoomOrderButton,
  requireRoomOrderPinTentativeButton,
  roomOrderButtonProxyAuthorizers,
} from "./roomOrderButtonAuthorization";

const makeRoomOrder = (
  overrides: Partial<ConstructorParameters<typeof MessageRoomOrder>[0]> = {},
) =>
  new MessageRoomOrder({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: "room-order-message-1",
    hour: 20,
    previousFills: [],
    fills: [],
    rank: 0,
    tentative: false,
    monitor: Option.none(),
    workspaceId: Option.some("registered-guild-1"),
    conversationId: Option.some("running-channel-1"),
    createdByUserId: Option.none(),
    sendClaimId: Option.none(),
    sendClaimedAt: Option.none(),
    sentMessageId: Option.none(),
    sentConversationId: Option.none(),
    sentAt: Option.none(),
    tentativeUpdateClaimId: Option.none(),
    tentativeUpdateClaimedAt: Option.none(),
    tentativePinClaimId: Option.none(),
    tentativePinClaimedAt: Option.none(),
    tentativePinnedAt: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
    ...overrides,
  });

const runAuthorization = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  {
    lookupError,
    roomOrder = Option.none(),
  }: {
    readonly lookupError?: unknown;
    readonly roomOrder?: Option.Option<MessageRoomOrder>;
  } = {},
) => {
  const getMessageRoomOrder = vi.fn(() =>
    lookupError === undefined ? Effect.succeed(roomOrder) : Effect.fail(lookupError),
  );
  const requireMonitorWorkspace = vi.fn(() => Effect.void);

  const provided = effect.pipe(
    Effect.provideService(MessageLookup, {
      getMessageRoomOrder,
    } as never),
    Effect.provideService(AuthorizationService, {
      requireMonitorWorkspace,
    } as never),
  ) as Effect.Effect<A, E, never>;

  return Effect.exit(provided).pipe(
    Effect.map((exit) => ({
      exit,
      getMessageRoomOrder,
      requireMonitorWorkspace,
    })),
  );
};

describe("room-order button proxy authorization", () => {
  it("wires split ingress endpoint names to the intended authorization policies", () => {
    expect(
      roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.previous.endpointName],
    ).toBe(requireRegisteredRoomOrderButton);
    expect(roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.next.endpointName]).toBe(
      requireRegisteredRoomOrderButton,
    );
    expect(roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.send.endpointName]).toBe(
      requireRegisteredRoomOrderButton,
    );
    expect(
      roomOrderButtonProxyAuthorizers[DispatchRoomOrderButtonMethods.pinTentative.endpointName],
    ).toBe(requireRoomOrderPinTentativeButton);
  });

  it.effect("requires registered records for room-order button policy", () =>
    Effect.gen(function* () {
      const { exit, requireMonitorWorkspace } = yield* runAuthorization(
        requireRegisteredRoomOrderButton({ messageId: "missing-message-1" }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(requireMonitorWorkspace).not.toHaveBeenCalled();
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE);
      }
    }),
  );

  it.effect("propagates unexpected message lookup failures without rewriting them", () =>
    Effect.gen(function* () {
      const lookupError = new Error("database unavailable");
      const { exit } = yield* runAuthorization(
        requireRegisteredRoomOrderButton({ messageId: "message-1" }),
        { lookupError },
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("database unavailable");
        expect(Cause.pretty(exit.cause)).not.toContain("Cannot authorize message room order");
      }
    }),
  );

  it.effect("authorizes registered button actions against the persisted message guild", () =>
    Effect.gen(function* () {
      const { exit, requireMonitorWorkspace } = yield* runAuthorization(
        requireRegisteredRoomOrderButton({ messageId: "room-order-message-1" }),
        { roomOrder: Option.some(makeRoomOrder()) },
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requireMonitorWorkspace).toHaveBeenCalledWith("registered-guild-1");
    }),
  );

  it.effect(
    "allows pinTentative fallback authorization by verified payload guild when no record exists",
    () =>
      Effect.gen(function* () {
        const { exit, requireMonitorWorkspace } = yield* runAuthorization(
          requireRoomOrderPinTentativeButton({
            workspaceId: "fallback-guild-1",
            messageId: "unregistered-room-order-message-1",
          }),
        );

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requireMonitorWorkspace).toHaveBeenCalledWith("fallback-guild-1");
      }),
  );

  it.effect("uses the persisted message guild for pinTentative when a record exists", () =>
    Effect.gen(function* () {
      const { exit, requireMonitorWorkspace } = yield* runAuthorization(
        requireRoomOrderPinTentativeButton({
          workspaceId: "payload-guild-1",
          messageId: "room-order-message-1",
        }),
        { roomOrder: Option.some(makeRoomOrder()) },
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requireMonitorWorkspace).toHaveBeenCalledWith("registered-guild-1");
    }),
  );
});
