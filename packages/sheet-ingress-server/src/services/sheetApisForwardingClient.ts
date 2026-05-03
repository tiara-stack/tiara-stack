import { Context, Effect, Layer } from "effect";
import { SheetApisRpcClient } from "./sheetApisRpcClient";

export class SheetApisForwardingClient extends Context.Service<SheetApisForwardingClient>()(
  "SheetApisForwardingClient",
  {
    make: Effect.gen(function* () {
      const rpcClient = yield* SheetApisRpcClient;

      const call =
        <Input, A, E, R>(fn: (args: Input) => Effect.Effect<A, E, R>) =>
        (args: Input) =>
          fn(args);
      const callNoInput =
        <A, E, R>(fn: (args: undefined) => Effect.Effect<A, E, R>) =>
        () =>
          fn(undefined);

      return {
        calc: {
          calcBot: call(rpcClient["calc.calcBot"]),
          calcSheet: call(rpcClient["calc.calcSheet"]),
        },
        checkin: {
          generate: call(rpcClient["checkin.generate"]),
          dispatch: call(rpcClient["checkin.dispatch"]),
          handleButton: call(rpcClient["checkin.handleButton"]),
        },
        discord: {
          getCurrentUser: callNoInput(rpcClient["discord.getCurrentUser"]),
          getCurrentUserGuilds: callNoInput(rpcClient["discord.getCurrentUserGuilds"]),
        },
        guildConfig: {
          getAutoCheckinGuilds: callNoInput(rpcClient["guildConfig.getAutoCheckinGuilds"]),
          getGuildConfig: call(rpcClient["guildConfig.getGuildConfig"]),
          upsertGuildConfig: call(rpcClient["guildConfig.upsertGuildConfig"]),
          getGuildMonitorRoles: call(rpcClient["guildConfig.getGuildMonitorRoles"]),
          getGuildChannels: call(rpcClient["guildConfig.getGuildChannels"]),
          addGuildMonitorRole: call(rpcClient["guildConfig.addGuildMonitorRole"]),
          removeGuildMonitorRole: call(rpcClient["guildConfig.removeGuildMonitorRole"]),
          upsertGuildChannelConfig: call(rpcClient["guildConfig.upsertGuildChannelConfig"]),
          getGuildChannelById: call(rpcClient["guildConfig.getGuildChannelById"]),
          getGuildChannelByName: call(rpcClient["guildConfig.getGuildChannelByName"]),
        },
        messageCheckin: {
          getMessageCheckinData: call(rpcClient["messageCheckin.getMessageCheckinData"]),
          upsertMessageCheckinData: call(rpcClient["messageCheckin.upsertMessageCheckinData"]),
          getMessageCheckinMembers: call(rpcClient["messageCheckin.getMessageCheckinMembers"]),
          addMessageCheckinMembers: call(rpcClient["messageCheckin.addMessageCheckinMembers"]),
          persistMessageCheckin: call(rpcClient["messageCheckin.persistMessageCheckin"]),
          setMessageCheckinMemberCheckinAt: call(
            rpcClient["messageCheckin.setMessageCheckinMemberCheckinAt"],
          ),
          removeMessageCheckinMember: call(rpcClient["messageCheckin.removeMessageCheckinMember"]),
        },
        messageRoomOrder: {
          getMessageRoomOrder: call(rpcClient["messageRoomOrder.getMessageRoomOrder"]),
          upsertMessageRoomOrder: call(rpcClient["messageRoomOrder.upsertMessageRoomOrder"]),
          persistMessageRoomOrder: call(rpcClient["messageRoomOrder.persistMessageRoomOrder"]),
          decrementMessageRoomOrderRank: call(
            rpcClient["messageRoomOrder.decrementMessageRoomOrderRank"],
          ),
          incrementMessageRoomOrderRank: call(
            rpcClient["messageRoomOrder.incrementMessageRoomOrderRank"],
          ),
          getMessageRoomOrderEntry: call(rpcClient["messageRoomOrder.getMessageRoomOrderEntry"]),
          getMessageRoomOrderRange: call(rpcClient["messageRoomOrder.getMessageRoomOrderRange"]),
          upsertMessageRoomOrderEntry: call(
            rpcClient["messageRoomOrder.upsertMessageRoomOrderEntry"],
          ),
          removeMessageRoomOrderEntry: call(
            rpcClient["messageRoomOrder.removeMessageRoomOrderEntry"],
          ),
        },
        messageSlot: {
          getMessageSlotData: call(rpcClient["messageSlot.getMessageSlotData"]),
          upsertMessageSlotData: call(rpcClient["messageSlot.upsertMessageSlotData"]),
        },
        monitor: {
          getMonitorMaps: call(rpcClient["monitor.getMonitorMaps"]),
          getByIds: call(rpcClient["monitor.getByIds"]),
          getByNames: call(rpcClient["monitor.getByNames"]),
        },
        permissions: {
          getCurrentUserPermissions: call(rpcClient["permissions.getCurrentUserPermissions"]),
        },
        player: {
          getPlayerMaps: call(rpcClient["player.getPlayerMaps"]),
          getByIds: call(rpcClient["player.getByIds"]),
          getByNames: call(rpcClient["player.getByNames"]),
          getTeamsByIds: call(rpcClient["player.getTeamsByIds"]),
          getTeamsByNames: call(rpcClient["player.getTeamsByNames"]),
        },
        roomOrder: {
          generate: call(rpcClient["roomOrder.generate"]),
          dispatch: call(rpcClient["roomOrder.dispatch"]),
          handleButton: call(rpcClient["roomOrder.handleButton"]),
        },
        schedule: {
          getAllPopulatedSchedules: call(rpcClient["schedule.getAllPopulatedSchedules"]),
          getDayPopulatedSchedules: call(rpcClient["schedule.getDayPopulatedSchedules"]),
          getChannelPopulatedSchedules: call(rpcClient["schedule.getChannelPopulatedSchedules"]),
          getDayPlayerSchedule: call(rpcClient["schedule.getDayPlayerSchedule"]),
        },
        screenshot: {
          getScreenshot: call(rpcClient["screenshot.getScreenshot"]),
        },
        sheet: {
          getPlayers: call(rpcClient["sheet.getPlayers"]),
          getMonitors: call(rpcClient["sheet.getMonitors"]),
          getTeams: call(rpcClient["sheet.getTeams"]),
          getAllSchedules: call(rpcClient["sheet.getAllSchedules"]),
          getDaySchedules: call(rpcClient["sheet.getDaySchedules"]),
          getChannelSchedules: call(rpcClient["sheet.getChannelSchedules"]),
          getRangesConfig: call(rpcClient["sheet.getRangesConfig"]),
          getTeamConfig: call(rpcClient["sheet.getTeamConfig"]),
          getEventConfig: call(rpcClient["sheet.getEventConfig"]),
          getScheduleConfig: call(rpcClient["sheet.getScheduleConfig"]),
          getRunnerConfig: call(rpcClient["sheet.getRunnerConfig"]),
        },
      };
    }),
  },
) {
  static layer = Layer.effect(SheetApisForwardingClient, this.make).pipe(
    Layer.provide(SheetApisRpcClient.layer),
  );
}
