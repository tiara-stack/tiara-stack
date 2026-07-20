import { Effect, Layer, Match, Option, Predicate } from "effect";
import { getModernMessageWorkspaceId } from "@/handlers/message/shared";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  hasWorkspacePermission,
  hasPermission,
  MessageCheckinService,
} from "@/services";
import type { MessageKey } from "@/services/messageKey";
import { type HandlerMap, sheetApisGroupLayer } from "@/handlers/shared/httpApiLayer";
import { MessageCheckin, MessageCheckinMember } from "sheet-ingress-api/schemas/messageCheckin";
import { SheetAuthWorkspaceUser } from "sheet-ingress-api/internal";
import { makeArgumentError, Unauthorized } from "typhoon-core/error";

const missingMessageCheckinError = () =>
  makeArgumentError("Cannot get message checkin data, the message might not be registered");

export const LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR =
  "Legacy message check-in records are no longer accessible";

const denyLegacyMessageCheckinAccess = () =>
  Effect.fail(new Unauthorized({ message: LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR }));

type MessageCheckinAccessService = Pick<
  typeof MessageCheckinService.Service,
  "getMessageCheckinData" | "getMessageCheckinMembers"
>;

type MessageCheckinAuthContext = {
  readonly record: MessageCheckin;
  readonly workspaceId: string | null;
  readonly isLegacy: boolean;
};

type CheckinReadAccess =
  | { readonly _tag: "monitor" }
  | { readonly _tag: "participant"; readonly members: ReadonlyArray<MessageCheckinMember> };

const loadRequiredMessageCheckinRecord = Effect.fn(
  "messageCheckin.loadRequiredMessageCheckinRecord",
)(function* (messageCheckinService: MessageCheckinAccessService, key: MessageKey) {
  const record = yield* messageCheckinService.getMessageCheckinData(key);

  if (Option.isNone(record)) {
    return yield* Effect.fail(missingMessageCheckinError());
  }

  return record.value;
});

const resolveMessageCheckinAuthContext = (record: MessageCheckin): MessageCheckinAuthContext => {
  const workspaceId = Option.getOrElse(getModernMessageWorkspaceId(record), () => null);

  return {
    record,
    workspaceId,
    isLegacy: Predicate.isNull(workspaceId),
  };
};

const withResolvedMessageCheckinWorkspaceUser = <A, E, R>(
  authorizationService: typeof AuthorizationService.Service,
  authContext: MessageCheckinAuthContext,
  effect: Effect.Effect<A, E, R>,
) =>
  (Predicate.isNull(authContext.workspaceId)
    ? effect
    : authorizationService.provideCurrentWorkspaceUser(
        authContext.workspaceId,
        effect,
      )) as Effect.Effect<A, E, Exclude<R, SheetAuthWorkspaceUser>>;

const getRequiredMessageCheckinWorkspaceId = Effect.fn(
  "messageCheckin.getRequiredMessageCheckinWorkspaceId",
)(function* (authContext: MessageCheckinAuthContext) {
  if (authContext.isLegacy || Predicate.isNull(authContext.workspaceId)) {
    return yield* denyLegacyMessageCheckinAccess();
  }

  return authContext.workspaceId;
});

const resolveMessageCheckinUpsertWorkspaceId = Effect.fn(
  "messageCheckin.resolveMessageCheckinUpsertWorkspaceId",
)(function* (
  messageCheckinService: MessageCheckinAccessService,
  key: MessageKey,
  workspaceId?: string,
) {
  const existingRecord = yield* messageCheckinService.getMessageCheckinData(key);

  if (Option.isNone(existingRecord)) {
    if (Predicate.isString(workspaceId)) {
      return workspaceId;
    }

    return yield* denyLegacyMessageCheckinAccess();
  }

  return yield* getRequiredMessageCheckinWorkspaceId(
    resolveMessageCheckinAuthContext(existingRecord.value),
  );
});

const requireRecordedParticipant = (
  members: ReadonlyArray<MessageCheckinMember>,
  memberId: string,
  message = "User is not a recorded participant on this check-in message",
) =>
  members.some((member) => member.memberId === memberId)
    ? Effect.void
    : Effect.fail(new Unauthorized({ message }));

