import { Schema } from "effect";
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
  messageSlot,
  messageTeamSubmission,
} from "../../models";

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
    getUserPlatformConfig: Schema.OptionFromNullishOr(configUserPlatform.json),
    getCheckinDmEnabledUserConfigs: Schema.Array(configUserPlatform.json),
    getMonitorDmEnabledUserConfigs: Schema.Array(configUserPlatform.json),
  },
  workspaceConfig: {
    getAutoCheckinWorkspaces: Schema.Array(configWorkspace.json),
    getWorkspaceConfigByWorkspaceId: Schema.OptionFromNullishOr(configWorkspace.json),
    getWorkspaceMonitorRoles: Schema.Array(configWorkspaceMonitorRole.json),
    getWorkspaceFeatureFlags: Schema.Array(configWorkspaceFeatureFlag.json),
    getWorkspacesForFeatureFlag: Schema.Array(configWorkspaceFeatureFlag.json),
    getWorkspaceFeatureFlag: Schema.OptionFromNullishOr(configWorkspaceFeatureFlag.json),
    getWorkspaceUpdateAnnouncementDelivery: Schema.OptionFromNullishOr(
      configWorkspaceUpdateAnnouncementDelivery.json,
    ),
    getWorkspaceConversations: Schema.Array(configWorkspaceConversation.json),
    getWorkspaceConversationById: Schema.OptionFromNullishOr(configWorkspaceConversation.json),
    getWorkspaceConversationByName: Schema.OptionFromNullishOr(configWorkspaceConversation.json),
    getTeamSubmissionChannelByConversationId: Schema.OptionFromNullishOr(
      configWorkspaceTeamSubmissionChannel.json,
    ),
    getTeamSubmissionChannelsForWorkspace: Schema.Array(configWorkspaceTeamSubmissionChannel.json),
  },
  messageCheckin: {
    getMessageCheckinData: Schema.OptionFromNullishOr(messageCheckin.json),
    getMessageCheckinMembers: Schema.Array(messageCheckinMember.json),
  },
  messageRoomOrder: {
    getMessageRoomOrder: Schema.OptionFromNullishOr(messageRoomOrder.json),
    getMessageRoomOrderEntry: Schema.Array(messageRoomOrderEntry.json),
    getMessageRoomOrderRange: Schema.Array(messageRoomOrderEntry.json),
  },
  messageSlot: {
    getMessageSlotData: Schema.OptionFromNullishOr(messageSlot.json),
  },
  messageTeamSubmission: {
    getMessageTeamSubmission: Schema.OptionFromNullishOr(messageTeamSubmission.json),
    getMessageTeamSubmissionByDiscordMessage: Schema.OptionFromNullishOr(
      messageTeamSubmission.json,
    ),
  },
} satisfies SheetZeroApiSuccessSchemas;
