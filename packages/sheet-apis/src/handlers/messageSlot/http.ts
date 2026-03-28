import { HttpApiBuilder } from "@effect/platform";
import { catchParseErrorAsValidationError, makeArgumentError } from "typhoon-core/error";
import { Effect, Layer, Option, pipe } from "effect";
import { Api } from "@/api";
import { getModernMessageGuildId } from "@/handlers/message/shared";
import {
  provideCurrentGuildUser,
  requireGuildMember,
  requireMonitorGuild,
} from "@/middlewares/authorization";
import { SheetAuthTokenAuthorizationLive } from "@/middlewares/sheetAuthTokenAuthorization/live";
import { GuildConfigService } from "@/services/guildConfig";
import { MessageSlotService } from "@/services/messageSlot";
import { Unauthorized } from "@/schemas/middlewares/unauthorized";

const missingMessageSlotError = () =>
  makeArgumentError("Cannot get message slot data, the message might not be registered");

export const LEGACY_MESSAGE_SLOT_ACCESS_ERROR =
  "Legacy message slot records are no longer accessible";

export const denyLegacyMessageSlotAccess = () =>
  Effect.fail(new Unauthorized({ message: LEGACY_MESSAGE_SLOT_ACCESS_ERROR }));

const getRequiredMessageSlotRecord = (messageSlotService: MessageSlotService, messageId: string) =>
  messageSlotService.getMessageSlotData(messageId).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(missingMessageSlotError()),
      }),
    ),
  );

export const requireMessageSlotUpsertAccess = (
  messageSlotService: MessageSlotService,
  messageId: string,
  guildId?: string,
) =>
  messageSlotService.getMessageSlotData(messageId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          typeof guildId === "string"
            ? provideCurrentGuildUser(guildId, requireMonitorGuild(guildId))
            : denyLegacyMessageSlotAccess(),
        onSome: (record) =>
          Option.match(getModernMessageGuildId(record), {
            onSome: (resolvedGuildId) =>
              provideCurrentGuildUser(resolvedGuildId, requireMonitorGuild(resolvedGuildId)),
            onNone: denyLegacyMessageSlotAccess,
          }),
      }),
    ),
  );

export const requireMessageSlotReadAccess = (
  messageSlotService: MessageSlotService,
  messageId: string,
) =>
  getRequiredMessageSlotRecord(messageSlotService, messageId).pipe(
    Effect.flatMap((record) =>
      Option.match(getModernMessageGuildId(record), {
        onSome: (guildId) =>
          provideCurrentGuildUser(
            guildId,
            requireGuildMember(guildId).pipe(Effect.andThen(Effect.succeed(record))),
          ),
        onNone: denyLegacyMessageSlotAccess,
      }),
    ),
  );

export const MessageSlotLive = HttpApiBuilder.group(Api, "messageSlot", (handlers) =>
  pipe(
    Effect.all({
      messageSlotService: MessageSlotService,
    }),
    Effect.map(({ messageSlotService }) =>
      handlers
        .handle("getMessageSlotData", ({ urlParams }) =>
          requireMessageSlotReadAccess(messageSlotService, urlParams.messageId).pipe(
            catchParseErrorAsValidationError,
          ),
        )
        .handle("upsertMessageSlotData", ({ payload }) =>
          requireMessageSlotUpsertAccess(
            messageSlotService,
            payload.messageId,
            typeof payload.data.guildId === "string" ? payload.data.guildId : undefined,
          )
            .pipe(
              Effect.andThen(
                messageSlotService.upsertMessageSlotData(payload.messageId, payload.data),
              ),
            )
            .pipe(catchParseErrorAsValidationError),
        ),
    ),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      MessageSlotService.Default,
      GuildConfigService.Default,
      SheetAuthTokenAuthorizationLive,
    ),
  ),
);
