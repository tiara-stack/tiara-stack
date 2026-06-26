import { schema } from "effect-zero";
import {
  configUserPlatform,
  configWorkspace,
  configWorkspaceConversation,
  configWorkspaceFeatureFlag,
  configWorkspaceMonitorRole,
  configWorkspaceUpdateAnnouncementDelivery,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  messageSlot,
  sheetApisDispatchJobs,
} from "./src/schema.internal";

export default schema(
  {
    configWorkspace,
    configUserPlatform,
    configWorkspaceConversation,
    configWorkspaceFeatureFlag,
    configWorkspaceMonitorRole,
    configWorkspaceUpdateAnnouncementDelivery,
    messageCheckin,
    messageCheckinMember,
    messageRoomOrder,
    messageRoomOrderEntry,
    messageSlot,
    sheetApisDispatchJobs,
  },
  {
    prefix: "sheet_db",
  },
);
