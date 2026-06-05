import { Schema } from "effect";
import { make, ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "./accessors";
import {
  hasActiveSendClaim,
  hasActiveTentativePinClaim,
  hasActiveTentativeUpdateClaim,
  hasStaleUntrackedSendClaim,
  isActiveSendClaim,
} from "./claimHelpers";
import { builder, type Schema as ZeroSchema } from "./schema";
import { preserveOmitted } from "./timestamps";

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: ZeroSchema;
  }
}

export interface SheetZeroApiSuccessSchemas {
  readonly guildConfig: {
    readonly getAutoCheckinGuilds: Schema.Top;
    readonly getGuildConfigByGuildId: Schema.Top;
    readonly getGuildMonitorRoles: Schema.Top;
    readonly getGuildFeatureFlags: Schema.Top;
    readonly getGuildsForFeatureFlag: Schema.Top;
    readonly getGuildFeatureFlag: Schema.Top;
    readonly getGuildChannels: Schema.Top;
    readonly getGuildChannelById: Schema.Top;
    readonly getGuildChannelByName: Schema.Top;
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
}

const defaultSuccessSchemas = {
  guildConfig: {
    getAutoCheckinGuilds: Schema.Any,
    getGuildConfigByGuildId: Schema.Any,
    getGuildMonitorRoles: Schema.Any,
    getGuildFeatureFlags: Schema.Any,
    getGuildsForFeatureFlag: Schema.Any,
    getGuildFeatureFlag: Schema.Any,
    getGuildChannels: Schema.Any,
    getGuildChannelById: Schema.Any,
    getGuildChannelByName: Schema.Any,
  },
  messageCheckin: {
    getMessageCheckinData: Schema.Any,
    getMessageCheckinMembers: Schema.Any,
  },
  messageRoomOrder: {
    getMessageRoomOrder: Schema.Any,
    getMessageRoomOrderEntry: Schema.Any,
    getMessageRoomOrderRange: Schema.Any,
  },
  messageSlot: {
    getMessageSlotData: Schema.Any,
  },
} satisfies SheetZeroApiSuccessSchemas;

const makeSheetZeroApiWithSuccess = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) => {
  const GuildConfigGroup = ZeroApiGroup.make("guildConfig").add(
    ZeroApiEndpoint.query("getAutoCheckinGuilds", {
      request: Schema.Struct({}),
      success: success.guildConfig.getAutoCheckinGuilds,
      query: () =>
        zeroTableAccess.configGuild.listActiveWhere(
          builder.configGuild.where("autoCheckin", "=", true),
        ),
    }),
    ZeroApiEndpoint.query("getGuildConfigByGuildId", {
      request: Schema.Struct({ guildId: Schema.String }),
      success: success.guildConfig.getGuildConfigByGuildId,
      query: ({ args: { guildId } }) =>
        zeroTableAccess.configGuild.getActiveByPrimaryKey(builder.configGuild, { guildId }),
    }),
    ZeroApiEndpoint.query("getGuildMonitorRoles", {
      request: Schema.Struct({ guildId: Schema.String }),
      success: success.guildConfig.getGuildMonitorRoles,
      query: ({ args: { guildId } }) =>
        zeroTableAccess.configGuildManagerRole.listActiveWhere(
          builder.configGuildManagerRole.where("guildId", "=", guildId),
        ),
    }),
    ZeroApiEndpoint.query("getGuildFeatureFlags", {
      request: Schema.Struct({ guildId: Schema.String }),
      success: success.guildConfig.getGuildFeatureFlags,
      query: ({ args: { guildId } }) =>
        zeroTableAccess.configGuildFeatureFlag.listActiveWhere(
          builder.configGuildFeatureFlag.where("guildId", "=", guildId),
        ),
    }),
    ZeroApiEndpoint.query("getGuildsForFeatureFlag", {
      request: Schema.Struct({ flagName: Schema.String }),
      success: success.guildConfig.getGuildsForFeatureFlag,
      query: ({ args: { flagName } }) =>
        zeroTableAccess.configGuildFeatureFlag.listActiveWhere(
          builder.configGuildFeatureFlag.where("flagName", "=", flagName),
        ),
    }),
    ZeroApiEndpoint.query("getGuildFeatureFlag", {
      request: Schema.Struct({ guildId: Schema.String, flagName: Schema.String }),
      success: success.guildConfig.getGuildFeatureFlag,
      query: ({ args: { guildId, flagName } }) =>
        zeroTableAccess.configGuildFeatureFlag.getActiveByPrimaryKey(
          builder.configGuildFeatureFlag,
          { guildId, flagName },
        ),
    }),
    ZeroApiEndpoint.query("getGuildChannels", {
      request: Schema.Struct({
        guildId: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      success: success.guildConfig.getGuildChannels,
      query: ({ args: { guildId, running } }) => {
        const query = zeroTableAccess.configGuildChannel.listActiveWhere(
          builder.configGuildChannel.where("guildId", "=", guildId),
        );

        return typeof running === "undefined" ? query : query.where("running", "=", running);
      },
    }),
    ZeroApiEndpoint.query("getGuildChannelById", {
      request: Schema.Struct({
        guildId: Schema.String,
        channelId: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      success: success.guildConfig.getGuildChannelById,
      query: ({ args: { guildId, channelId, running } }) => {
        const query = zeroTableAccess.configGuildChannel.listActiveWhere(
          builder.configGuildChannel
            .where("guildId", "=", guildId)
            .where("channelId", "=", channelId),
        );

        return (
          typeof running === "undefined" ? query : query.where("running", "=", running)
        ).one();
      },
    }),
    ZeroApiEndpoint.query("getGuildChannelByName", {
      request: Schema.Struct({
        guildId: Schema.String,
        channelName: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      success: success.guildConfig.getGuildChannelByName,
      query: ({ args: { guildId, channelName, running } }) => {
        const query = zeroTableAccess.configGuildChannel.listActiveWhere(
          builder.configGuildChannel.where("guildId", "=", guildId).where("name", "=", channelName),
        );

        return (
          typeof running === "undefined" ? query : query.where("running", "=", running)
        ).one();
      },
    }),
    ZeroApiEndpoint.mutator("upsertGuildConfig", {
      request: Schema.Struct({
        guildId: Schema.String,
        sheetId: Schema.optional(Schema.NullOr(Schema.String)),
        autoCheckin: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
      mutator: async ({ tx, args }) => {
        const existingConfigGuild = await tx.run(
          builder.configGuild.where("guildId", "=", args.guildId).one(),
        );

        await tx.mutate.configGuild.upsert(
          zeroTableAccess.configGuild.upsertWithTimestamps(
            {
              guildId: args.guildId,
              sheetId: preserveOmitted(args.sheetId, existingConfigGuild?.sheetId),
              autoCheckin: preserveOmitted(args.autoCheckin, existingConfigGuild?.autoCheckin),
              deletedAt: null,
            },
            existingConfigGuild,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("addGuildMonitorRole", {
      request: Schema.Struct({
        guildId: Schema.String,
        roleId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingRole = await tx.run(
          builder.configGuildManagerRole
            .where("guildId", "=", args.guildId)
            .where("roleId", "=", args.roleId)
            .one(),
        );

        await tx.mutate.configGuildManagerRole.upsert(
          zeroTableAccess.configGuildManagerRole.upsertWithTimestamps(
            {
              guildId: args.guildId,
              roleId: args.roleId,
              deletedAt: null,
            },
            existingRole,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeGuildMonitorRole", {
      request: Schema.Struct({
        guildId: Schema.String,
        roleId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.configGuildManagerRole.update(
          zeroTableAccess.configGuildManagerRole.softDeleteByPrimaryKey({
            guildId: args.guildId,
            roleId: args.roleId,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("addGuildFeatureFlag", {
      request: Schema.Struct({
        guildId: Schema.String,
        flagName: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingFlag = await tx.run(
          builder.configGuildFeatureFlag
            .where("guildId", "=", args.guildId)
            .where("flagName", "=", args.flagName)
            .one(),
        );

        await tx.mutate.configGuildFeatureFlag.upsert(
          zeroTableAccess.configGuildFeatureFlag.upsertWithTimestamps(
            {
              guildId: args.guildId,
              flagName: args.flagName,
              deletedAt: null,
            },
            existingFlag,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeGuildFeatureFlag", {
      request: Schema.Struct({
        guildId: Schema.String,
        flagName: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.configGuildFeatureFlag.update(
          zeroTableAccess.configGuildFeatureFlag.softDeleteByPrimaryKey({
            guildId: args.guildId,
            flagName: args.flagName,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("upsertGuildChannelConfig", {
      request: Schema.Struct({
        guildId: Schema.String,
        channelId: Schema.String,
        name: Schema.optional(Schema.NullOr(Schema.String)),
        running: Schema.optional(Schema.NullOr(Schema.Boolean)),
        roleId: Schema.optional(Schema.NullOr(Schema.String)),
        checkinChannelId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      mutator: async ({ tx, args }) => {
        const existingChannel = await tx.run(
          builder.configGuildChannel
            .where("guildId", "=", args.guildId)
            .where("channelId", "=", args.channelId)
            .one(),
        );

        await tx.mutate.configGuildChannel.upsert(
          zeroTableAccess.configGuildChannel.upsertWithTimestamps(
            {
              guildId: args.guildId,
              channelId: args.channelId,
              name: preserveOmitted(args.name, existingChannel?.name),
              running: preserveOmitted(args.running, existingChannel?.running),
              roleId: preserveOmitted(args.roleId, existingChannel?.roleId),
              checkinChannelId: preserveOmitted(
                args.checkinChannelId,
                existingChannel?.checkinChannelId,
              ),
              deletedAt: null,
            },
            existingChannel,
          ),
        );
      },
    }),
  );

  const MessageCheckinGroup = ZeroApiGroup.make("messageCheckin").add(
    ZeroApiEndpoint.query("getMessageCheckinData", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageCheckin.getMessageCheckinData,
      query: ({ args: { messageId } }) =>
        zeroTableAccess.messageCheckin.getActiveByPrimaryKey(builder.messageCheckin, {
          messageId,
        }),
    }),
    ZeroApiEndpoint.query("getMessageCheckinMembers", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageCheckin.getMessageCheckinMembers,
      query: ({ args: { messageId } }) =>
        zeroTableAccess.messageCheckinMember.listActiveWhere(
          builder.messageCheckinMember.where("messageId", "=", messageId),
        ),
    }),
    ZeroApiEndpoint.mutator("upsertMessageCheckinData", {
      request: Schema.Struct({
        messageId: Schema.String,
        initialMessage: Schema.String,
        hour: Schema.Number,
        channelId: Schema.String,
        roleId: Schema.optional(Schema.NullOr(Schema.String)),
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingCheckin = await tx.run(
          builder.messageCheckin.where("messageId", "=", args.messageId).one(),
        );

        await tx.mutate.messageCheckin.upsert(
          zeroTableAccess.messageCheckin.upsertWithTimestamps(
            {
              messageId: args.messageId,
              initialMessage: args.initialMessage,
              hour: args.hour,
              channelId: args.channelId,
              roleId: args.roleId,
              guildId: args.guildId,
              messageChannelId: args.messageChannelId,
              createdByUserId: args.createdByUserId,
              deletedAt: null,
            },
            existingCheckin,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("addMessageCheckinMembers", {
      request: Schema.Struct({
        messageId: Schema.String,
        memberIds: Schema.Array(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        await Promise.all(
          args.memberIds.map(async (memberId) => {
            const existingMember = await tx.run(
              builder.messageCheckinMember
                .where("messageId", "=", args.messageId)
                .where("memberId", "=", memberId)
                .one(),
            );

            return tx.mutate.messageCheckinMember.upsert(
              zeroTableAccess.messageCheckinMember.upsertWithTimestamps(
                {
                  messageId: args.messageId,
                  memberId,
                  checkinAt: null,
                  checkinClaimId: null,
                  deletedAt: null,
                },
                existingMember,
              ),
            );
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("persistMessageCheckin", {
      request: Schema.Struct({
        messageId: Schema.String,
        data: Schema.Struct({
          initialMessage: Schema.String,
          hour: Schema.Number,
          channelId: Schema.String,
          roleId: Schema.optional(Schema.NullOr(Schema.String)),
          guildId: Schema.NullOr(Schema.String),
          messageChannelId: Schema.NullOr(Schema.String),
          createdByUserId: Schema.NullOr(Schema.String),
        }),
        memberIds: Schema.Array(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingCheckin = await tx.run(
          builder.messageCheckin.where("messageId", "=", args.messageId).one(),
        );

        await tx.mutate.messageCheckin.upsert(
          zeroTableAccess.messageCheckin.upsertWithTimestamps(
            {
              messageId: args.messageId,
              initialMessage: args.data.initialMessage,
              hour: args.data.hour,
              channelId: args.data.channelId,
              roleId: args.data.roleId,
              guildId: args.data.guildId,
              messageChannelId: args.data.messageChannelId,
              createdByUserId: args.data.createdByUserId,
              deletedAt: null,
            },
            existingCheckin,
          ),
        );

        await Promise.all(
          args.memberIds.map(async (memberId) => {
            const existingMember = await tx.run(
              builder.messageCheckinMember
                .where("messageId", "=", args.messageId)
                .where("memberId", "=", memberId)
                .one(),
            );

            return tx.mutate.messageCheckinMember.upsert(
              zeroTableAccess.messageCheckinMember.upsertWithTimestamps(
                {
                  messageId: args.messageId,
                  memberId,
                  checkinAt: null,
                  checkinClaimId: null,
                  deletedAt: null,
                },
                existingMember,
              ),
            );
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("setMessageCheckinMemberCheckinAt", {
      request: Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
        checkinAt: Schema.Number,
        checkinClaimId: Schema.optional(Schema.String),
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.updateWithTimestamp({
            messageId: args.messageId,
            memberId: args.memberId,
            checkinAt: args.checkinAt,
            checkinClaimId: args.checkinClaimId ?? null,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("setMessageCheckinMemberCheckinAtIfUnset", {
      request: Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
        checkinAt: Schema.Number,
        checkinClaimId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const member = await tx.run(
          zeroTableAccess.messageCheckinMember.getActiveByPrimaryKey(builder.messageCheckinMember, {
            messageId: args.messageId,
            memberId: args.memberId,
          }),
        );
        if (!member || member.checkinAt !== null) return;
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.updateWithTimestamp({
            messageId: args.messageId,
            memberId: args.memberId,
            checkinAt: args.checkinAt,
            checkinClaimId: args.checkinClaimId,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeMessageCheckinMember", {
      request: Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.softDeleteByPrimaryKey({
            messageId: args.messageId,
            memberId: args.memberId,
          }),
        ),
    }),
  );

  const MessageRoomOrderGroup = ZeroApiGroup.make("messageRoomOrder").add(
    ZeroApiEndpoint.query("getMessageRoomOrder", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageRoomOrder.getMessageRoomOrder,
      query: ({ args: { messageId } }) =>
        zeroTableAccess.messageRoomOrder.getActiveByPrimaryKey(builder.messageRoomOrder, {
          messageId,
        }),
    }),
    ZeroApiEndpoint.query("getMessageRoomOrderEntry", {
      request: Schema.Struct({ messageId: Schema.String, rank: Schema.Number }),
      success: success.messageRoomOrder.getMessageRoomOrderEntry,
      query: ({ args: { messageId, rank } }) =>
        zeroTableAccess.messageRoomOrderEntry
          .listActiveWhere(
            builder.messageRoomOrderEntry
              .where("messageId", "=", messageId)
              .where("rank", "=", rank),
          )
          .orderBy("position", "asc"),
    }),
    ZeroApiEndpoint.query("getMessageRoomOrderRange", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageRoomOrder.getMessageRoomOrderRange,
      query: ({ args: { messageId } }) =>
        zeroTableAccess.messageRoomOrderEntry.listActiveWhere(
          builder.messageRoomOrderEntry.where("messageId", "=", messageId),
        ),
    }),
    ZeroApiEndpoint.mutator("decrementMessageRoomOrderRank", {
      request: Schema.Struct({
        messageId: Schema.String,
        expectedRank: Schema.optional(Schema.Number),
        tentativeUpdateClaimId: Schema.optional(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          !messageRoomOrder ||
          messageRoomOrder.tentativePinnedAt !== null ||
          (args.expectedRank !== undefined && messageRoomOrder.rank !== args.expectedRank) ||
          hasActiveSendClaim(messageRoomOrder, now) ||
          (hasActiveTentativeUpdateClaim(messageRoomOrder, now) &&
            messageRoomOrder.tentativeUpdateClaimId !== args.tentativeUpdateClaimId) ||
          hasActiveTentativePinClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            rank: messageRoomOrder.rank - 1,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("incrementMessageRoomOrderRank", {
      request: Schema.Struct({
        messageId: Schema.String,
        expectedRank: Schema.optional(Schema.Number),
        tentativeUpdateClaimId: Schema.optional(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          !messageRoomOrder ||
          messageRoomOrder.tentativePinnedAt !== null ||
          (args.expectedRank !== undefined && messageRoomOrder.rank !== args.expectedRank) ||
          hasActiveSendClaim(messageRoomOrder, now) ||
          (hasActiveTentativeUpdateClaim(messageRoomOrder, now) &&
            messageRoomOrder.tentativeUpdateClaimId !== args.tentativeUpdateClaimId) ||
          hasActiveTentativePinClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            rank: messageRoomOrder.rank + 1,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("claimMessageRoomOrderSend", {
      request: Schema.Struct({ messageId: Schema.String, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          !messageRoomOrder ||
          messageRoomOrder.sentMessageId ||
          messageRoomOrder.tentativePinnedAt !== null ||
          isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now) ||
          hasActiveTentativeUpdateClaim(messageRoomOrder, now) ||
          hasActiveTentativePinClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            sendClaimId: args.claimId,
            sendClaimedAt: now,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("completeMessageRoomOrderSend", {
      request: Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
        sentMessageId: Schema.String,
        sentMessageChannelId: Schema.String,
        sentAt: Schema.Number,
      }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (!messageRoomOrder || messageRoomOrder.sendClaimId !== args.claimId) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            sendClaimId: null,
            sendClaimedAt: null,
            sentMessageId: args.sentMessageId,
            sentMessageChannelId: args.sentMessageChannelId,
            sentAt: args.sentAt,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("releaseMessageRoomOrderSendClaim", {
      request: Schema.Struct({ messageId: Schema.String, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (!messageRoomOrder || messageRoomOrder.sendClaimId !== args.claimId) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            sendClaimId: null,
            sendClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("claimMessageRoomOrderTentativeUpdate", {
      request: Schema.Struct({ messageId: Schema.String, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          !messageRoomOrder ||
          messageRoomOrder.tentativePinnedAt !== null ||
          hasStaleUntrackedSendClaim(messageRoomOrder, now) ||
          isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now) ||
          hasActiveTentativePinClaim(messageRoomOrder, now) ||
          hasActiveTentativeUpdateClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            sendClaimId: null,
            sendClaimedAt: null,
            tentativeUpdateClaimId: args.claimId,
            tentativeUpdateClaimedAt: now,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("releaseMessageRoomOrderTentativeUpdateClaim", {
      request: Schema.Struct({ messageId: Schema.String, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (!messageRoomOrder || messageRoomOrder.tentativeUpdateClaimId !== args.claimId) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("claimMessageRoomOrderTentativePin", {
      request: Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const now = Date.now();
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          !messageRoomOrder ||
          messageRoomOrder.tentativePinnedAt !== null ||
          hasStaleUntrackedSendClaim(messageRoomOrder, now) ||
          isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now) ||
          hasActiveTentativePinClaim(messageRoomOrder, now) ||
          hasActiveTentativeUpdateClaim(messageRoomOrder, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            sendClaimId: null,
            sendClaimedAt: null,
            tentativePinClaimId: args.claimId,
            tentativePinClaimedAt: now,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("completeMessageRoomOrderTentativePin", {
      request: Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
        pinnedAt: Schema.Number,
      }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          !messageRoomOrder ||
          messageRoomOrder.tentativePinnedAt !== null ||
          messageRoomOrder.tentativePinClaimId !== args.claimId
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
            tentativePinnedAt: args.pinnedAt,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("releaseMessageRoomOrderTentativePinClaim", {
      request: Schema.Struct({ messageId: Schema.String, claimId: Schema.String }),
      mutator: async ({ tx, args }) => {
        const messageRoomOrder = await tx.run(
          builder.messageRoomOrder
            .where("messageId", "=", args.messageId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (
          !messageRoomOrder ||
          messageRoomOrder.tentativePinnedAt !== null ||
          messageRoomOrder.tentativePinClaimId !== args.claimId
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("markMessageRoomOrderTentative", {
      request: Schema.Struct({
        messageId: Schema.String,
        guildId: Schema.String,
        messageChannelId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageRoomOrder.update(
          zeroTableAccess.messageRoomOrder.updateWithTimestamp({
            messageId: args.messageId,
            tentative: true,
            guildId: args.guildId,
            messageChannelId: args.messageChannelId,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("upsertMessageRoomOrder", {
      request: Schema.Struct({
        messageId: Schema.String,
        previousFills: Schema.Array(Schema.String),
        fills: Schema.Array(Schema.String),
        hour: Schema.Number,
        rank: Schema.Number,
        tentative: Schema.optional(Schema.Boolean),
        monitor: Schema.optional(Schema.NullOr(Schema.String)),
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingMessageRoomOrder = await tx.run(
          builder.messageRoomOrder.where("messageId", "=", args.messageId).one(),
        );

        await tx.mutate.messageRoomOrder.upsert(
          zeroTableAccess.messageRoomOrder.upsertWithTimestamps(
            {
              messageId: args.messageId,
              previousFills: args.previousFills.slice(),
              fills: args.fills.slice(),
              hour: args.hour,
              rank: args.rank,
              tentative: args.tentative ?? existingMessageRoomOrder?.tentative ?? false,
              monitor: args.monitor,
              guildId: args.guildId,
              messageChannelId: args.messageChannelId,
              createdByUserId: args.createdByUserId,
              deletedAt: null,
            },
            existingMessageRoomOrder,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("persistMessageRoomOrder", {
      request: Schema.Struct({
        messageId: Schema.String,
        data: Schema.Struct({
          previousFills: Schema.Array(Schema.String),
          fills: Schema.Array(Schema.String),
          hour: Schema.Number,
          rank: Schema.Number,
          tentative: Schema.optional(Schema.Boolean),
          monitor: Schema.optional(Schema.NullOr(Schema.String)),
          guildId: Schema.NullOr(Schema.String),
          messageChannelId: Schema.NullOr(Schema.String),
          createdByUserId: Schema.NullOr(Schema.String),
        }),
        entries: Schema.Array(
          Schema.Struct({
            rank: Schema.Number,
            position: Schema.Number,
            hour: Schema.Number,
            team: Schema.String,
            tags: Schema.Array(Schema.String),
            effectValue: Schema.Number,
          }),
        ),
      }),
      mutator: async ({ tx, args }) => {
        const existingMessageRoomOrder = await tx.run(
          builder.messageRoomOrder.where("messageId", "=", args.messageId).one(),
        );

        await tx.mutate.messageRoomOrder.upsert(
          zeroTableAccess.messageRoomOrder.upsertWithTimestamps(
            {
              messageId: args.messageId,
              previousFills: args.data.previousFills.slice(),
              fills: args.data.fills.slice(),
              hour: args.data.hour,
              rank: args.data.rank,
              tentative: args.data.tentative ?? existingMessageRoomOrder?.tentative ?? false,
              monitor: args.data.monitor,
              guildId: args.data.guildId,
              messageChannelId: args.data.messageChannelId,
              createdByUserId: args.data.createdByUserId,
              deletedAt: null,
            },
            existingMessageRoomOrder,
          ),
        );

        await Promise.all(
          args.entries.map(async (entry) => {
            const existingEntry = await tx.run(
              builder.messageRoomOrderEntry
                .where("messageId", "=", args.messageId)
                .where("rank", "=", entry.rank)
                .where("position", "=", entry.position)
                .one(),
            );

            return tx.mutate.messageRoomOrderEntry.upsert(
              zeroTableAccess.messageRoomOrderEntry.upsertWithTimestamps(
                {
                  messageId: args.messageId,
                  rank: entry.rank,
                  position: entry.position,
                  hour: entry.hour,
                  team: entry.team,
                  tags: entry.tags.slice(),
                  effectValue: entry.effectValue,
                  deletedAt: null,
                },
                existingEntry,
              ),
            );
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("upsertMessageRoomOrderEntry", {
      request: Schema.Struct({
        messageId: Schema.String,
        entries: Schema.Array(
          Schema.Struct({
            rank: Schema.Number,
            position: Schema.Number,
            hour: Schema.Number,
            team: Schema.String,
            tags: Schema.Array(Schema.String),
            effectValue: Schema.Number,
          }),
        ),
      }),
      mutator: async ({ tx, args }) => {
        await Promise.all(
          args.entries.map(async (entry) => {
            const existingEntry = await tx.run(
              builder.messageRoomOrderEntry
                .where("messageId", "=", args.messageId)
                .where("rank", "=", entry.rank)
                .where("position", "=", entry.position)
                .one(),
            );

            return tx.mutate.messageRoomOrderEntry.upsert(
              zeroTableAccess.messageRoomOrderEntry.upsertWithTimestamps(
                {
                  messageId: args.messageId,
                  rank: entry.rank,
                  position: entry.position,
                  hour: entry.hour,
                  team: entry.team,
                  tags: entry.tags.slice(),
                  effectValue: entry.effectValue,
                  deletedAt: null,
                },
                existingEntry,
              ),
            );
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeMessageRoomOrderEntry", {
      request: Schema.Struct({
        messageId: Schema.String,
        rank: Schema.Number,
        position: Schema.Number,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageRoomOrderEntry.update(
          zeroTableAccess.messageRoomOrderEntry.softDeleteByPrimaryKey({
            messageId: args.messageId,
            rank: args.rank,
            position: args.position,
          }),
        ),
    }),
  );

  const MessageSlotGroup = ZeroApiGroup.make("messageSlot").add(
    ZeroApiEndpoint.query("getMessageSlotData", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageSlot.getMessageSlotData,
      query: ({ args: { messageId } }) =>
        zeroTableAccess.messageSlot.getActiveByPrimaryKey(builder.messageSlot, { messageId }),
    }),
    ZeroApiEndpoint.mutator("upsertMessageSlotData", {
      request: Schema.Struct({
        messageId: Schema.String,
        day: Schema.Number,
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingSlot = await tx.run(
          builder.messageSlot.where("messageId", "=", args.messageId).one(),
        );

        await tx.mutate.messageSlot.upsert(
          zeroTableAccess.messageSlot.upsertWithTimestamps(
            {
              messageId: args.messageId,
              day: args.day,
              guildId: args.guildId,
              messageChannelId: args.messageChannelId,
              createdByUserId: args.createdByUserId,
              deletedAt: null,
            },
            existingSlot,
          ),
        );
      },
    }),
  );

  return make("sheet")
    .add(GuildConfigGroup)
    .add(MessageCheckinGroup)
    .add(MessageRoomOrderGroup)
    .add(MessageSlotGroup);
};

export function makeSheetZeroApi(): ReturnType<
  typeof makeSheetZeroApiWithSuccess<typeof defaultSuccessSchemas>
>;
export function makeSheetZeroApi<const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
): ReturnType<typeof makeSheetZeroApiWithSuccess<SuccessSchemas>>;
export function makeSheetZeroApi(success: SheetZeroApiSuccessSchemas = defaultSuccessSchemas) {
  return makeSheetZeroApiWithSuccess(success);
}

export const SheetZeroApi = makeSheetZeroApi();
