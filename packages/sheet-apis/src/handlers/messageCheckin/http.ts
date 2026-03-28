import { HttpApiBuilder } from "@effect/platform";
import { catchParseErrorAsValidationError, makeArgumentError } from "typhoon-core/error";
import { Effect, HashSet, Layer, Option, pipe } from "effect";
import { Api } from "@/api";
import { getModernMessageGuildId } from "@/handlers/message/shared";
import {
  getGuildMonitorAccessLevel,
  provideCurrentGuildUser,
  requireDiscordAccountId,
  requireGuildMember,
  requireMonitorGuild,
} from "@/middlewares/authorization";
import { SheetAuthTokenAuthorizationLive } from "@/middlewares/sheetAuthTokenAuthorization/live";
import { MessageCheckinMember } from "@/schemas/messageCheckin";
import { SheetAuthUser } from "@/schemas/middlewares/sheetAuthUser";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";
import { GuildConfigService } from "@/services/guildConfig";
import { MessageCheckinService } from "@/services/messageCheckin";

const missingMessageCheckinError = () =>
  makeArgumentError("Cannot get message checkin data, the message might not be registered");

export const LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR =
  "Legacy message check-in records are no longer accessible";

export const denyLegacyMessageCheckinAccess = () =>
  Effect.fail(new Unauthorized({ message: LEGACY_MESSAGE_CHECKIN_ACCESS_ERROR }));

const getRequiredMessageCheckinRecord = (
  messageCheckinService: MessageCheckinService,
  messageId: string,
) =>
  messageCheckinService.getMessageCheckinData(messageId).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(missingMessageCheckinError()),
      }),
    ),
  );

const requireRecordedParticipant = (
  members: ReadonlyArray<MessageCheckinMember>,
  memberId: string,
  message = "User is not a recorded participant on this check-in message",
) =>
  members.some((member) => member.memberId === memberId)
    ? Effect.void
    : Effect.fail(new Unauthorized({ message }));

const getCheckinAccessLevel = (user: SheetAuthUser["Type"], guildId: string) =>
  getGuildMonitorAccessLevel(user, guildId).pipe(
    Effect.flatMap((accessLevel) =>
      accessLevel === "monitor"
        ? Effect.succeed<"monitor" | "participant">("monitor")
        : accessLevel === "member"
          ? Effect.succeed<"monitor" | "participant">("participant")
          : Effect.fail(new Unauthorized({ message: "User is not a member of this guild" })),
    ),
  );

type CheckinReadAccess =
  | { readonly _tag: "monitor" }
  | { readonly _tag: "participant"; readonly members: ReadonlyArray<MessageCheckinMember> };

const resolveCheckinReadAccess = (
  messageCheckinService: MessageCheckinService,
  messageId: string,
  guildId: string,
) =>
  SheetAuthUser.pipe(
    Effect.flatMap((user) =>
      // Participant reads still need the current member list because that is
      // the authoritative recorded-participant check available in this pass.
      getCheckinAccessLevel(user, guildId).pipe(
        Effect.flatMap((accessLevel) =>
          accessLevel === "monitor"
            ? Effect.succeed<CheckinReadAccess>({ _tag: "monitor" })
            : messageCheckinService.getMessageCheckinMembers(messageId).pipe(
                Effect.flatMap((members) =>
                  requireRecordedParticipant(members, user.accountId).pipe(
                    Effect.as<CheckinReadAccess>({
                      _tag: "participant",
                      members,
                    }),
                  ),
                ),
              ),
        ),
      ),
    ),
  );

export const requireCheckinUpsertAccess = (
  messageCheckinService: MessageCheckinService,
  messageId: string,
  guildId?: string,
) =>
  messageCheckinService.getMessageCheckinData(messageId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          typeof guildId === "string"
            ? provideCurrentGuildUser(guildId, requireMonitorGuild(guildId))
            : denyLegacyMessageCheckinAccess(),
        onSome: (record) =>
          Option.match(getModernMessageGuildId(record), {
            onSome: (resolvedGuildId) =>
              provideCurrentGuildUser(resolvedGuildId, requireMonitorGuild(resolvedGuildId)),
            onNone: denyLegacyMessageCheckinAccess,
          }),
      }),
    ),
  );

export const requireCheckinMutationAccess = (
  messageCheckinService: MessageCheckinService,
  messageId: string,
  guildId: string,
  memberId: string,
) =>
  SheetAuthUser.pipe(
    Effect.flatMap((user) =>
      HashSet.has(user.permissions, "bot") || HashSet.has(user.permissions, "app_owner")
        ? Effect.void
        : // Non-legacy check-in mutations remain self-service for regular users:
          // monitors can add members, but only the recorded participant can update/remove that member.
          requireDiscordAccountId(memberId).pipe(
            Effect.andThen(provideCurrentGuildUser(guildId, requireGuildMember(guildId))),
            Effect.andThen(messageCheckinService.getMessageCheckinMembers(messageId)),
            Effect.flatMap((members) => requireRecordedParticipant(members, memberId)),
          ),
    ),
  );

