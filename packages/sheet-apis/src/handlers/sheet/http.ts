import { HttpApiBuilder } from "@effect/platform";
import { Effect, Layer, Option, pipe } from "effect";
import { Api } from "@/api";
import { SheetService } from "@/services/sheet";
import { SheetConfigService } from "@/services/sheetConfig";
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

export const SheetLive = HttpApiBuilder.group(Api, "sheet", (handlers) =>
  pipe(
    Effect.all({
      sheetService: SheetService,
      sheetConfigService: SheetConfigService,
      guildConfigService: GuildConfigService,
    }),
    Effect.map(({ sheetService, sheetConfigService, guildConfigService }) =>
      handlers
        .handle("getPlayers", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetService.getPlayers(sheetId)),
          ),
        )
        .handle("getMonitors", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetService.getMonitors(sheetId)),
          ),
        )
        .handle("getTeams", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetService.getTeams(sheetId)),
          ),
        )
        .handle("getAllFillerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetService.getAllFillerSchedules(sheetId)),
          ),
        )
        .handle("getDayFillerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetService.getDayFillerSchedules(sheetId, urlParams.day)),
          ),
        )
        .handle("getChannelFillerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) =>
              sheetService.getChannelFillerSchedules(sheetId, urlParams.channel),
            ),
          ),
        )
        .handle("getRangesConfig", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetConfigService.getRangesConfig(sheetId)),
          ),
        )
        .handle("getTeamConfig", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetConfigService.getTeamConfig(sheetId)),
          ),
        )
        .handle("getEventConfig", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetConfigService.getEventConfig(sheetId)),
          ),
        )
        .handle("getScheduleConfig", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetConfigService.getScheduleConfig(sheetId)),
          ),
        )
        .handle("getRunnerConfig", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetConfigService.getRunnerConfig(sheetId)),
          ),
        ),
    ),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetService.Default,
      SheetConfigService.Default,
      GuildConfigService.Default,
      SheetAuthTokenAuthorizationLive,
    ),
  ),
);

export const SheetManagerLive = HttpApiBuilder.group(Api, "sheetManager", (handlers) =>
  pipe(
    Effect.all({
      sheetService: SheetService,
      sheetConfigService: SheetConfigService,
      guildConfigService: GuildConfigService,
    }),
    Effect.map(({ sheetService, guildConfigService }) =>
      handlers
        .handle("getAllManagerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetService.getAllSchedules(sheetId)),
          ),
        )
        .handle("getDayManagerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) => sheetService.getDaySchedules(sheetId, urlParams.day)),
          ),
        )
        .handle("getChannelManagerSchedules", ({ urlParams }) =>
          pipe(
            getSheetIdFromGuildId(urlParams.guildId, guildConfigService),
            Effect.flatMap((sheetId) =>
              sheetService.getChannelSchedules(sheetId, urlParams.channel),
            ),
          ),
        ),
    ),
  ),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      SheetService.Default,
      SheetConfigService.Default,
      GuildConfigService.Default,
      SheetAuthTokenGuildMonitorAuthorizationLive,
    ),
  ),
);
