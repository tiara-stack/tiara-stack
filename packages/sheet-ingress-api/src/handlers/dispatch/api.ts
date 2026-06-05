import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import {
  CheckinDispatchErrorSchemas,
  CheckinDispatchPayload,
  DispatchAcceptedResult,
  BotCommandDispatchErrorSchemas,
  ChannelListConfigDispatchPayload,
  ChannelSetDispatchPayload,
  ChannelUnsetDispatchPayload,
  CheckinHandleButtonErrorSchemas,
  CheckinHandleButtonPayload,
  DispatchRoomOrderButtonMethods,
  GuildWelcomeDispatchErrorSchemas,
  GuildWelcomeDispatchPayload,
  KickoutDispatchErrorSchemas,
  KickoutDispatchPayload,
  RoomOrderDispatchErrorSchemas,
  RoomOrderDispatchPayload,
  RoomOrderHandleButtonErrorSchemas,
  RoomOrderNextButtonPayload,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPreviousButtonPayload,
  RoomOrderSendButtonPayload,
  ScheduleListDispatchPayload,
  ServiceGuildFeatureFlagDispatchPayload,
  ServiceStatusDispatchPayload,
  ServerAddMonitorRoleDispatchPayload,
  ServerListConfigDispatchPayload,
  ServerRemoveMonitorRoleDispatchPayload,
  ServerSetAutoCheckinDispatchPayload,
  ServerSetSheetDispatchPayload,
  ScreenshotDispatchPayload,
  SlotButtonDispatchPayload,
  SlotDispatchErrorSchemas,
  SlotListDispatchPayload,
  SlotOpenButtonPayload,
  TeamListDispatchPayload,
} from "./schema";
import { UnknownError } from "typhoon-core/error";

export class DispatchApi extends HttpApiGroup.make("dispatch")
  .add(
    HttpApiEndpoint.post("checkin", "/dispatch/checkin", {
      payload: CheckinDispatchPayload,
      success: DispatchAcceptedResult,
      error: CheckinDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("checkinButton", "/dispatch/checkin/buttons/handle", {
      payload: CheckinHandleButtonPayload,
      success: DispatchAcceptedResult,
      error: CheckinHandleButtonErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("roomOrder", "/dispatch/roomOrder", {
      payload: RoomOrderDispatchPayload,
      success: DispatchAcceptedResult,
      error: RoomOrderDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("kickout", "/dispatch/kickout", {
      payload: KickoutDispatchPayload,
      success: DispatchAcceptedResult,
      error: KickoutDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("slotButton", "/dispatch/slot/button", {
      payload: SlotButtonDispatchPayload,
      success: DispatchAcceptedResult,
      error: SlotDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("slotList", "/dispatch/slot/list", {
      payload: SlotListDispatchPayload,
      success: DispatchAcceptedResult,
      error: SlotDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("slotOpenButton", "/dispatch/slot/buttons/open", {
      payload: SlotOpenButtonPayload,
      success: DispatchAcceptedResult,
      error: SlotDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("serviceStatus", "/dispatch/status/services", {
      payload: ServiceStatusDispatchPayload,
      success: DispatchAcceptedResult,
      error: UnknownError,
    }),
  )
  .add(
    HttpApiEndpoint.post("guildWelcome", "/dispatch/guild/welcome", {
      payload: GuildWelcomeDispatchPayload,
      success: DispatchAcceptedResult,
      error: GuildWelcomeDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("serviceAddGuildFeatureFlag", "/dispatch/service/feature-flags/add", {
      payload: ServiceGuildFeatureFlagDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "serviceRemoveGuildFeatureFlag",
      "/dispatch/service/feature-flags/remove",
      {
        payload: ServiceGuildFeatureFlagDispatchPayload,
        success: DispatchAcceptedResult,
        error: BotCommandDispatchErrorSchemas,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("channelListConfig", "/dispatch/channel/list-config", {
      payload: ChannelListConfigDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("channelSet", "/dispatch/channel/set", {
      payload: ChannelSetDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("channelUnset", "/dispatch/channel/unset", {
      payload: ChannelUnsetDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("serverListConfig", "/dispatch/server/list-config", {
      payload: ServerListConfigDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("serverAddMonitorRole", "/dispatch/server/add/monitor-role", {
      payload: ServerAddMonitorRoleDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("serverRemoveMonitorRole", "/dispatch/server/remove/monitor-role", {
      payload: ServerRemoveMonitorRoleDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("serverSetSheet", "/dispatch/server/set/sheet", {
      payload: ServerSetSheetDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("serverSetAutoCheckin", "/dispatch/server/set/auto-checkin", {
      payload: ServerSetAutoCheckinDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("teamList", "/dispatch/team/list", {
      payload: TeamListDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("scheduleList", "/dispatch/schedule/list", {
      payload: ScheduleListDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("screenshot", "/dispatch/screenshot", {
      payload: ScreenshotDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      DispatchRoomOrderButtonMethods.previous.endpointName,
      DispatchRoomOrderButtonMethods.previous.path,
      {
        payload: RoomOrderPreviousButtonPayload,
        success: DispatchAcceptedResult,
        error: RoomOrderHandleButtonErrorSchemas,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      DispatchRoomOrderButtonMethods.next.endpointName,
      DispatchRoomOrderButtonMethods.next.path,
      {
        payload: RoomOrderNextButtonPayload,
        success: DispatchAcceptedResult,
        error: RoomOrderHandleButtonErrorSchemas,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      DispatchRoomOrderButtonMethods.send.endpointName,
      DispatchRoomOrderButtonMethods.send.path,
      {
        payload: RoomOrderSendButtonPayload,
        success: DispatchAcceptedResult,
        error: RoomOrderHandleButtonErrorSchemas,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post(
      DispatchRoomOrderButtonMethods.pinTentative.endpointName,
      DispatchRoomOrderButtonMethods.pinTentative.path,
      {
        payload: RoomOrderPinTentativeButtonPayload,
        success: DispatchAcceptedResult,
        error: RoomOrderHandleButtonErrorSchemas,
      },
    ),
  )
  .middleware(SheetAuthTokenAuthorization)
  .annotate(OpenApi.Title, "Dispatch")
  .annotate(OpenApi.Description, "Dispatch and Discord interaction endpoints") {}
