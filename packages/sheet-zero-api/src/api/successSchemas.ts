import { Schema } from "effect";
import {
  ConfigUserPlatformRow,
  ConfigWorkspaceConversationRow,
  ConfigWorkspaceFeatureFlagRow,
  ConfigWorkspaceMonitorRoleRow,
  ConfigWorkspaceRow,
  ConfigWorkspaceTeamSubmissionChannelRow,
  ConfigWorkspaceUpdateAnnouncementDeliveryRow,
  MessageCheckinMemberRow,
  MessageCheckinRow,
  MessageRoomOrderEntryRow,
  MessageRoomOrderRow,
  MessageSlotRow,
  MessageTeamSubmissionRow,
} from "../rows";

export interface SheetZeroApiSuccessSchemas {
  readonly userConfig: {
    readonly getUserPlatformConfig: Schema.Top;
    readonly getCheckinDmEnabledUserConfigs: Schema.Top;
    readonly getMonitorDmEnabledUserConfigs: Schema.Top;
  };
  readonly workspaceConfig: {
    readonly getAutoCheckinWorkspaces: Schema.Top;
    readonly getWorkspaceConfigByWorkspaceId: Schema.Top;
    readonly getWorkspaceMonitorRoles: Schema.Top;
    readonly getWorkspaceFeatureFlags: Schema.Top;
    readonly getWorkspacesForFeatureFlag: Schema.Top;
    readonly getWorkspaceFeatureFlag: Schema.Top;
    readonly getWorkspaceUpdateAnnouncementDelivery: Schema.Top;
    readonly getWorkspaceConversations: Schema.Top;
    readonly getWorkspaceConversationById: Schema.Top;
    readonly getWorkspaceConversationByName: Schema.Top;
    readonly getTeamSubmissionChannelByConversationId: Schema.Top;
    readonly getTeamSubmissionChannelsForWorkspace: Schema.Top;
  };
  readonly messageCheckin: {
    readonly getMessageCheckinData: Schema.Top;
    readonly getMessageCheckinMembers: Schema.Top;
  };
  readonly messageRoomOrder: {
    readonly getMessageRoomOrder: Schema.Top;
    readonly getMessageRoomOrderEntry: Schema.Top;
    readonly getMessageRoomOrderRange: Schema.Top;
  };
  readonly messageSlot: {
    readonly getMessageSlotData: Schema.Top;
  };
  readonly messageTeamSubmission: {
    readonly getMessageTeamSubmission: Schema.Top;
    readonly getMessageTeamSubmissionByDiscordMessage: Schema.Top;
  };
}

export const defaultSuccessSchemas = {
  userConfig: {
    getUserPlatformConfig: Schema.OptionFromNullishOr(ConfigUserPlatformRow),
    getCheckinDmEnabledUserConfigs: Schema.Array(ConfigUserPlatformRow),
    getMonitorDmEnabledUserConfigs: Schema.Array(ConfigUserPlatformRow),
  },
  workspaceConfig: {
    getAutoCheckinWorkspaces: Schema.Array(ConfigWorkspaceRow),
    getWorkspaceConfigByWorkspaceId: Schema.OptionFromNullishOr(ConfigWorkspaceRow),
    getWorkspaceMonitorRoles: Schema.Array(ConfigWorkspaceMonitorRoleRow),
    getWorkspaceFeatureFlags: Schema.Array(ConfigWorkspaceFeatureFlagRow),
    getWorkspacesForFeatureFlag: Schema.Array(ConfigWorkspaceFeatureFlagRow),
    getWorkspaceFeatureFlag: Schema.OptionFromNullishOr(ConfigWorkspaceFeatureFlagRow),
    getWorkspaceUpdateAnnouncementDelivery: Schema.OptionFromNullishOr(
      ConfigWorkspaceUpdateAnnouncementDeliveryRow,
    ),
    getWorkspaceConversations: Schema.Array(ConfigWorkspaceConversationRow),
    getWorkspaceConversationById: Schema.OptionFromNullishOr(ConfigWorkspaceConversationRow),
    getWorkspaceConversationByName: Schema.OptionFromNullishOr(ConfigWorkspaceConversationRow),
    getTeamSubmissionChannelByConversationId: Schema.OptionFromNullishOr(
      ConfigWorkspaceTeamSubmissionChannelRow,
    ),
    getTeamSubmissionChannelsForWorkspace: Schema.Array(ConfigWorkspaceTeamSubmissionChannelRow),
  },
  messageCheckin: {
    getMessageCheckinData: Schema.OptionFromNullishOr(MessageCheckinRow),
    getMessageCheckinMembers: Schema.Array(MessageCheckinMemberRow),
  },
  messageRoomOrder: {
    getMessageRoomOrder: Schema.OptionFromNullishOr(MessageRoomOrderRow),
    getMessageRoomOrderEntry: Schema.Array(MessageRoomOrderEntryRow),
    getMessageRoomOrderRange: Schema.Array(MessageRoomOrderEntryRow),
  },
  messageSlot: {
    getMessageSlotData: Schema.OptionFromNullishOr(MessageSlotRow),
  },
  messageTeamSubmission: {
    getMessageTeamSubmission: Schema.OptionFromNullishOr(MessageTeamSubmissionRow),
    getMessageTeamSubmissionByDiscordMessage: Schema.OptionFromNullishOr(MessageTeamSubmissionRow),
  },
} satisfies SheetZeroApiSuccessSchemas;
