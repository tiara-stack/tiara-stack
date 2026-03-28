import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  LEGACY_MESSAGE_SLOT_ACCESS_ERROR,
  requireMessageSlotReadAccess,
  requireMessageSlotUpsertAccess,
} from "./http";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";
import { MessageSlot } from "@/schemas/messageSlot";
import type { MessageSlotService } from "@/services/messageSlot";
import { getFailure, liveGuildServices, withUser } from "@/test-utils/guildTestHelpers";

const makeMessageSlotRecord = (overrides?: {
  readonly guildId?: string | null;
  readonly messageChannelId?: string | null;
}) => {
  const guildId = overrides && "guildId" in overrides ? overrides.guildId : "guild-1";
  const messageChannelId =
    overrides && "messageChannelId" in overrides ? overrides.messageChannelId : "channel-1";

  return new MessageSlot({
    messageId: "message-1",
    day: 1,
    guildId: Option.fromNullable(guildId),
    messageChannelId: Option.fromNullable(messageChannelId),
    createdByUserId: Option.some("creator-1"),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });
};

const makeMessageSlotService = (record?: MessageSlot) =>
  ({
    getMessageSlotData: () => Effect.succeed(Option.fromNullable(record)),
  }) as unknown as MessageSlotService;

describe("messageSlot legacy access", () => {
  it.effect("denies legacy reads for bot users", () =>
    Effect.gen(function* () {
      const error = yield* getFailure(
        requireMessageSlotReadAccess(
          makeMessageSlotService(makeMessageSlotRecord({ guildId: null, messageChannelId: null })),
          "message-1",
        ).pipe(withUser(["bot"]), liveGuildServices()),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_SLOT_ACCESS_ERROR);
    }),
  );

  it.effect("denies partially legacy reads for regular users", () =>
    Effect.gen(function* () {
      const error = yield* getFailure(
        requireMessageSlotReadAccess(
          makeMessageSlotService(
            makeMessageSlotRecord({ guildId: "guild-1", messageChannelId: null }),
          ),
          "message-1",
        ).pipe(
          withUser([], { accountId: "discord-account-1", userId: "user-1" }),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_SLOT_ACCESS_ERROR);
    }),
  );

  it.effect("denies upsert for an existing legacy slot record before the mutation runs", () =>
    Effect.gen(function* () {
      let mutationCalls = 0;
      const error = yield* getFailure(
        requireMessageSlotUpsertAccess(
          makeMessageSlotService(makeMessageSlotRecord({ guildId: null, messageChannelId: null })),
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
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_SLOT_ACCESS_ERROR);
      expect(mutationCalls).toBe(0);
    }),
  );

  it.effect("denies creating a missing legacy slot record", () =>
    Effect.gen(function* () {
      const error = yield* getFailure(
        requireMessageSlotUpsertAccess(makeMessageSlotService(), "message-1").pipe(
          withUser(["bot"]),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_SLOT_ACCESS_ERROR);
    }),
  );

  it.effect("allows modern reads for guild members", () =>
    Effect.gen(function* () {
      const record = yield* requireMessageSlotReadAccess(
        makeMessageSlotService(makeMessageSlotRecord()),
        "message-1",
      ).pipe(
        withUser([], { accountId: "discord-account-1", userId: "user-1" }),
        liveGuildServices({
          memberAccountId: "discord-account-1",
          memberRoles: [],
          monitorRoleIds: ["monitor-role"],
        }),
      );

      expect(record.messageId).toBe("message-1");
    }),
  );

  it.effect("allows modern upsert for monitors", () =>
    Effect.gen(function* () {
      yield* requireMessageSlotUpsertAccess(makeMessageSlotService(), "message-1", "guild-1").pipe(
        withUser([], { accountId: "discord-account-1", userId: "user-1" }),
        liveGuildServices({
          memberAccountId: "discord-account-1",
          memberRoles: ["monitor-role"],
          monitorRoleIds: ["monitor-role"],
        }),
      );
    }),
  );

  it.effect("allows modern upsert for monitors on an existing record", () =>
    Effect.gen(function* () {
      yield* requireMessageSlotUpsertAccess(
        makeMessageSlotService(makeMessageSlotRecord()),
        "message-1",
      ).pipe(
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
