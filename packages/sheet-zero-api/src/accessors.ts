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
} from "./rows";
import { builder } from "./schema";
import { defineZeroTableAccess } from "./tableAccess";

const timestampOptions = {
  createdAt: "createdAt",
  updatedAt: "updatedAt",
} as const;

type ZeroTableName =
  | "configUserPlatform"
  | "configWorkspace"
  | "configWorkspaceConversation"
  | "configWorkspaceFeatureFlag"
  | "configWorkspaceMonitorRole"
  | "configWorkspaceTeamSubmissionChannel"
  | "configWorkspaceUpdateAnnouncementDelivery"
  | "messageCheckin"
  | "messageCheckinMember"
  | "messageRoomOrder"
  | "messageRoomOrderEntry"
  | "messageSlot"
  | "messageTeamSubmission";

export const zeroTableAccess = {
  configWorkspace: defineZeroTableAccess({ json: ConfigWorkspaceRow }, builder.configWorkspace, {
    primaryKey: ["workspaceId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  configUserPlatform: defineZeroTableAccess(
    { json: ConfigUserPlatformRow },
    builder.configUserPlatform,
    {
      primaryKey: ["platform", "userId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceMonitorRole: defineZeroTableAccess(
    { json: ConfigWorkspaceMonitorRoleRow },
    builder.configWorkspaceMonitorRole,
    {
      primaryKey: ["workspaceId", "roleId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceFeatureFlag: defineZeroTableAccess(
    { json: ConfigWorkspaceFeatureFlagRow },
    builder.configWorkspaceFeatureFlag,
    {
      primaryKey: ["workspaceId", "flagName"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceUpdateAnnouncementDelivery: defineZeroTableAccess(
    { json: ConfigWorkspaceUpdateAnnouncementDeliveryRow },
    builder.configWorkspaceUpdateAnnouncementDelivery,
    {
      primaryKey: ["workspaceId", "announcementId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceConversation: defineZeroTableAccess(
    { json: ConfigWorkspaceConversationRow },
    builder.configWorkspaceConversation,
    {
      primaryKey: ["workspaceId", "conversationId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceTeamSubmissionChannel: defineZeroTableAccess(
    { json: ConfigWorkspaceTeamSubmissionChannelRow },
    builder.configWorkspaceTeamSubmissionChannel,
    {
      primaryKey: ["workspaceId", "conversationId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  messageCheckin: defineZeroTableAccess({ json: MessageCheckinRow }, builder.messageCheckin, {
    primaryKey: ["clientPlatform", "clientId", "messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageCheckinMember: defineZeroTableAccess(
    { json: MessageCheckinMemberRow },
    builder.messageCheckinMember,
    {
      primaryKey: ["clientPlatform", "clientId", "messageId", "memberId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  messageRoomOrder: defineZeroTableAccess({ json: MessageRoomOrderRow }, builder.messageRoomOrder, {
    primaryKey: ["clientPlatform", "clientId", "messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageRoomOrderEntry: defineZeroTableAccess(
    { json: MessageRoomOrderEntryRow },
    builder.messageRoomOrderEntry,
    {
      primaryKey: ["clientPlatform", "clientId", "messageId", "rank", "position"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  messageSlot: defineZeroTableAccess({ json: MessageSlotRow }, builder.messageSlot, {
    primaryKey: ["clientPlatform", "clientId", "messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageTeamSubmission: defineZeroTableAccess(
    { json: MessageTeamSubmissionRow },
    builder.messageTeamSubmission,
    {
      primaryKey: ["workspaceId", "conversationId", "messageId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
} satisfies Record<ZeroTableName, unknown>;
