import { Effect, Option, Predicate } from "effect";
import { SheetAuthUser } from "sheet-ingress-api/internal";
import type { DispatchAuthorizationSnapshot } from "sheet-ingress-api/internal";
import { ArgumentError, makeArgumentError, Unauthorized } from "typhoon-core/error";
import {
  AuthorizationService,
  hasDiscordAccountPermission,
  hasPermission,
  hasWorkspacePermission,
} from "../services/authorization";
import { requireModernMessageGuildId } from "../services/messageAuthorization";
import { MessageLookup } from "../services/messageLookup";
import { authorizedSheetApis } from "./sheetApisProxy";
import type { SheetApisEndpointName, SheetApisGroupName, SheetApisProxyRequest } from "./types";

type WorkflowAuthorizationSnapshot = DispatchAuthorizationSnapshot;

const missingMessage = (kind: string) =>
  makeArgumentError(`Cannot get ${kind}, the message might not be registered`);

const legacyDenied = (kind: string) =>
  Effect.fail(new Unauthorized({ message: `Legacy ${kind} records are no longer accessible` }));

const isArgumentError = (cause: unknown): cause is ArgumentError =>
  Predicate.isTagged("ArgumentError")(cause);

const isUnauthorized = (cause: unknown): cause is Unauthorized =>
  Predicate.isTagged("Unauthorized")(cause);

const authorizationArgumentError = (kind: string) => (cause: unknown) =>
  isArgumentError(cause) ? cause : makeArgumentError(`Cannot authorize ${kind}`, cause);

const authorizationUnauthorized = (kind: string) => (cause: unknown) =>
  isUnauthorized(cause) ? cause : new Unauthorized({ message: `Cannot authorize ${kind}`, cause });

const authorizationReadError = (kind: string) => (cause: unknown) =>
  isUnauthorized(cause) ? cause : makeArgumentError(`Cannot authorize ${kind}`, cause);

type QueryOf<Request> = Request extends { readonly query: infer Query } ? Query : never;
type PayloadOf<Request> = Request extends { readonly payload: infer Payload } ? Payload : never;

const extractQuery = <Request>(args: Request) =>
  (args as { readonly query: QueryOf<Request> }).query;

const extractPayload = <Request>(args: Request) =>
  (args as { readonly payload: PayloadOf<Request> }).payload;

export const requireService = () =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    yield* authorization.requireService();
  });

export const requireNonService = () =>
  Effect.gen(function* () {
    const user = yield* SheetAuthUser;
    if (hasPermission(user.permissions, "service")) {
      return yield* Effect.fail(
        new Unauthorized({ message: "Service users cannot call Discord user endpoints" }),
      );
    }
  });

export const requireGuild = (scope: "member" | "monitor" | "manage", guildId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    const requireScope = {
      member: authorization.requireWorkspaceMember,
      monitor: authorization.requireMonitorWorkspace,
      manage: authorization.requireManageWorkspace,
    } as const;
    yield* requireScope[scope](guildId);
  });

export const requireGuildSnapshot = (
  scope: WorkflowAuthorizationSnapshot["scope"],
  guildId: string,
) => requireGuild(scope, guildId).pipe(Effect.as({ workspaceId: guildId, scope }));

const requireSelfOrMonitor = (guildId: string, accountId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    yield* authorization.requireDiscordAccountIdOrMonitorGuild(guildId, accountId);
  });

export const requireSelfOrMonitorSnapshot = (guildId: string, accountId: string) =>
  Effect.gen(function* () {
    const user = yield* SheetAuthUser;
    yield* requireSelfOrMonitor(guildId, accountId);
    return user.accountId === accountId
      ? undefined
      : { workspaceId: guildId, scope: "monitor" as const };
  });

export const serviceOnly = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
>(
  group: GroupName,
  endpoint: EndpointName,
) =>
  authorizedSheetApis(group, endpoint, () =>
    requireService().pipe(Effect.mapError(authorizationArgumentError(`${group}.${endpoint}`))),
  );

const guildRequest = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
  Value,
>(
  group: GroupName,
  endpoint: EndpointName,
  scope: "member" | "monitor" | "manage",
  extract: (args: SheetApisProxyRequest<GroupName, EndpointName>) => Value,
  selectGuildId: (value: Value) => string,
) =>
  authorizedSheetApis(group, endpoint, (args) =>
    requireGuild(scope, selectGuildId(extract(args))).pipe(
      Effect.mapError(authorizationArgumentError(`${group}.${endpoint}`)),
    ),
  );