const requireMessageCheckinReadPermission = Effect.fn(
  "messageCheckin.requireMessageCheckinReadPermission",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageCheckinService: MessageCheckinAccessService,
  key: MessageKey,
  authContext: MessageCheckinAuthContext,
) {
  const workspaceId = yield* getRequiredMessageCheckinWorkspaceId(authContext);
  return yield* withResolvedMessageCheckinWorkspaceUser(
    authorizationService,
    authContext,
    Effect.gen(function* () {
      const user = yield* SheetAuthWorkspaceUser;

      if (hasWorkspacePermission(user.permissions, "monitor_workspace", workspaceId)) {
        return { _tag: "monitor" } satisfies CheckinReadAccess;
      }

      if (!hasWorkspacePermission(user.permissions, "member_workspace", workspaceId)) {
        return yield* Effect.fail(
          new Unauthorized({ message: "User is not a member of this workspace" }),
        );
      }

      const members = yield* messageCheckinService.getMessageCheckinMembers(key);
      yield* requireRecordedParticipant(members, user.accountId);

      return {
        _tag: "participant",
        members,
      } satisfies CheckinReadAccess;
    }),
  );
});

const requireMessageCheckinMonitorPermission = Effect.fn(
  "messageCheckin.requireMessageCheckinMonitorPermission",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  authContext: MessageCheckinAuthContext,
) {
  const workspaceId = yield* getRequiredMessageCheckinWorkspaceId(authContext);

  return yield* withResolvedMessageCheckinWorkspaceUser(
    authorizationService,
    authContext,
    authorizationService.requireMonitorWorkspace(workspaceId),
  );
});

const requireMessageCheckinParticipantMutationPermission = Effect.fn(
  "messageCheckin.requireMessageCheckinParticipantMutationPermission",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageCheckinService: MessageCheckinAccessService,
  key: MessageKey,
  memberId: string,
  authContext: MessageCheckinAuthContext,
) {
  const workspaceId = yield* getRequiredMessageCheckinWorkspaceId(authContext);
  return yield* withResolvedMessageCheckinWorkspaceUser(
    authorizationService,
    authContext,
    Effect.gen(function* () {
      const user = yield* SheetAuthWorkspaceUser;

      if (
        hasPermission(user.permissions, "service") ||
        hasPermission(user.permissions, "app_owner")
      ) {
        return;
      }

      if (!hasWorkspacePermission(user.permissions, "member_workspace", workspaceId)) {
        return yield* Effect.fail(
          new Unauthorized({ message: "User is not a member of this workspace" }),
        );
      }

      if (!hasDiscordAccountPermission(user.permissions, memberId)) {
        return yield* Effect.fail(
          new Unauthorized({ message: "User does not have access to this user" }),
        );
      }

      const members = yield* messageCheckinService.getMessageCheckinMembers(key);
      return yield* requireRecordedParticipant(members, memberId);
    }),
  );
});

export const requireCheckinUpsertAccess = Effect.fn("messageCheckin.requireCheckinUpsertAccess")(
  function* (
    authorizationService: typeof AuthorizationService.Service,
    messageCheckinService: MessageCheckinAccessService,
    key: MessageKey,
    workspaceId?: string,
  ) {
    const resolvedWorkspaceId = yield* resolveMessageCheckinUpsertWorkspaceId(
      messageCheckinService,
      key,
      workspaceId,
    );

    return yield* authorizationService.provideCurrentWorkspaceUser(
      resolvedWorkspaceId,
      authorizationService.requireMonitorWorkspace(resolvedWorkspaceId),
    );
  },
);

export const requireMessageCheckinReadAccess = Effect.fn(
  "messageCheckin.requireMessageCheckinReadAccess",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageCheckinService: MessageCheckinAccessService,
  key: MessageKey,
) {
  const record = yield* loadRequiredMessageCheckinRecord(messageCheckinService, key);
  const authContext = resolveMessageCheckinAuthContext(record);

  yield* requireMessageCheckinReadPermission(
    authorizationService,
    messageCheckinService,
    key,
    authContext,
  );

  return authContext.record;
});

export const requireMessageCheckinMembersReadAccess = Effect.fn(
  "messageCheckin.requireMessageCheckinMembersReadAccess",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageCheckinService: MessageCheckinAccessService,
  key: MessageKey,
) {
  const record = yield* loadRequiredMessageCheckinRecord(messageCheckinService, key);
  const authContext = resolveMessageCheckinAuthContext(record);
  const access = yield* requireMessageCheckinReadPermission(
    authorizationService,
    messageCheckinService,
    key,
    authContext,
  );

  return yield* Match.value(access).pipe(
    Match.tagsExhaustive({
      monitor: () => messageCheckinService.getMessageCheckinMembers(key),
      participant: (participantAccess) => Effect.succeed(participantAccess.members),
    }),
  );
});

