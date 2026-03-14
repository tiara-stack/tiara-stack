import { Effect, pipe } from "effect";
import { SheetApisClient } from "./sheetApis";

export class ScheduleService extends Effect.Service<ScheduleService>()("ScheduleService", {
  effect: pipe(
    Effect.all({ sheetApisClient: SheetApisClient }),
    Effect.map(({ sheetApisClient }) => ({
      // Filler populated schedules - filtered by visible, with fill/overfill/standby/runners cleared
      allPopulatedFillerSchedules: Effect.fn("Schedule.allPopulatedFillerSchedules")(
        (guildId: string) =>
          sheetApisClient.get().schedule.getAllPopulatedFillerSchedules({ urlParams: { guildId } }),
      ),
      dayPopulatedFillerSchedules: Effect.fn("Schedule.dayPopulatedFillerSchedules")(
        (guildId: string, day: number) =>
          sheetApisClient
            .get()
            .schedule.getDayPopulatedFillerSchedules({ urlParams: { guildId, day } }),
      ),
      channelPopulatedFillerSchedules: Effect.fn("Schedule.channelPopulatedFillerSchedules")(
        (guildId: string, channel: string) =>
          sheetApisClient
            .get()
            .schedule.getChannelPopulatedFillerSchedules({ urlParams: { guildId, channel } }),
      ),
      // Manager populated schedules - full access, requires manager authorization
      allPopulatedManagerSchedules: Effect.fn("Schedule.allPopulatedManagerSchedules")(
        (guildId: string) =>
          sheetApisClient
            .get()
            .scheduleManager.getAllPopulatedManagerSchedules({ urlParams: { guildId } }),
      ),
      dayPopulatedManagerSchedules: Effect.fn("Schedule.dayPopulatedManagerSchedules")(
        (guildId: string, day: number) =>
          sheetApisClient
            .get()
            .scheduleManager.getDayPopulatedManagerSchedules({ urlParams: { guildId, day } }),
      ),
      channelPopulatedManagerSchedules: Effect.fn("Schedule.channelPopulatedManagerSchedules")(
        (guildId: string, channel: string) =>
          sheetApisClient.get().scheduleManager.getChannelPopulatedManagerSchedules({
            urlParams: { guildId, channel },
          }),
      ),
    })),
  ),
  dependencies: [SheetApisClient.Default],
  accessors: true,
}) {}
