import { describe, expect, it } from "@effect/vitest";
import { Effect, Option, Context } from "effect";
import {
  LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR,
  requireRoomOrderMonitorAccess,
  requireRoomOrderUpsertAccess,
} from "./http";
import { Unauthorized } from "typhoon-core/error";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { AuthorizationService, MessageRoomOrderService } from "@/services";
import { getFailure, liveGuildServices, withUser } from "@/test-utils/guildTestHelpers";

type MessageRoomOrderAccessService = Pick<
  typeof MessageRoomOrderService.Service,
  "getMessageRoomOrder"
>;
type AuthorizationServiceApi = Context.Service.Shape<typeof AuthorizationService>;

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
    guildId: Option.fromNullishOr(guildId),
    messageChannelId: Option.fromNullishOr(messageChannelId),
    createdByUserId: Option.some("creator-1"),
    sendClaimId: Option.none(),
    sendClaimedAt: Option.none(),
    sentMessageId: Option.none(),
    sentMessageChannelId: Option.none(),
    sentAt: Option.none(),
    tentativePinClaimId: Option.none(),
    tentativePinClaimedAt: Option.none(),
    tentativePinnedAt: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });
};

const makeRoomOrderService = (record?: MessageRoomOrder) =>
  ({
    getMessageRoomOrder: () => Effect.succeed(Option.fromNullishOr(record)),
  }) satisfies MessageRoomOrderAccessService;

const withAuthorization = Effect.fnUntraced(function* <A, E, R>(
  f: (authorizationService: AuthorizationServiceApi) => Effect.Effect<A, E, R>,
) {
  const authorizationService = yield* AuthorizationService.make;
  return yield* f(authorizationService);
});

describe("messageRoomOrder legacy access", () => {
  it.effect(
    "denies legacy record access via requireRoomOrderMonitorAccess",
    Effect.fnUntraced(function* () {
      const legacyRecord = makeMessageRoomOrderRecord({ guildId: null, messageChannelId: null });
      let operationCalls = 0;

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireRoomOrderMonitorAccess(authorizationService, legacyRecord),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              operationCalls += 1;
            }),
          ),
          withUser(["service"]),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR);
      expect(operationCalls).toBe(0);
    }),
  );

  it.effect(
    "denies partially legacy record access for regular users",
    Effect.fnUntraced(function* () {
      const legacyRecord = makeMessageRoomOrderRecord({
        guildId: "guild-1",
        messageChannelId: null,
      });

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireRoomOrderMonitorAccess(authorizationService, legacyRecord),
        ).pipe(
          withUser([], { accountId: "discord-account-1", userId: "user-1" }),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR);
    }),
  );

  it.effect(
    "denies upsert for an existing legacy room-order record before the mutation runs",
    Effect.fnUntraced(function* () {
      let mutationCalls = 0;
      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireRoomOrderUpsertAccess(
            authorizationService,
            makeRoomOrderService(
              makeMessageRoomOrderRecord({ guildId: null, messageChannelId: null }),
            ),
            "message-1",
          ),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              mutationCalls += 1;
            }),
          ),
          withUser(["service"]),
          liveGuildServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR);
      expect(mutationCalls).toBe(0);
    }),
  );

  it.effect(
    "denies creating a missing legacy room-order record",
    Effect.fnUntraced(function* () {
      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireRoomOrderUpsertAccess(authorizationService, makeRoomOrderService(), "message-1"),
        ).pipe(withUser(["service"]), liveGuildServices()),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR);
    }),
  );

  it.effect(
    "allows modern monitor access",
    Effect.fnUntraced(function* () {
      yield* withAuthorization((authorizationService) =>
        requireRoomOrderMonitorAccess(authorizationService, makeMessageRoomOrderRecord()),
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

  it.effect(
    "allows modern upsert for monitors",
    Effect.fnUntraced(function* () {
      yield* withAuthorization((authorizationService) =>
        requireRoomOrderUpsertAccess(
          authorizationService,
          makeRoomOrderService(),
          "message-1",
          "guild-1",
        ),
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
