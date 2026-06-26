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
        },
        discord: {
          getCurrentUser: callNoInput(rpcClient["discord.getCurrentUser"]),
          getCurrentUserGuilds: callNoInput(rpcClient["discord.getCurrentUserGuilds"]),
        },
        userConfig: {
          getCurrentUserPlatformConfig: call(rpcClient["userConfig.getCurrentUserPlatformConfig"]),
          upsertCurrentUserPlatformConfig: call(
            rpcClient["userConfig.upsertCurrentUserPlatformConfig"],
          ),
          listSupportedNotificationClients: callNoInput(
            rpcClient["userConfig.listSupportedNotificationClients"],
          ),
          getCheckinDmRecipients: call(rpcClient["userConfig.getCheckinDmRecipients"]),
          getUserPlatformConfig: call(rpcClient["userConfig.getUserPlatformConfig"]),
          upsertUserPlatformConfig: call(rpcClient["userConfig.upsertUserPlatformConfig"]),
        },
        workspaceConfig: {
          getAutoCheckinWorkspaces: callNoInput(
            rpcClient["workspaceConfig.getAutoCheckinWorkspaces"],
          ),
          getWorkspaceConfig: call(rpcClient["workspaceConfig.getWorkspaceConfig"]),
          upsertWorkspaceConfig: call(rpcClient["workspaceConfig.upsertWorkspaceConfig"]),
          getWorkspaceMonitorRoles: call(rpcClient["workspaceConfig.getWorkspaceMonitorRoles"]),
          getWorkspaceFeatureFlags: call(rpcClient["workspaceConfig.getWorkspaceFeatureFlags"]),
          getWorkspacesForFeatureFlag: call(
            rpcClient["workspaceConfig.getWorkspacesForFeatureFlag"],
          ),
          getWorkspaceUpdateAnnouncementDelivery: call(
            rpcClient["workspaceConfig.getWorkspaceUpdateAnnouncementDelivery"],
          ),
          getWorkspaceConversations: call(rpcClient["workspaceConfig.getWorkspaceConversations"]),
          addWorkspaceMonitorRole: call(rpcClient["workspaceConfig.addWorkspaceMonitorRole"]),
          removeWorkspaceMonitorRole: call(rpcClient["workspaceConfig.removeWorkspaceMonitorRole"]),
          addWorkspaceFeatureFlag: call(rpcClient["workspaceConfig.addWorkspaceFeatureFlag"]),
          removeWorkspaceFeatureFlag: call(rpcClient["workspaceConfig.removeWorkspaceFeatureFlag"]),
          recordWorkspaceUpdateAnnouncementDelivery: call(
            rpcClient["workspaceConfig.recordWorkspaceUpdateAnnouncementDelivery"],
          ),
          claimWorkspaceUpdateAnnouncementDelivery: call(
            rpcClient["workspaceConfig.claimWorkspaceUpdateAnnouncementDelivery"],
          ),
          releaseWorkspaceUpdateAnnouncementDeliveryClaim: call(
            rpcClient["workspaceConfig.releaseWorkspaceUpdateAnnouncementDeliveryClaim"],
          ),
          upsertWorkspaceConversationConfig: call(
            rpcClient["workspaceConfig.upsertWorkspaceConversationConfig"],
          ),
          getWorkspaceConversationById: call(
            rpcClient["workspaceConfig.getWorkspaceConversationById"],
          ),
          getWorkspaceConversationByName: call(
            rpcClient["workspaceConfig.getWorkspaceConversationByName"],
          ),
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
          setMessageCheckinMemberCheckinAtIfUnset: call(
            rpcClient["messageCheckin.setMessageCheckinMemberCheckinAtIfUnset"],
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
          claimMessageRoomOrderSend: call(rpcClient["messageRoomOrder.claimMessageRoomOrderSend"]),
          completeMessageRoomOrderSend: call(
            rpcClient["messageRoomOrder.completeMessageRoomOrderSend"],
          ),
          releaseMessageRoomOrderSendClaim: call(
            rpcClient["messageRoomOrder.releaseMessageRoomOrderSendClaim"],
          ),
          claimMessageRoomOrderTentativeUpdate: call(
            rpcClient["messageRoomOrder.claimMessageRoomOrderTentativeUpdate"],
          ),
          releaseMessageRoomOrderTentativeUpdateClaim: call(
            rpcClient["messageRoomOrder.releaseMessageRoomOrderTentativeUpdateClaim"],
          ),
          claimMessageRoomOrderTentativePin: call(
            rpcClient["messageRoomOrder.claimMessageRoomOrderTentativePin"],
          ),
          completeMessageRoomOrderTentativePin: call(
            rpcClient["messageRoomOrder.completeMessageRoomOrderTentativePin"],
          ),
          releaseMessageRoomOrderTentativePinClaim: call(
            rpcClient["messageRoomOrder.releaseMessageRoomOrderTentativePinClaim"],
          ),
          markMessageRoomOrderTentative: call(
            rpcClient["messageRoomOrder.markMessageRoomOrderTentative"],
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
        },
        schedule: {
          getAllPopulatedSchedules: call(rpcClient["schedule.getAllPopulatedSchedules"]),
          getDayPopulatedSchedules: call(rpcClient["schedule.getDayPopulatedSchedules"]),
          getConversationPopulatedSchedules: call(
            rpcClient["schedule.getConversationPopulatedSchedules"],
          ),
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
          getConversationSchedules: call(rpcClient["sheet.getConversationSchedules"]),
          getRangesConfig: call(rpcClient["sheet.getRangesConfig"]),
          getTeamConfig: call(rpcClient["sheet.getTeamConfig"]),
          getEventConfig: call(rpcClient["sheet.getEventConfig"]),
          getScheduleConfig: call(rpcClient["sheet.getScheduleConfig"]),
          getRunnerConfig: call(rpcClient["sheet.getRunnerConfig"]),
        },
        status: {
          getServices: callNoInput(rpcClient["status.getServices"]),
        },
      };
    }),
  },
) {
  static layer = Layer.effect(SheetApisForwardingClient, this.make).pipe(
    Layer.provide(SheetApisRpcClient.layer),
  );
}