export const guildQuery = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
>(
  group: GroupName,
  endpoint: EndpointName,
  scope: "member" | "monitor" | "manage",
  selectGuildId: (query: QueryOf<SheetApisProxyRequest<GroupName, EndpointName>>) => string,
) => guildRequest(group, endpoint, scope, extractQuery, selectGuildId);

export const guildPayload = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
>(
  group: GroupName,
  endpoint: EndpointName,
  scope: "member" | "monitor" | "manage",
  selectGuildId: (payload: PayloadOf<SheetApisProxyRequest<GroupName, EndpointName>>) => string,
) => guildRequest(group, endpoint, scope, extractPayload, selectGuildId);

export const singlePlayerOrMonitor = <
  GroupName extends SheetApisGroupName,
  EndpointName extends SheetApisEndpointName<GroupName>,
>(
  group: GroupName,
  endpoint: EndpointName,
  select: (query: QueryOf<SheetApisProxyRequest<GroupName, EndpointName>>) => {
    readonly guildId: string;
    readonly ids: ReadonlyArray<string>;
  },
) =>
  authorizedSheetApis(group, endpoint, (args) => {
    const { guildId, ids } = select(
      extractQuery<SheetApisProxyRequest<GroupName, EndpointName>>(args),
    );
    return (
      ids.length === 1 ? requireSelfOrMonitor(guildId, ids[0]!) : requireGuild("monitor", guildId)
    ).pipe(Effect.mapError(authorizationArgumentError(`${group}.${endpoint}`)));
  });

type ModernMessageRecord = {
  readonly workspaceId: Option.Option<string>;
  readonly conversationId: Option.Option<string>;
};

const requireMessageRecordAccess = <E, R>(
  recordEffect: Effect.Effect<Option.Option<ModernMessageRecord>, E, R>,
  kind: string,
  scope: "member" | "monitor",
) =>
  Effect.gen(function* () {
    const record = yield* recordEffect;
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage(kind));
    }
    const guildId = yield* requireModernMessageGuildId(record.value, () => legacyDenied(kind));
    yield* requireGuild(scope, guildId);
  });

const requireMessageRecordUpsert = <E, R>(
  recordEffect: Effect.Effect<Option.Option<ModernMessageRecord>, E, R>,
  guildId: string | undefined,
  kind: string,
) =>
  Effect.gen(function* () {
    const existing = yield* recordEffect;
    const resolvedGuildId = Option.isSome(existing)
      ? yield* Effect.gen(function* () {
          const storedGuildId = yield* requireModernMessageGuildId(existing.value, () =>
            legacyDenied(kind),
          );
          if (Predicate.isString(guildId) && guildId !== storedGuildId) {
            return yield* Effect.fail(
              makeArgumentError(`Cannot move an existing ${kind} to another guild`),
            );
          }
          return storedGuildId;
        })
      : Predicate.isString(guildId)
        ? guildId
        : yield* Effect.fail(
            makeArgumentError(`Cannot upsert ${kind}, guildId is required for new records`),
          );
    yield* requireGuild("monitor", resolvedGuildId);
  });

export const requireMessageSlotRead = (messageId: string) =>
  Effect.flatMap(MessageLookup, (messages) =>
    requireMessageRecordAccess(messages.getMessageSlotData(messageId), "message slot", "member"),
  ).pipe(Effect.mapError(authorizationArgumentError("message slot")));

export const requireMessageSlotUpsert = (messageId: string, guildId?: string) =>
  Effect.flatMap(MessageLookup, (messages) =>
    requireMessageRecordUpsert(messages.getMessageSlotData(messageId), guildId, "message slot"),
  ).pipe(Effect.mapError(authorizationUnauthorized("message slot")));

export const requireRoomOrderMonitor = (messageId: string) =>
  Effect.flatMap(MessageLookup, (messages) =>
    requireMessageRecordAccess(
      messages.getMessageRoomOrder(messageId),
      "message room order",
      "monitor",
    ),
  ).pipe(Effect.mapError(authorizationArgumentError("message room order")));

export const requireRoomOrderUpsert = (messageId: string, guildId?: string) =>
  Effect.flatMap(MessageLookup, (messages) =>
    requireMessageRecordUpsert(
      messages.getMessageRoomOrder(messageId),
      guildId,
      "message room order",
    ),
  ).pipe(Effect.mapError(authorizationUnauthorized("message room order")));

const getMessageCheckinAccess = (messageId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    const messages = yield* MessageLookup;
    const user = yield* SheetAuthUser;
    const record = yield* getMessageCheckinRecord(messageId);
    const guildId = yield* requireModernMessageGuildId(record.value, () =>
      legacyDenied("message check-in"),
    );
    const accessLevel = yield* authorization.getCurrentWorkspaceMonitorAccessLevel(guildId);
    return { accessLevel, messages, user };
  });

