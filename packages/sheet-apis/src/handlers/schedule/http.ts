import { HttpApiBuilder } from "@effect/platform";
import { Effect, Layer, Option, pipe } from "effect";
import { Api } from "@/api";
import { ScheduleService } from "@/services/schedule";
import { GuildConfigService } from "@/services/guildConfig";
import { SheetAuthTokenAuthorizationLive } from "@/middlewares/sheetAuthTokenAuthorization/live";
import { SheetAuthTokenGuildMonitorAuthorizationLive } from "@/middlewares/sheetAuthTokenGuildMonitorAuthorization/live";

const getSheetIdFromGuildId = (guildId: string, guildConfigService: GuildConfigService) =>
  pipe(
    guildConfigService.getGuildConfigByGuildId(guildId),
    Effect.flatMap(
      Option.match({
        onSome: (guildConfig) =>
          pipe(
            guildConfig.sheetId,
            Option.match({
              onSome: Effect.succeed,
              onNone: () => Effect.die(new Error(`sheetId not found for guildId: ${guildId}`)),
            }),
          ),
        onNone: () => Effect.die(new Error(`Guild config not found for guildId: ${guildId}`)),
      }),
    ),
  );

export const ScheduleLive = HttpApiBuilder.group(Api, "schedule", (handlers) =>
  pipe(
    Effect.all({
      scheduleService: ScheduleService,
      guildConfigService: GuildConfigService,
    }),
    Effect.map(({ scheduleService, guildConfigService }) =>
      handlers
        .handle("getAllPopulatedFillerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => scheduleService.getAllPopulatedFillerSchedules(sheetId)),
          ),
        )
        .handle("getDayPopulatedFillerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) =>
              scheduleService.getDayPopulatedFillerSchedules(sheetId, urlParams.day),
            ),
          ),
        )
        .handle("getChannelPopulatedFillerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) =>
              scheduleService.getChannelPopulatedFillerSchedules(sheetId, urlParams.channel),
            ),
          ),
        ),
    ),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ScheduleService.Default,
      GuildConfigService.Default,
      SheetAuthTokenAuthorizationLive,
    ),
  ),
);

export const ScheduleManagerLive = HttpApiBuilder.group(Api, "scheduleManager", (handlers) =>
  pipe(
    Effect.all({
      scheduleService: ScheduleService,
      guildConfigService: GuildConfigService,
    }),
    Effect.map(({ scheduleService, guildConfigService }) =>
      handlers
        .handle("getAllPopulatedManagerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => scheduleService.getAllPopulatedSchedules(sheetId)),
          ),
        )
        .handle("getDayPopulatedManagerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) =>
              scheduleService.getDayPopulatedSchedules(sheetId, urlParams.day),
            ),
          ),
        )
        .handle("getChannelPopulatedManagerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) =>
              scheduleService.getChannelPopulatedSchedules(sheetId, urlParams.channel),
            ),
          ),
        ),
    ),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      ScheduleService.Default,
      GuildConfigService.Default,
      SheetAuthTokenGuildMonitorAuthorizationLive,
    ),
  ),
);
