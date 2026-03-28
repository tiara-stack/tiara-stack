import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR,
  requireRoomOrderMonitorAccess,
  requireRoomOrderUpsertAccess,
} from "./http";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";
import { MessageRoomOrder } from "@/schemas/messageRoomOrder";
import type { MessageRoomOrderService } from "@/services/messageRoomOrder";
import { getFailure, liveGuildServices, withUser } from "@/test-utils/guildTestHelpers";

const makeMessageRoomOrderRecord = (overrides?: {
  readonly guildId?: string | null;
  readonly messageChannelId?: string | null;
}) => {
  const guildId = overrides && "guildId" in overrides ? overrides.guildId : "guild-1";
  const messageChannelId =
    overrides && "messageChannelId" in overrides ? overrides.messageChannelId : "channel-1";

  return new MessageRoomOrder({
    messageId: "message-1",
    hour: 1,
    previousFills: [],
    fills: [],
    rank: 1,
    monitor: Option.none(),
    guildId: Option.fromNullable(guildId),
    messageChannelId: Option.fromNullable(messageChannelId),
    createdByUserId: Option.some("creator-1"),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });
};

const makeRoomOrderService = (record?: MessageRoomOrder) =>
  ({
    getMessageRoomOrder: () => Effect.succeed(Option.fromNullable(record)),
  }) as unknown as MessageRoomOrderService;

describe("messageRoomOrder legacy access", () => {
  it.effect("denies legacy record access via requireRoomOrderMonitorAccess", () =>
    Effect.gen(function* () {
      const legacyRecord = makeMessageRoomOrderRecord({ guildId: null, messageChannelId: null });
      let operationCalls = 0;

      const error = yield* getFailure(
        requireRoomOrderMonitorAccess(legacyRecord).pipe(
          Effect.andThen(
            Effect.sync(() => {
              operationCalls += 1;
            }),
          ),
          withUser(["bot"]),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR);
      expect(operationCalls).toBe(0);
    }),
  );

  it.effect("denies partially legacy record access for regular users", () =>
    Effect.gen(function* () {
      const legacyRecord = makeMessageRoomOrderRecord({
        guildId: "guild-1",
        messageChannelId: null,
      });

      const error = yield* getFailure(
        requireRoomOrderMonitorAccess(legacyRecord).pipe(
          withUser([], { accountId: "discord-account-1", userId: "user-1" }),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR);
    }),
  );

  it.effect("denies upsert for an existing legacy room-order record before the mutation runs", () =>
    Effect.gen(function* () {
      let mutationCalls = 0;
      const error = yield* getFailure(
        requireRoomOrderUpsertAccess(
          makeRoomOrderService(
            makeMessageRoomOrderRecord({ guildId: null, messageChannelId: null }),
          ),
          "message-1",
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              mutationCalls += 1;
            }),
          ),
          withUser(["bot"]),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR);
      expect(mutationCalls).toBe(0);
    }),
  );

  it.effect("denies creating a missing legacy room-order record", () =>
    Effect.gen(function* () {
      const error = yield* getFailure(
        requireRoomOrderUpsertAccess(makeRoomOrderService(), "message-1").pipe(
          withUser(["bot"]),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR);
    }),
  );

  it.effect("allows modern monitor access", () =>
    Effect.gen(function* () {
      yield* requireRoomOrderMonitorAccess(makeMessageRoomOrderRecord()).pipe(
        withUser([], { accountId: "discord-account-1", userId: "user-1" }),
        liveGuildServices({
          memberAccountId: "discord-account-1",
          memberRoles: ["monitor-role"],
          monitorRoleIds: ["monitor-role"],
        }),
      );
    }),
  );

  it.effect("allows modern upsert for monitors", () =>
    Effect.gen(function* () {
      yield* requireRoomOrderUpsertAccess(makeRoomOrderService(), "message-1", "guild-1").pipe(
        withUser([], { accountId: "discord-account-1", userId: "user-1" }),
        liveGuildServices({
          memberAccountId: "discord-account-1",
          memberRoles: ["monitor-role"],
          monitorRoleIds: ["monitor-role"],
        }),
      );
    }),
  );
});