const getMessageCheckinRecord = (messageId: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const record = yield* messages.getMessageCheckinData(messageId);
    if (Option.isNone(record)) {
      return yield* Effect.fail(missingMessage("message checkin data"));
    }
    return record;
  });

const requireRecordedParticipant = (
  members: ReadonlyArray<{ readonly memberId: string }>,
  accountId: string,
) =>
  members.some((member) => member.memberId === accountId)
    ? Effect.void
    : Effect.fail(
        new Unauthorized({
          message: "User is not a recorded participant on this check-in message",
        }),
      );

export const requireMessageCheckinRead = (messageId: string) =>
  Effect.gen(function* () {
    const { accessLevel, messages, user } = yield* getMessageCheckinAccess(messageId);
    if (accessLevel === "monitor") {
      return;
    }
    if (accessLevel !== "member") {
      return yield* Effect.fail(
        new Unauthorized({ message: "User is not a member of this guild" }),
      );
    }
    const members = yield* messages.getMessageCheckinMembers(messageId);
    yield* requireRecordedParticipant(members, user.accountId);
  }).pipe(Effect.mapError(authorizationReadError("message check-in")));

export const getAuthorizedMessageCheckinMembers = (messageId: string) =>
  Effect.gen(function* () {
    const { accessLevel, messages, user } = yield* getMessageCheckinAccess(messageId);
    const hasReadAccess = ["member", "monitor"].includes(accessLevel);
    if (!hasReadAccess) {
      return yield* Effect.fail(
        new Unauthorized({ message: "User is not a member of this guild" }),
      );
    }
    const members = yield* messages.getMessageCheckinMembers(messageId);
    if (accessLevel === "monitor") {
      return members;
    }
    yield* requireRecordedParticipant(members, user.accountId);
    return members;
  }).pipe(Effect.mapError(authorizationReadError("message checkin members")));

export const requireMessageCheckinMonitor = (messageId: string) =>
  Effect.flatMap(MessageLookup, (messages) =>
    requireMessageRecordAccess(
      messages.getMessageCheckinData(messageId),
      "message check-in",
      "monitor",
    ),
  ).pipe(Effect.mapError(authorizationArgumentError("message check-in")));

export const requireMessageCheckinParticipantMutation = (messageId: string, memberId: string) =>
  Effect.gen(function* () {
    const messages = yield* MessageLookup;
    const user = yield* SheetAuthUser;
    const record = yield* getMessageCheckinRecord(messageId);
    const guildId = yield* requireModernMessageGuildId(record.value, () =>
      legacyDenied("message check-in"),
    );
    const isPrivileged = [
      hasPermission(user.permissions, "service"),
      hasPermission(user.permissions, "app_owner"),
    ].some(Predicate.isTruthy);
    if (isPrivileged) {
      return;
    }
    const authorization = yield* AuthorizationService;
    if (!hasDiscordAccountPermission(user.permissions, memberId)) {
      return yield* Effect.fail(
        new Unauthorized({ message: "User does not have access to this user" }),
      );
    }
    yield* authorization.requireWorkspaceMember(guildId);
    const members = yield* messages.getMessageCheckinMembers(messageId);
    yield* requireRecordedParticipant(members, memberId);
  }).pipe(Effect.mapError(authorizationReadError("message check-in participant")));

export const requireMessageCheckinUpsert = (messageId: string, guildId?: string) =>
  Effect.flatMap(MessageLookup, (messages) =>
    requireMessageRecordUpsert(
      messages.getMessageCheckinData(messageId),
      guildId,
      "message check-in",
    ),
  ).pipe(Effect.mapError(authorizationUnauthorized("message check-in")));

export const requireDayPlayerSchedule = (guildId: string, accountId: string) =>
  Effect.gen(function* () {
    const authorization = yield* AuthorizationService;
    const resolvedUser = yield* authorization.resolveCurrentWorkspaceUser(guildId);
    const canAccess = [
      resolvedUser.accountId === accountId,
      hasPermission(resolvedUser.permissions, "service"),
      hasPermission(resolvedUser.permissions, "app_owner"),
      hasWorkspacePermission(resolvedUser.permissions, "monitor_workspace", guildId),
    ].some(Predicate.isTruthy);
    if (!canAccess) {
      return yield* Effect.fail(
        new Unauthorized({ message: "User does not have access to this user" }),
      );
    }
  });
