import { schema } from "effect-zero";
import {
  configUserPlatform,
  configWorkspace,
  configWorkspaceConversation,
  configWorkspaceFeatureFlag,
  configWorkspaceMonitorRole,
  configWorkspaceTeamSubmissionChannel,
  configWorkspaceUpdateAnnouncementDelivery,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  messageTeamSubmission,
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
    configWorkspaceTeamSubmissionChannel,
    configWorkspaceUpdateAnnouncementDelivery,
    messageCheckin,
    messageCheckinMember,
    messageRoomOrder,
    messageRoomOrderEntry,
    messageTeamSubmission,
    messageSlot,
    sheetApisDispatchJobs,
  },
  {
    prefix: "sheet_db",
  },
);
