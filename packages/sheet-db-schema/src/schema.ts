import { schema as effectSqlSchema } from "effect-sql-schema";
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
} from "./schema.internal";
export {
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
} from "./schema.internal";
export {
  TeamSubmissionRemovedRowStrategy,
  TeamSubmissionWriteMode,
} from "./teamSubmissionChannelConfig";
export type {
  TeamSubmissionRemovedRowStrategy as TeamSubmissionRemovedRowStrategyType,
  TeamSubmissionWriteMode as TeamSubmissionWriteModeType,
} from "./teamSubmissionChannelConfig";
export { TeamSubmissionStatus } from "./teamSubmissionStatus";
export type { TeamSubmissionStatus as TeamSubmissionStatusType } from "./teamSubmissionStatus";

export const schema = effectSqlSchema(
  {
    configWorkspace,
    configWorkspaceMonitorRole,
    configWorkspaceFeatureFlag,
    configWorkspaceUpdateAnnouncementDelivery,
    configUserPlatform,
    configWorkspaceConversation,
    configWorkspaceTeamSubmissionChannel,
    messageSlot,
    messageCheckin,
    messageCheckinMember,
    messageRoomOrder,
    messageRoomOrderEntry,
    messageTeamSubmission,
    sheetApisDispatchJobs,
  },
  { prefix: "sheet_db" },
);