export const requireMessageCheckinReadAccess = (
  messageCheckinService: MessageCheckinService,
  messageId: string,
) =>
  getRequiredMessageCheckinRecord(messageCheckinService, messageId).pipe(
    Effect.flatMap((record) =>
      Option.match(getModernMessageGuildId(record), {
        onSome: (guildId) =>
          resolveCheckinReadAccess(messageCheckinService, messageId, guildId).pipe(
            Effect.as(record),
          ),
        onNone: denyLegacyMessageCheckinAccess,
      }),
    ),
  );

export const requireMessageCheckinMembersReadAccess = (
  messageCheckinService: MessageCheckinService,
  messageId: string,
) =>
  getRequiredMessageCheckinRecord(messageCheckinService, messageId).pipe(
    Effect.flatMap((record) =>
      Option.match(getModernMessageGuildId(record), {
        onSome: (guildId) =>
          resolveCheckinReadAccess(messageCheckinService, messageId, guildId).pipe(
            Effect.flatMap((access) =>
              access._tag === "monitor"
                ? messageCheckinService.getMessageCheckinMembers(messageId)
                : Effect.succeed(access.members),
            ),
          ),
        onNone: denyLegacyMessageCheckinAccess,
      }),
    ),
  );

export const requireMessageCheckinParticipantMutationAccess = (
  messageCheckinService: MessageCheckinService,
  messageId: string,
  memberId: string,
) =>
  getRequiredMessageCheckinRecord(messageCheckinService, messageId).pipe(
    Effect.flatMap((record) =>
      Option.match(getModernMessageGuildId(record), {
        onSome: (guildId) =>
          requireCheckinMutationAccess(messageCheckinService, messageId, guildId, memberId),
        onNone: denyLegacyMessageCheckinAccess,
      }),
    ),
  );

export const requireMessageCheckinMonitorMutationAccess = (
  messageCheckinService: MessageCheckinService,
  messageId: string,
) =>
  getRequiredMessageCheckinRecord(messageCheckinService, messageId).pipe(
    Effect.flatMap((record) =>
      Option.match(getModernMessageGuildId(record), {
        onSome: (guildId) => provideCurrentGuildUser(guildId, requireMonitorGuild(guildId)),
        onNone: denyLegacyMessageCheckinAccess,
      }),
    ),
  );

export const MessageCheckinLive = HttpApiBuilder.group(Api, "messageCheckin", (handlers) =>
  pipe(
    Effect.all({
      messageCheckinService: MessageCheckinService,
    }),
    Effect.map(({ messageCheckinService }) =>
      handlers
        .handle("getMessageCheckinData", ({ urlParams }) =>
          requireMessageCheckinReadAccess(messageCheckinService, urlParams.messageId).pipe(
            catchParseErrorAsValidationError,
          ),
        )
        .handle("upsertMessageCheckinData", ({ payload }) =>
          requireCheckinUpsertAccess(
            messageCheckinService,
            payload.messageId,
            typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
          )
            .pipe(
              Effect.andThen(
                messageCheckinService.upsertMessageCheckinData(payload.messageId, payload.data),
              ),
            )
            .pipe(catchParseErrorAsValidationError),
        )
        .handle("getMessageCheckinMembers", ({ urlParams }) =>
          requireMessageCheckinMembersReadAccess(messageCheckinService, urlParams.messageId).pipe(
            catchParseErrorAsValidationError,
          ),
        )
        .handle("addMessageCheckinMembers", ({ payload }) =>
          requireMessageCheckinMonitorMutationAccess(messageCheckinService, payload.messageId)
            .pipe(
              Effect.andThen(
                messageCheckinService.addMessageCheckinMembers(
                  payload.messageId,
                  payload.memberIds,
                ),
              ),
            )
            .pipe(catchParseErrorAsValidationError),
        )
        .handle("setMessageCheckinMemberCheckinAt", ({ payload }) =>
          requireMessageCheckinParticipantMutationAccess(
            messageCheckinService,
            payload.messageId,
            payload.memberId,
          )
            .pipe(
              Effect.andThen(
                messageCheckinService.setMessageCheckinMemberCheckinAt(
                  payload.messageId,
                  payload.memberId,
                  payload.checkinAt,
                ),
              ),
            )
            .pipe(catchParseErrorAsValidationError),
        )
        .handle("removeMessageCheckinMember", ({ payload }) =>
          requireMessageCheckinParticipantMutationAccess(
            messageCheckinService,
            payload.messageId,
            payload.memberId,
          )
            .pipe(
              Effect.andThen(
                messageCheckinService.removeMessageCheckinMember(
                  payload.messageId,
                  payload.memberId,
                ),
              ),
            )
            .pipe(catchParseErrorAsValidationError),
        ),
    ),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      MessageCheckinService.Default,
      GuildConfigService.Default,
      SheetAuthTokenAuthorizationLive,
    ),
  ),
);
