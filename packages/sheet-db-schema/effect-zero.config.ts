import { schema } from "effect-zero";
import {
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
