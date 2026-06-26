import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { SheetAuthTokenAuthorization } from "../../middlewares/sheetAuthTokenAuthorization/tag";
import {
  AutoCheckinTestDispatchPayload,
  CheckinDispatchErrorSchemas,
  CheckinDispatchPayload,
  DispatchAcceptedResult,
  BotCommandDispatchErrorSchemas,
  ConversationListConfigDispatchPayload,
  ConversationSetDispatchPayload,
  ConversationUnsetDispatchPayload,
  CheckinHandleButtonErrorSchemas,
  CheckinHandleButtonPayload,
  DispatchRoomOrderButtonMethods,
  WorkspaceWelcomeDispatchErrorSchemas,
  WorkspaceWelcomeDispatchPayload,
  KickoutDispatchErrorSchemas,
  KickoutDispatchPayload,
  PreferenceDmDisableDispatchPayload,
  PreferenceDmEnableDispatchPayload,
  PreferenceDmSetClientDispatchPayload,
  PreferenceDmStatusDispatchPayload,
  RoomOrderDispatchErrorSchemas,
  RoomOrderDispatchPayload,
  RoomOrderHandleButtonErrorSchemas,
  RoomOrderNextButtonPayload,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPreviousButtonPayload,
  RoomOrderSendButtonPayload,
  ScheduleListDispatchPayload,
  ServiceWorkspaceFeatureFlagDispatchPayload,
  ServiceStatusDispatchPayload,
  WorkspaceAddMonitorRoleDispatchPayload,
  WorkspaceListConfigDispatchPayload,
  WorkspaceRemoveMonitorRoleDispatchPayload,
  WorkspaceSetAutoCheckinDispatchPayload,
  WorkspaceSetSheetDispatchPayload,
  ScreenshotDispatchPayload,
  SlotButtonDispatchPayload,
  SlotDispatchErrorSchemas,
  SlotListDispatchPayload,
  SlotOpenButtonPayload,
  TeamListDispatchPayload,
  UpdateAnnouncementDispatchErrorSchemas,
  UpdateAnnouncementDispatchPayload,
} from "./schema";
import { UnknownError } from "typhoon-core/error";

export class DispatchApi extends HttpApiGroup.make("dispatch")
  .add(
    HttpApiEndpoint.post("autoCheckinTest", "/dispatch/auto-checkin/test", {
      payload: AutoCheckinTestDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
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
    HttpApiEndpoint.post("preferenceDmStatus", "/dispatch/preference/dm/status", {
      payload: PreferenceDmStatusDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("preferenceDmEnable", "/dispatch/preference/dm/enable", {
      payload: PreferenceDmEnableDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("preferenceDmDisable", "/dispatch/preference/dm/disable", {
      payload: PreferenceDmDisableDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("preferenceDmSetClient", "/dispatch/preference/dm/client", {
      payload: PreferenceDmSetClientDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("workspaceWelcome", "/dispatch/workspace/welcome", {
      payload: WorkspaceWelcomeDispatchPayload,
      success: DispatchAcceptedResult,
      error: WorkspaceWelcomeDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateAnnouncement", "/dispatch/update-announcement", {
      payload: UpdateAnnouncementDispatchPayload,
      success: DispatchAcceptedResult,
      error: UpdateAnnouncementDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("serviceAddWorkspaceFeatureFlag", "/dispatch/service/feature-flags/add", {
      payload: ServiceWorkspaceFeatureFlagDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post(
      "serviceRemoveWorkspaceFeatureFlag",
      "/dispatch/service/feature-flags/remove",
      {
        payload: ServiceWorkspaceFeatureFlagDispatchPayload,
        success: DispatchAcceptedResult,
        error: BotCommandDispatchErrorSchemas,
      },
    ),
  )
  .add(
    HttpApiEndpoint.post("conversationListConfig", "/dispatch/conversation/list-config", {
      payload: ConversationListConfigDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("conversationSet", "/dispatch/conversation/set", {
      payload: ConversationSetDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("conversationUnset", "/dispatch/conversation/unset", {
      payload: ConversationUnsetDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("workspaceListConfig", "/dispatch/workspace/list-config", {
      payload: WorkspaceListConfigDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("workspaceAddMonitorRole", "/dispatch/workspace/add/monitor-role", {
      payload: WorkspaceAddMonitorRoleDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("workspaceRemoveMonitorRole", "/dispatch/workspace/remove/monitor-role", {
      payload: WorkspaceRemoveMonitorRoleDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("workspaceSetSheet", "/dispatch/workspace/set/sheet", {
      payload: WorkspaceSetSheetDispatchPayload,
      success: DispatchAcceptedResult,
      error: BotCommandDispatchErrorSchemas,
    }),
  )
  .add(
    HttpApiEndpoint.post("workspaceSetAutoCheckin", "/dispatch/workspace/set/auto-checkin", {
      payload: WorkspaceSetAutoCheckinDispatchPayload,
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
