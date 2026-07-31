import { schema as effectSqlSchema } from "effect-sql-schema";
import type { EffectSqlSchema } from "effect-sql-schema";
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
  workflowCommand,
  workflowRun,
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
  workflowCommand,
  workflowRun,
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

export type SheetTables = {
  readonly configWorkspace: typeof configWorkspace;
  readonly configWorkspaceMonitorRole: typeof configWorkspaceMonitorRole;
  readonly configWorkspaceFeatureFlag: typeof configWorkspaceFeatureFlag;
  readonly configWorkspaceUpdateAnnouncementDelivery: typeof configWorkspaceUpdateAnnouncementDelivery;
  readonly configUserPlatform: typeof configUserPlatform;
  readonly configWorkspaceConversation: typeof configWorkspaceConversation;
  readonly configWorkspaceTeamSubmissionChannel: typeof configWorkspaceTeamSubmissionChannel;
  readonly messageSlot: typeof messageSlot;
  readonly messageCheckin: typeof messageCheckin;
  readonly messageCheckinMember: typeof messageCheckinMember;
  readonly messageRoomOrder: typeof messageRoomOrder;
  readonly messageRoomOrderEntry: typeof messageRoomOrderEntry;
  readonly messageTeamSubmission: typeof messageTeamSubmission;
  readonly sheetApisDispatchJobs: typeof sheetApisDispatchJobs;
  readonly workflowRun: typeof workflowRun;
  readonly workflowCommand: typeof workflowCommand;
};

export const tables: SheetTables = {
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
  workflowRun,
  workflowCommand,
};

export const schema: EffectSqlSchema<typeof tables> = effectSqlSchema(tables, {
  prefix: "sheet_db",
});
