import { Data, Effect, pipe } from "effect";
import { ScopedCache } from "typhoon-core/utils";
import { SheetApisClient } from "./sheetApis";

export class SheetService extends Effect.Service<SheetService>()("SheetService", {
  effect: pipe(
    Effect.all({ sheetApisClient: SheetApisClient }),
    Effect.map(({ sheetApisClient }) => ({
      getRangesConfig: Effect.fn("Sheet.getRangesConfig")((guildId: string) =>
        sheetApisClient.get().sheet.getRangesConfig({ urlParams: { guildId } }),
      ),
      getTeamConfig: Effect.fn("Sheet.getTeamConfig")((guildId: string) =>
        sheetApisClient.get().sheet.getTeamConfig({ urlParams: { guildId } }),
      ),
      getMonitors: Effect.fn("Sheet.getMonitors")((guildId: string) =>
        sheetApisClient.get().sheet.getMonitors({ urlParams: { guildId } }),
      ),
      getEventConfig: Effect.fn("Sheet.getEventConfig")((guildId: string) =>
        sheetApisClient.get().sheet.getEventConfig({ urlParams: { guildId } }),
      ),
      getScheduleConfig: Effect.fn("Sheet.getScheduleConfig")((guildId: string) =>
        sheetApisClient.get().sheet.getScheduleConfig({ urlParams: { guildId } }),
      ),
      getRunnerConfig: Effect.fn("Sheet.getRunnerConfig")((guildId: string) =>
        sheetApisClient.get().sheet.getRunnerConfig({ urlParams: { guildId } }),
      ),
      getPlayers: Effect.fn("Sheet.getPlayers")((guildId: string) =>
        sheetApisClient.get().sheet.getPlayers({ urlParams: { guildId } }),
      ),
      getTeams: Effect.fn("Sheet.getTeams")((guildId: string) =>
        sheetApisClient.get().sheet.getTeams({ urlParams: { guildId } }),
      ),
      // Filler schedules - filtered by visible, with fill/overfill/standby/runners cleared
      getAllFillerSchedules: Effect.fn("Sheet.getAllFillerSchedules")((guildId: string) =>
        sheetApisClient.get().sheet.getAllFillerSchedules({ urlParams: { guildId } }),
      ),
      getDayFillerSchedules: Effect.fn("Sheet.getDayFillerSchedules")(
        (guildId: string, day: number) =>
          sheetApisClient.get().sheet.getDayFillerSchedules({ urlParams: { guildId, day } }),
      ),
      getChannelFillerSchedules: Effect.fn("Sheet.getChannelFillerSchedules")(
        (guildId: string, channel: string) =>
          sheetApisClient
            .get()
            .sheet.getChannelFillerSchedules({ urlParams: { guildId, channel } }),
      ),
      // Manager schedules - full access, requires manager authorization
      getAllManagerSchedules: Effect.fn("Sheet.getAllManagerSchedules")((guildId: string) =>
        sheetApisClient.get().sheetManager.getAllManagerSchedules({ urlParams: { guildId } }),
      ),
      getDayManagerSchedules: Effect.fn("Sheet.getDayManagerSchedules")(
        (guildId: string, day: number) =>
          sheetApisClient
            .get()
            .sheetManager.getDayManagerSchedules({ urlParams: { guildId, day } }),
      ),
      getChannelManagerSchedules: Effect.fn("Sheet.getChannelManagerSchedules")(
        (guildId: string, channel: string) =>
          sheetApisClient
            .get()
            .sheetManager.getChannelManagerSchedules({ urlParams: { guildId, channel } }),
      ),
    })),
    Effect.flatMap((sheetMethods) =>
      Effect.all({
        getRangesConfigCache: ScopedCache.make({
          lookup: sheetMethods.getRangesConfig,
        }),
        getTeamConfigCache: ScopedCache.make({
          lookup: sheetMethods.getTeamConfig,
        }),
        getMonitorsCache: ScopedCache.make({
          lookup: sheetMethods.getMonitors,
        }),
        getEventConfigCache: ScopedCache.make({
          lookup: sheetMethods.getEventConfig,
        }),
        getScheduleConfigCache: ScopedCache.make({
          lookup: sheetMethods.getScheduleConfig,
        }),
        getRunnerConfigCache: ScopedCache.make({
          lookup: sheetMethods.getRunnerConfig,
        }),
        getPlayersCache: ScopedCache.make({
          lookup: sheetMethods.getPlayers,
        }),
        getTeamsCache: ScopedCache.make({
          lookup: sheetMethods.getTeams,
        }),
        getAllFillerSchedulesCache: ScopedCache.make({
          lookup: sheetMethods.getAllFillerSchedules,
        }),
        getDayFillerSchedulesCache: ScopedCache.make({
          lookup: ({ guildId, day }: { guildId: string; day: number }) =>
            sheetMethods.getDayFillerSchedules(guildId, day),
        }),
        getChannelFillerSchedulesCache: ScopedCache.make({
          lookup: ({ guildId, channel }: { guildId: string; channel: string }) =>
            sheetMethods.getChannelFillerSchedules(guildId, channel),
        }),
        getAllManagerSchedulesCache: ScopedCache.make({
          lookup: sheetMethods.getAllManagerSchedules,
        }),
        getDayManagerSchedulesCache: ScopedCache.make({
          lookup: ({ guildId, day }: { guildId: string; day: number }) =>
            sheetMethods.getDayManagerSchedules(guildId, day),
        }),
        getChannelManagerSchedulesCache: ScopedCache.make({
          lookup: ({ guildId, channel }: { guildId: string; channel: string }) =>
            sheetMethods.getChannelManagerSchedules(guildId, channel),
        }),
      }),
    ),
    Effect.map((caches) => ({
      getRangesConfig: (guildId: string) => caches.getRangesConfigCache.get(guildId),
      getTeamConfig: (guildId: string) => caches.getTeamConfigCache.get(guildId),
      getMonitors: (guildId: string) => caches.getMonitorsCache.get(guildId),
      getEventConfig: (guildId: string) => caches.getEventConfigCache.get(guildId),
      getScheduleConfig: (guildId: string) => caches.getScheduleConfigCache.get(guildId),
      getRunnerConfig: (guildId: string) => caches.getRunnerConfigCache.get(guildId),
      getPlayers: (guildId: string) => caches.getPlayersCache.get(guildId),
      getTeams: (guildId: string) => caches.getTeamsCache.get(guildId),
      // Filler schedules
      getAllFillerSchedules: (guildId: string) => caches.getAllFillerSchedulesCache.get(guildId),
      getDayFillerSchedules: (guildId: string, day: number) =>
        caches.getDayFillerSchedulesCache.get(Data.struct({ guildId, day })),
      getChannelFillerSchedules: (guildId: string, channel: string) =>
        caches.getChannelFillerSchedulesCache.get(Data.struct({ guildId, channel })),
      // Manager schedules
      getAllManagerSchedules: (guildId: string) => caches.getAllManagerSchedulesCache.get(guildId),
      getDayManagerSchedules: (guildId: string, day: number) =>
        caches.getDayManagerSchedulesCache.get(Data.struct({ guildId, day })),
      getChannelManagerSchedules: (guildId: string, channel: string) =>
        caches.getChannelManagerSchedulesCache.get(Data.struct({ guildId, channel })),
    })),
  ),
  dependencies: [SheetApisClient.Default],
  accessors: true,
}) {}
