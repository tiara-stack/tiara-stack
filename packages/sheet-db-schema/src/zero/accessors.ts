import {
  configGuild as configGuildModel,
  configGuildChannel as configGuildChannelModel,
  configGuildManagerRole as configGuildManagerRoleModel,
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
  configGuild: defineZeroTableAccess(configGuildModel, builder.configGuild, {
    primaryKey: ["guildId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  configGuildManagerRole: defineZeroTableAccess(
    configGuildManagerRoleModel,
    builder.configGuildManagerRole,
    {
      primaryKey: ["guildId", "roleId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  configGuildChannel: defineZeroTableAccess(configGuildChannelModel, builder.configGuildChannel, {
    primaryKey: ["guildId", "channelId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageCheckin: defineZeroTableAccess(messageCheckinModel, builder.messageCheckin, {
    primaryKey: ["messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageCheckinMember: defineZeroTableAccess(
    messageCheckinMemberModel,
    builder.messageCheckinMember,
    {
      primaryKey: ["messageId", "memberId"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  messageRoomOrder: defineZeroTableAccess(messageRoomOrderModel, builder.messageRoomOrder, {
    primaryKey: ["messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
  messageRoomOrderEntry: defineZeroTableAccess(
    messageRoomOrderEntryModel,
    builder.messageRoomOrderEntry,
    {
      primaryKey: ["messageId", "rank", "position"],
      softDelete: "deletedAt",
      timestamps: timestampOptions,
    },
  ),
  messageSlot: defineZeroTableAccess(messageSlotModel, builder.messageSlot, {
    primaryKey: ["messageId"],
    softDelete: "deletedAt",
    timestamps: timestampOptions,
  }),
};
