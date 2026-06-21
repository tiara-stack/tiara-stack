// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  LEGACY_MESSAGE_ROOM_ORDER_ACCESS_ERROR,
  requireRoomOrderMonitorAccess,
  requireRoomOrderUpsertAccess,
} from "./http";
import { Unauthorized } from "typhoon-core/error";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { MessageRoomOrderService } from "@/services";
import { getFailure, liveWorkspaceServices, withUser } from "@/test-utils/guildTestHelpers";
import {
  messageKey,
  resolveMessageRecordRefs,
  type MessageRecordOverrides,
  withAuthorization,
} from "../messageAuthTestHelpers";

type MessageRoomOrderAccessService = Pick<
  typeof MessageRoomOrderService.Service,
  "getMessageRoomOrder"
>;

const makeMessageRoomOrderRecord = (overrides?: MessageRecordOverrides) => {
  const refs = resolveMessageRecordRefs(overrides, {
    workspaceId: "guild-1",
    conversationId: "channel-1",
  });

  return new MessageRoomOrder({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: "message-1",
    hour: 1,
    previousFills: [],
    fills: [],
    rank: 1,
    tentative: false,
    monitor: Option.none(),
    workspaceId: Option.fromNullishOr(refs.workspaceId),
    conversationId: Option.fromNullishOr(refs.conversationId),
    createdByUserId: Option.some("creator-1"),
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
  });
};

const makeRoomOrderService = (record?: MessageRoomOrder) =>
  ({
    getMessageRoomOrder: () => Effect.succeed(Option.fromNullishOr(record)),
  }) satisfies MessageRoomOrderAccessService;

describe("messageRoomOrder legacy access", () => {
  it.effect(
    "denies legacy record access via requireRoomOrderMonitorAccess",
    Effect.fnUntraced(function* () {
      const legacyRecord = makeMessageRoomOrderRecord({
        workspaceId: null,
        conversationId: null,
      });
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
          liveWorkspaceServices(),
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
        workspaceId: "guild-1",
        conversationId: null,
      });

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireRoomOrderMonitorAccess(authorizationService, legacyRecord),
        ).pipe(
          withUser([], { accountId: "discord-account-1", userId: "user-1" }),
          liveWorkspaceServices(),
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
              makeMessageRoomOrderRecord({ workspaceId: null, conversationId: null }),
            ),
            messageKey,
          ),
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              mutationCalls += 1;
            }),
          ),
          withUser(["service"]),
          liveWorkspaceServices(),
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
          requireRoomOrderUpsertAccess(authorizationService, makeRoomOrderService(), messageKey),
        ).pipe(withUser(["service"]), liveWorkspaceServices()),
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
        liveWorkspaceServices({
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
          messageKey,
          "guild-1",
        ),
      ).pipe(
        withUser([], { accountId: "discord-account-1", userId: "user-1" }),
        liveWorkspaceServices({
          memberAccountId: "discord-account-1",
          memberRoles: ["monitor-role"],
          monitorRoleIds: ["monitor-role"],
        }),
      );
    }),
  );
});
