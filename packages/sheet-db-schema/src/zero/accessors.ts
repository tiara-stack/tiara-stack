import {
  configUserPlatform as configUserPlatformModel,
  configWorkspace as configWorkspaceModel,
  configWorkspaceConversation as configWorkspaceConversationModel,
  configWorkspaceFeatureFlag as configWorkspaceFeatureFlagModel,
  configWorkspaceMonitorRole as configWorkspaceMonitorRoleModel,
  configWorkspaceTeamSubmissionChannel as configWorkspaceTeamSubmissionChannelModel,
  configWorkspaceUpdateAnnouncementDelivery as configWorkspaceUpdateAnnouncementDeliveryModel,
  messageCheckin as messageCheckinModel,
  messageCheckinMember as messageCheckinMemberModel,
  messageRoomOrder as messageRoomOrderModel,
  messageRoomOrderEntry as messageRoomOrderEntryModel,
  messageTeamSubmission as messageTeamSubmissionModel,
  messageSlot as messageSlotModel,
} from "../models";
import { builder } from "./schema";
import { defineZeroTableAccess, type ZeroTableAccess } from "./tableAccess";

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

type ZeroTableAccessRegistry = Readonly<{
  [Name in ZeroTableName]: Omit<ZeroTableAccess, "upsertWithTimestamps" | "updateWithTimestamp"> & {
    readonly table: (typeof builder)[Name];
    readonly upsertWithTimestamps: <const Value extends Record<string, unknown>>(
      value: Value,
      existing?: Partial<Record<"createdAt", number | undefined>>,
    ) => Value & Record<"createdAt" | "updatedAt", number>;
    readonly updateWithTimestamp: <const Value extends Record<string, unknown>>(
      value: Value,
    ) => Value & Record<"updatedAt", number>;
  };
}>;

export const zeroTableAccess: ZeroTableAccessRegistry = {
  configWorkspace: defineZeroTableAccess(configWorkspaceModel, builder.configWorkspace, {
    primaryKey: ["workspaceId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  configUserPlatform: defineZeroTableAccess(configUserPlatformModel, builder.configUserPlatform, {
    primaryKey: ["platform", "userId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  configWorkspaceMonitorRole: defineZeroTableAccess(
    configWorkspaceMonitorRoleModel,
    builder.configWorkspaceMonitorRole,
    {
      primaryKey: ["workspaceId", "roleId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceFeatureFlag: defineZeroTableAccess(
    configWorkspaceFeatureFlagModel,
    builder.configWorkspaceFeatureFlag,
    {
      primaryKey: ["workspaceId", "flagName"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceUpdateAnnouncementDelivery: defineZeroTableAccess(
    configWorkspaceUpdateAnnouncementDeliveryModel,
    builder.configWorkspaceUpdateAnnouncementDelivery,
    {
      primaryKey: ["workspaceId", "announcementId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceConversation: defineZeroTableAccess(
    configWorkspaceConversationModel,
    builder.configWorkspaceConversation,
    {
      primaryKey: ["workspaceId", "conversationId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configWorkspaceTeamSubmissionChannel: defineZeroTableAccess(
    configWorkspaceTeamSubmissionChannelModel,
    builder.configWorkspaceTeamSubmissionChannel,
    {
      primaryKey: ["workspaceId", "conversationId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  messageCheckin: defineZeroTableAccess(messageCheckinModel, builder.messageCheckin, {
    primaryKey: ["clientPlatform", "clientId", "messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageCheckinMember: defineZeroTableAccess(
    messageCheckinMemberModel,
    builder.messageCheckinMember,
    {
      primaryKey: ["clientPlatform", "clientId", "messageId", "memberId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  messageRoomOrder: defineZeroTableAccess(messageRoomOrderModel, builder.messageRoomOrder, {
    primaryKey: ["clientPlatform", "clientId", "messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageRoomOrderEntry: defineZeroTableAccess(
    messageRoomOrderEntryModel,
    builder.messageRoomOrderEntry,
    {
      primaryKey: ["clientPlatform", "clientId", "messageId", "rank", "position"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  messageSlot: defineZeroTableAccess(messageSlotModel, builder.messageSlot, {
    primaryKey: ["clientPlatform", "clientId", "messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageTeamSubmission: defineZeroTableAccess(
    messageTeamSubmissionModel,
    builder.messageTeamSubmission,
    {
      primaryKey: ["workspaceId", "conversationId", "messageId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
};
