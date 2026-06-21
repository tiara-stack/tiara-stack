import {
  configWorkspace as configWorkspaceModel,
  configWorkspaceConversation as configWorkspaceConversationModel,
  configWorkspaceFeatureFlag as configWorkspaceFeatureFlagModel,
  configWorkspaceMonitorRole as configWorkspaceMonitorRoleModel,
  configWorkspaceUpdateAnnouncementDelivery as configWorkspaceUpdateAnnouncementDeliveryModel,
  messageCheckin as messageCheckinModel,
  messageCheckinMember as messageCheckinMemberModel,
  messageRoomOrder as messageRoomOrderModel,
  messageRoomOrderEntry as messageRoomOrderEntryModel,
  messageSlot as messageSlotModel,
} from "../models";
import { builder } from "./schema";
import { defineZeroTableAccess } from "./tableAccess";

const timestampOptions = {
  createdAt: "createdAt",
  updatedAt: "updatedAt",
} as const;

export const zeroTableAccess = {
  configWorkspace: defineZeroTableAccess(configWorkspaceModel, builder.configWorkspace, {
    primaryKey: ["workspaceId"],
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
};
