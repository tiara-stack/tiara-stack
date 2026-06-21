// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  LEGACY_MESSAGE_SLOT_ACCESS_ERROR,
  requireMessageSlotReadAccess,
  requireMessageSlotUpsertAccess,
} from "./http";
import { Unauthorized } from "typhoon-core/error";
import { MessageSlot } from "sheet-ingress-api/schemas/messageSlot";
import { MessageSlotService } from "@/services";
import { getFailure, liveWorkspaceServices, withUser } from "@/test-utils/guildTestHelpers";
import {
  messageKey,
  resolveMessageRecordRefs,
  type MessageRecordOverrides,
  withAuthorization,
} from "../messageAuthTestHelpers";

type MessageSlotAccessService = Pick<typeof MessageSlotService.Service, "getMessageSlotData">;

const makeMessageSlotRecord = (overrides?: MessageRecordOverrides) => {
  const refs = resolveMessageRecordRefs(overrides, {
    workspaceId: "guild-1",
    conversationId: "channel-1",
  });

  return new MessageSlot({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: "message-1",
    day: 1,
    workspaceId: Option.fromNullishOr(refs.workspaceId),
    conversationId: Option.fromNullishOr(refs.conversationId),
    createdByUserId: Option.some("creator-1"),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });
};

const makeMessageSlotService = (record?: MessageSlot) =>
  ({
    getMessageSlotData: () => Effect.succeed(Option.fromNullishOr(record)),
  }) satisfies MessageSlotAccessService;

describe("messageSlot legacy access", () => {
  it.effect(
    "denies legacy reads for service users",
    Effect.fnUntraced(function* () {
      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageSlotReadAccess(
            authorizationService,
            makeMessageSlotService(
              makeMessageSlotRecord({ workspaceId: null, conversationId: null }),
            ),
            messageKey,
          ),
        ).pipe(withUser(["service"]), liveWorkspaceServices()),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_SLOT_ACCESS_ERROR);
    }),
  );

  it.effect(
    "denies partially legacy reads for regular users",
    Effect.fnUntraced(function* () {
      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageSlotReadAccess(
            authorizationService,
            makeMessageSlotService(
              makeMessageSlotRecord({ workspaceId: "guild-1", conversationId: null }),
            ),
            messageKey,
          ),
        ).pipe(
          withUser([], { accountId: "discord-account-1", userId: "user-1" }),
          liveWorkspaceServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_SLOT_ACCESS_ERROR);
    }),
  );

  it.effect(
    "denies upsert for an existing legacy slot record before the mutation runs",
    Effect.fnUntraced(function* () {
      let mutationCalls = 0;
      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageSlotUpsertAccess(
            authorizationService,
            makeMessageSlotService(
              makeMessageSlotRecord({ workspaceId: null, conversationId: null }),
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
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_SLOT_ACCESS_ERROR);
      expect(mutationCalls).toBe(0);
    }),
  );

  it.effect(
    "denies creating a missing legacy slot record",
    Effect.fnUntraced(function* () {
      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageSlotUpsertAccess(
            authorizationService,
            makeMessageSlotService(),
            messageKey,
          ),
        ).pipe(withUser(["service"]), liveWorkspaceServices()),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_SLOT_ACCESS_ERROR);
    }),
  );

  it.effect(
    "allows modern reads for guild members",
    Effect.fnUntraced(function* () {
      const record = yield* withAuthorization((authorizationService) =>
        requireMessageSlotReadAccess(
          authorizationService,
          makeMessageSlotService(makeMessageSlotRecord()),
          messageKey,
        ),
      ).pipe(
        withUser([], { accountId: "discord-account-1", userId: "user-1" }),
        liveWorkspaceServices({
          memberAccountId: "discord-account-1",
          memberRoles: [],
          monitorRoleIds: ["monitor-role"],
        }),
      );

      expect(record.messageId).toBe("message-1");
    }),
  );

  it.effect(
    "allows modern upsert for monitors",
    Effect.fnUntraced(function* () {
      yield* withAuthorization((authorizationService) =>
        requireMessageSlotUpsertAccess(
          authorizationService,
          makeMessageSlotService(),
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

  it.effect(
    "allows modern upsert for monitors on an existing record",
    Effect.fnUntraced(function* () {
      yield* withAuthorization((authorizationService) =>
        requireMessageSlotUpsertAccess(
          authorizationService,
          makeMessageSlotService(makeMessageSlotRecord()),
          messageKey,
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
