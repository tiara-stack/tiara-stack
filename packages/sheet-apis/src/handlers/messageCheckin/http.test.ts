import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR,
  requireCheckinUpsertAccess,
  requireMessageCheckinParticipantMutationAccess,
  requireMessageCheckinMembersReadAccess,
  requireMessageCheckinMonitorMutationAccess,
  requireMessageCheckinReadAccess,
} from "./http";
import { Unauthorized } from "typhoon-core/error";
import { MessageCheckin, MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import { MessageCheckinService } from "@/services";
import { getFailure, liveWorkspaceServices, withUser } from "@/test-utils/guildTestHelpers";
import {
  messageKey,
  resolveMessageRecordRefs,
  type MessageRecordOverrides,
  withAuthorization,
} from "../messageAuthTestHelpers";

type MessageCheckinAccessService = Pick<
  typeof MessageCheckinService.Service,
  "getMessageCheckinData" | "getMessageCheckinMembers"
>;

const makeMessageCheckinRecord = (overrides?: MessageRecordOverrides) => {
  const refs = resolveMessageRecordRefs(overrides, {
    workspaceId: "guild-1",
    conversationId: "message-channel-1",
  });

  return new MessageCheckin({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: "message-1",
    initialMessage: [{ type: "text", text: "check in" }],
    hour: 1,
    runningConversationId: "channel-1",
    roleId: Option.none(),
    workspaceId: Option.fromNullishOr(refs.workspaceId),
    conversationId: Option.fromNullishOr(refs.conversationId),
    createdByUserId: Option.some("creator-1"),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });
};

const makeMessageCheckinMember = (memberId: string) =>
  new MessageCheckinMember({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: "message-1",
    memberId,
    checkinAt: Option.none(),
    checkinClaimId: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  });

const makeMessageCheckinService = (options?: {
  readonly record?: MessageCheckin | undefined;
  readonly members?: ReadonlyArray<MessageCheckinMember>;
}) =>
  ({
    getMessageCheckinData: () => Effect.succeed(Option.fromNullishOr(options?.record)),
    getMessageCheckinMembers: () => Effect.succeed([...(options?.members ?? [])]),
  }) satisfies MessageCheckinAccessService;

describe("messageCheckin legacy access", () => {
  it.effect(
    "denies legacy reads for service users",
    Effect.fnUntraced(function* () {
      const service = makeMessageCheckinService({
        record: makeMessageCheckinRecord({ workspaceId: null, conversationId: null }),
      });

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageCheckinReadAccess(authorizationService, service, messageKey),
        ).pipe(withUser(["service"]), liveWorkspaceServices()),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR);
    }),
  );

  it.effect(
    "denies partially legacy reads for regular users",
    Effect.fnUntraced(function* () {
      const service = makeMessageCheckinService({
        record: makeMessageCheckinRecord({ workspaceId: "guild-1", conversationId: null }),
      });

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageCheckinReadAccess(authorizationService, service, messageKey),
        ).pipe(
          withUser([], { accountId: "discord-account-1", userId: "user-1" }),
          liveWorkspaceServices(),
        ),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR);
    }),
  );

  it.effect(
    "denies legacy member reads for service users",
    Effect.fnUntraced(function* () {
      const service = makeMessageCheckinService({
        record: makeMessageCheckinRecord({ workspaceId: null, conversationId: null }),
      });

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageCheckinMembersReadAccess(authorizationService, service, messageKey),
        ).pipe(withUser(["service"]), liveWorkspaceServices()),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR);
    }),
  );

  it.effect(
    "denies legacy add-member mutations before the service call runs",
    Effect.fnUntraced(function* () {
      let mutationCalls = 0;
      const service = makeMessageCheckinService({
        record: makeMessageCheckinRecord({ workspaceId: null, conversationId: null }),
      });

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageCheckinMonitorMutationAccess(authorizationService, service, messageKey),
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
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR);
      expect(mutationCalls).toBe(0);
    }),
  );

  it.effect(
    "denies legacy participant mutations before the service call runs",
    Effect.fnUntraced(function* () {
      let mutationCalls = 0;
      const service = makeMessageCheckinService({
        record: makeMessageCheckinRecord({ workspaceId: null, conversationId: null }),
      });

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireMessageCheckinParticipantMutationAccess(
            authorizationService,
            service,
            messageKey,
            "discord-account-1",
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
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR);
      expect(mutationCalls).toBe(0);
    }),
  );

  it.effect(
    "denies creating a missing legacy check-in record",
    Effect.fnUntraced(function* () {
      const service = makeMessageCheckinService();

      const error = yield* getFailure(
        withAuthorization((authorizationService) =>
          requireCheckinUpsertAccess(authorizationService, service, messageKey),
        ).pipe(withUser(["service"]), liveWorkspaceServices()),
      );

      expect(error).toBeInstanceOf(Unauthorized);
      expect((error as Unauthorized).message).toBe(LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR);
    }),
  );

  it.effect(
    "allows modern upsert for monitor access",
    Effect.fnUntraced(function* () {
      yield* withAuthorization((authorizationService) =>
        requireCheckinUpsertAccess(
          authorizationService,
          makeMessageCheckinService(),
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
    "allows modern monitor reads",
    Effect.fnUntraced(function* () {
      const record = yield* withAuthorization((authorizationService) =>
        requireMessageCheckinReadAccess(
          authorizationService,
          makeMessageCheckinService({
            record: makeMessageCheckinRecord(),
          }),
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

      expect(record.messageId).toBe("message-1");
    }),
  );

  it.effect(
    "allows modern monitor to add members",
    Effect.fnUntraced(function* () {
      yield* withAuthorization((authorizationService) =>
        requireMessageCheckinMonitorMutationAccess(
          authorizationService,
          makeMessageCheckinService({
            record: makeMessageCheckinRecord(),
          }),
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

  it.effect(
    "allows recorded participant mutations for modern records",
    Effect.fnUntraced(function* () {
      yield* withAuthorization((authorizationService) =>
        requireMessageCheckinParticipantMutationAccess(
          authorizationService,
          makeMessageCheckinService({
            record: makeMessageCheckinRecord(),
            members: [
              makeMessageCheckinMember("discord-account-1"),
              makeMessageCheckinMember("discord-account-2"),
            ],
          }),
          messageKey,
          "discord-account-1",
        ),
      ).pipe(
        withUser(["account:discord:discord-account-1"], {
          accountId: "discord-account-1",
          userId: "user-1",
        }),
        liveWorkspaceServices({
          memberAccountId: "discord-account-1",
          memberRoles: [],
          monitorRoleIds: ["monitor-role"],
        }),
      );
    }),
  );

  it.effect(
    "allows participant self-read behavior for modern records",
    Effect.fnUntraced(function* () {
      const members = yield* withAuthorization((authorizationService) =>
        requireMessageCheckinMembersReadAccess(
          authorizationService,
          makeMessageCheckinService({
            record: makeMessageCheckinRecord(),
            members: [
              makeMessageCheckinMember("discord-account-1"),
              makeMessageCheckinMember("discord-account-2"),
            ],
          }),
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

      expect(members.map((member) => member.memberId)).toEqual([
        "discord-account-1",
        "discord-account-2",
      ]);
    }),
  );
});