export const requireMessageCheckinParticipantMutationAccess = Effect.fn(
  "messageCheckin.requireMessageCheckinParticipantMutationAccess",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageCheckinService: MessageCheckinAccessService,
  key: MessageKey,
  memberId: string,
) {
  const record = yield* loadRequiredMessageCheckinRecord(messageCheckinService, key);
  const authContext = resolveMessageCheckinAuthContext(record);

  return yield* requireMessageCheckinParticipantMutationPermission(
    authorizationService,
    messageCheckinService,
    key,
    memberId,
    authContext,
  );
});

export const requireMessageCheckinMonitorMutationAccess = Effect.fn(
  "messageCheckin.requireMessageCheckinMonitorMutationAccess",
)(function* (
  authorizationService: typeof AuthorizationService.Service,
  messageCheckinService: MessageCheckinAccessService,
  key: MessageKey,
) {
  const record = yield* loadRequiredMessageCheckinRecord(messageCheckinService, key);
  const authContext = resolveMessageCheckinAuthContext(record);

  return yield* requireMessageCheckinMonitorPermission(authorizationService, authContext);
});

const messageCheckinHandlers = Effect.gen(function* () {
  const authorizationService = yield* AuthorizationService;
  const messageCheckinService = yield* MessageCheckinService;

  return {
    "messageCheckin.getMessageCheckinData": Effect.fnUntraced(function* ({ query }) {
      return yield* requireMessageCheckinReadAccess(
        authorizationService,
        messageCheckinService,
        query,
      );
    }),
    "messageCheckin.upsertMessageCheckinData": Effect.fnUntraced(function* ({ payload }) {
      yield* requireCheckinUpsertAccess(
        authorizationService,
        messageCheckinService,
        payload,
        Predicate.isString(payload.data.workspaceId) ? payload.data.workspaceId : undefined,
      );

      return yield* messageCheckinService.upsertMessageCheckinData(payload, payload.data);
    }),
    "messageCheckin.getMessageCheckinMembers": Effect.fnUntraced(function* ({ query }) {
      return yield* requireMessageCheckinMembersReadAccess(
        authorizationService,
        messageCheckinService,
        query,
      );
    }),
    "messageCheckin.addMessageCheckinMembers": Effect.fnUntraced(function* ({ payload }) {
      yield* requireMessageCheckinMonitorMutationAccess(
        authorizationService,
        messageCheckinService,
        payload,
      );

      return yield* messageCheckinService.addMessageCheckinMembers(payload, payload.memberIds);
    }),
    "messageCheckin.persistMessageCheckin": Effect.fnUntraced(function* ({ payload }) {
      yield* requireCheckinUpsertAccess(
        authorizationService,
        messageCheckinService,
        payload,
        Predicate.isString(payload.data.workspaceId) ? payload.data.workspaceId : undefined,
      );

      return yield* messageCheckinService.persistMessageCheckin(payload, {
        data: payload.data,
        memberIds: payload.memberIds,
      });
    }),
    "messageCheckin.removeMessageCheckin": Effect.fnUntraced(function* ({ payload }) {
      yield* requireMessageCheckinMonitorMutationAccess(
        authorizationService,
        messageCheckinService,
        payload,
      );

      yield* messageCheckinService.removeMessageCheckin(payload);
    }),
    "messageCheckin.setMessageCheckinMemberCheckinAt": Effect.fnUntraced(function* ({ payload }) {
      yield* requireMessageCheckinParticipantMutationAccess(
        authorizationService,
        messageCheckinService,
        payload,
        payload.memberId,
      );

      return yield* messageCheckinService.setMessageCheckinMemberCheckinAt(
        payload,
        payload.memberId,
        payload.checkinAt,
      );
    }),
    "messageCheckin.setMessageCheckinMemberCheckinAtIfUnset": Effect.fnUntraced(function* ({
      payload,
    }) {
      yield* requireMessageCheckinParticipantMutationAccess(
        authorizationService,
        messageCheckinService,
        payload,
        payload.memberId,
      );

      return yield* messageCheckinService.setMessageCheckinMemberCheckinAtIfUnset(
        payload,
        payload.memberId,
        payload.checkinAt,
        payload.checkinClaimId,
      );
    }),
    "messageCheckin.removeMessageCheckinMember": Effect.fnUntraced(function* ({ payload }) {
      yield* requireMessageCheckinParticipantMutationAccess(
        authorizationService,
        messageCheckinService,
        payload,
        payload.memberId,
      );

      return yield* messageCheckinService.removeMessageCheckinMember(payload, payload.memberId);
    }),
  } satisfies HandlerMap<"messageCheckin">;
});

export const messageCheckinLayer = sheetApisGroupLayer(
  "messageCheckin",
  messageCheckinHandlers,
).pipe(Layer.provide([AuthorizationService.layer, MessageCheckinService.layer]));
