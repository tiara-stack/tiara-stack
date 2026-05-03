import { Schema } from "effect";
import { make, ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { builder, Schema as ZeroSchema } from "./schema";

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: ZeroSchema;
  }
}

const CLAIM_STALE_MS = 10 * 60 * 1000;

const isActiveSendClaim = (
  claimId: string | null | undefined,
  claimedAt: number | null | undefined,
  now: number,
) =>
  claimId !== null &&
  claimId !== undefined &&
  claimedAt !== null &&
  claimedAt !== undefined &&
  now - claimedAt <= CLAIM_STALE_MS;

const isActiveTimestampClaim = (claimedAt: number | null | undefined, now: number) =>
  claimedAt !== null && claimedAt !== undefined && now - claimedAt <= CLAIM_STALE_MS;

const hasActiveTentativePinClaim = (messageRoomOrder: {
  readonly tentativePinClaimId?: string | null;
  readonly tentativePinClaimedAt?: number | null;
}) =>
  messageRoomOrder.tentativePinClaimId !== null &&
  messageRoomOrder.tentativePinClaimId !== undefined &&
  isActiveTimestampClaim(messageRoomOrder.tentativePinClaimedAt, Date.now());

export interface SheetZeroApiSuccessSchemas {
  readonly guildConfig: {
    readonly getAutoCheckinGuilds: Schema.Top;
    readonly getGuildConfigByGuildId: Schema.Top;
    readonly getGuildMonitorRoles: Schema.Top;
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
        builder.configGuild.where("autoCheckin", "=", true).where("deletedAt", "IS", null),
    }),
    ZeroApiEndpoint.query("getGuildConfigByGuildId", {
      request: Schema.Struct({ guildId: Schema.String }),
      success: success.guildConfig.getGuildConfigByGuildId,
      query: ({ args: { guildId } }) =>
        builder.configGuild.where("guildId", "=", guildId).where("deletedAt", "IS", null).one(),
    }),
    ZeroApiEndpoint.query("getGuildMonitorRoles", {
      request: Schema.Struct({ guildId: Schema.String }),
      success: success.guildConfig.getGuildMonitorRoles,
      query: ({ args: { guildId } }) =>
        builder.configGuildManagerRole
          .where("guildId", "=", guildId)
          .where("deletedAt", "IS", null),
    }),
    ZeroApiEndpoint.query("getGuildChannels", {
      request: Schema.Struct({
        guildId: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      success: success.guildConfig.getGuildChannels,
      query: ({ args: { guildId, running } }) => {
        const query = builder.configGuildChannel
          .where("guildId", "=", guildId)
          .where("deletedAt", "IS", null);

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
        const query = builder.configGuildChannel
          .where("guildId", "=", guildId)
          .where("channelId", "=", channelId)
          .where("deletedAt", "IS", null);

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
        const query = builder.configGuildChannel
          .where("guildId", "=", guildId)
          .where("name", "=", channelName)
          .where("deletedAt", "IS", null);

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
      mutator: async ({ tx, args }) =>
        await tx.mutate.configGuild.upsert({
          guildId: args.guildId,
          sheetId: args.sheetId,
          autoCheckin: args.autoCheckin,
          deletedAt: null,
        }),
    }),
    ZeroApiEndpoint.mutator("addGuildMonitorRole", {
      request: Schema.Struct({
        guildId: Schema.String,
        roleId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.configGuildManagerRole.upsert({
          guildId: args.guildId,
          roleId: args.roleId,
          deletedAt: null,
        }),
    }),
    ZeroApiEndpoint.mutator("removeGuildMonitorRole", {
      request: Schema.Struct({
        guildId: Schema.String,
        roleId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.configGuildManagerRole.update({
          guildId: args.guildId,
          roleId: args.roleId,
          deletedAt: Date.now() / 1000,
        }),
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
      mutator: async ({ tx, args }) =>
        await tx.mutate.configGuildChannel.upsert({
          guildId: args.guildId,
          channelId: args.channelId,
          name: args.name,
          running: args.running,
          roleId: args.roleId,
          checkinChannelId: args.checkinChannelId,
          deletedAt: null,
        }),
    }),
  );

  const MessageCheckinGroup = ZeroApiGroup.make("messageCheckin").add(
    ZeroApiEndpoint.query("getMessageCheckinData", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageCheckin.getMessageCheckinData,
      query: ({ args: { messageId } }) =>
        builder.messageCheckin
          .where("messageId", "=", messageId)
          .where("deletedAt", "IS", null)
          .one(),
    }),
    ZeroApiEndpoint.query("getMessageCheckinMembers", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageCheckin.getMessageCheckinMembers,
      query: ({ args: { messageId } }) =>
        builder.messageCheckinMember
          .where("messageId", "=", messageId)
          .where("deletedAt", "IS", null),
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
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckin.upsert({
          messageId: args.messageId,
          initialMessage: args.initialMessage,
          hour: args.hour,
          channelId: args.channelId,
          roleId: args.roleId,
          guildId: args.guildId,
          messageChannelId: args.messageChannelId,
          createdByUserId: args.createdByUserId,
          deletedAt: null,
        }),
    }),
    ZeroApiEndpoint.mutator("addMessageCheckinMembers", {
      request: Schema.Struct({
        messageId: Schema.String,
        memberIds: Schema.Array(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        await Promise.all(
          args.memberIds.map((memberId) =>
            tx.mutate.messageCheckinMember.upsert({
              messageId: args.messageId,
              memberId,
              checkinAt: null,
              deletedAt: null,
            }),
          ),
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
        await tx.mutate.messageCheckin.upsert({
          messageId: args.messageId,
          initialMessage: args.data.initialMessage,
          hour: args.data.hour,
          channelId: args.data.channelId,
          roleId: args.data.roleId,
          guildId: args.data.guildId,
          messageChannelId: args.data.messageChannelId,
          createdByUserId: args.data.createdByUserId,
          deletedAt: null,
        });

        await Promise.all(
          args.memberIds.map((memberId) =>
            tx.mutate.messageCheckinMember.upsert({
              messageId: args.messageId,
              memberId,
              checkinAt: null,
              deletedAt: null,
            }),
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("setMessageCheckinMemberCheckinAt", {
      request: Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
        checkinAt: Schema.Number,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckinMember.update({
          messageId: args.messageId,
          memberId: args.memberId,
          checkinAt: args.checkinAt,
        }),
    }),
    ZeroApiEndpoint.mutator("setMessageCheckinMemberCheckinAtIfUnset", {
      request: Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
        checkinAt: Schema.Number,
      }),
      mutator: async ({ tx, args }) => {
        const member = await tx.run(
          builder.messageCheckinMember
            .where("messageId", "=", args.messageId)
            .where("memberId", "=", args.memberId)
            .where("deletedAt", "IS", null)
            .one(),
        );
        if (!member || member.checkinAt !== null) return;
        await tx.mutate.messageCheckinMember.update({
          messageId: args.messageId,
          memberId: args.memberId,
          checkinAt: args.checkinAt,
        });
      },
    }),
    ZeroApiEndpoint.mutator("removeMessageCheckinMember", {
      request: Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckinMember.update({
          messageId: args.messageId,
          memberId: args.memberId,
          deletedAt: Date.now() / 1000,
        }),
    }),
  );

  const MessageRoomOrderGroup = ZeroApiGroup.make("messageRoomOrder").add(
    ZeroApiEndpoint.query("getMessageRoomOrder", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageRoomOrder.getMessageRoomOrder,
      query: ({ args: { messageId } }) =>
        builder.messageRoomOrder
          .where("messageId", "=", messageId)
          .where("deletedAt", "IS", null)
          .one(),
    }),
    ZeroApiEndpoint.query("getMessageRoomOrderEntry", {
      request: Schema.Struct({ messageId: Schema.String, rank: Schema.Number }),
      success: success.messageRoomOrder.getMessageRoomOrderEntry,
      query: ({ args: { messageId, rank } }) =>
        builder.messageRoomOrderEntry
          .where("messageId", "=", messageId)
          .where("rank", "=", rank)
          .where("deletedAt", "IS", null)
          .orderBy("position", "asc"),
    }),
    ZeroApiEndpoint.query("getMessageRoomOrderRange", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageRoomOrder.getMessageRoomOrderRange,
      query: ({ args: { messageId } }) =>
        builder.messageRoomOrderEntry
          .where("messageId", "=", messageId)
          .where("deletedAt", "IS", null),
    }),
    ZeroApiEndpoint.mutator("decrementMessageRoomOrderRank", {
      request: Schema.Struct({ messageId: Schema.String }),
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
          hasActiveTentativePinClaim(messageRoomOrder)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update({
          messageId: args.messageId,
          rank: messageRoomOrder.rank - 1,
        });
      },
    }),
    ZeroApiEndpoint.mutator("incrementMessageRoomOrderRank", {
      request: Schema.Struct({ messageId: Schema.String }),
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
          hasActiveTentativePinClaim(messageRoomOrder)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update({
          messageId: args.messageId,
          rank: messageRoomOrder.rank + 1,
        });
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
          isActiveSendClaim(messageRoomOrder.sendClaimId, messageRoomOrder.sendClaimedAt, now)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update({
          messageId: args.messageId,
          sendClaimId: args.claimId,
          sendClaimedAt: now,
        });
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
        await tx.mutate.messageRoomOrder.update({
          messageId: args.messageId,
          sendClaimId: null,
          sendClaimedAt: null,
          sentMessageId: args.sentMessageId,
          sentMessageChannelId: args.sentMessageChannelId,
          sentAt: args.sentAt,
        });
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
        await tx.mutate.messageRoomOrder.update({
          messageId: args.messageId,
          sendClaimId: null,
          sendClaimedAt: null,
        });
      },
    }),
    ZeroApiEndpoint.mutator("claimMessageRoomOrderTentativePin", {
      request: Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
        claimedAt: Schema.Number,
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
          hasActiveTentativePinClaim(messageRoomOrder)
        ) {
          return;
        }
        await tx.mutate.messageRoomOrder.update({
          messageId: args.messageId,
          tentativePinClaimId: args.claimId,
          tentativePinClaimedAt: args.claimedAt,
        });
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
        await tx.mutate.messageRoomOrder.update({
          messageId: args.messageId,
          tentativePinClaimId: null,
          tentativePinClaimedAt: null,
          tentativePinnedAt: args.pinnedAt,
        });
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
        await tx.mutate.messageRoomOrder.update({
          messageId: args.messageId,
          tentativePinClaimId: null,
          tentativePinClaimedAt: null,
        });
      },
    }),
    ZeroApiEndpoint.mutator("upsertMessageRoomOrder", {
      request: Schema.Struct({
        messageId: Schema.String,
        previousFills: Schema.Array(Schema.String),
        fills: Schema.Array(Schema.String),
        hour: Schema.Number,
        rank: Schema.Number,
        monitor: Schema.optional(Schema.NullOr(Schema.String)),
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageRoomOrder.upsert({
          messageId: args.messageId,
          previousFills: args.previousFills.slice(),
          fills: args.fills.slice(),
          hour: args.hour,
          rank: args.rank,
          monitor: args.monitor,
          guildId: args.guildId,
          messageChannelId: args.messageChannelId,
          createdByUserId: args.createdByUserId,
          deletedAt: null,
        }),
    }),
    ZeroApiEndpoint.mutator("persistMessageRoomOrder", {
      request: Schema.Struct({
        messageId: Schema.String,
        data: Schema.Struct({
          previousFills: Schema.Array(Schema.String),
          fills: Schema.Array(Schema.String),
          hour: Schema.Number,
          rank: Schema.Number,
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
        await tx.mutate.messageRoomOrder.upsert({
          messageId: args.messageId,
          previousFills: args.data.previousFills.slice(),
          fills: args.data.fills.slice(),
          hour: args.data.hour,
          rank: args.data.rank,
          monitor: args.data.monitor,
          guildId: args.data.guildId,
          messageChannelId: args.data.messageChannelId,
          createdByUserId: args.data.createdByUserId,
          deletedAt: null,
        });

        await Promise.all(
          args.entries.map((entry) =>
            tx.mutate.messageRoomOrderEntry.upsert({
              messageId: args.messageId,
              rank: entry.rank,
              position: entry.position,
              hour: entry.hour,
              team: entry.team,
              tags: entry.tags.slice(),
              effectValue: entry.effectValue,
              deletedAt: null,
            }),
          ),
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
          args.entries.map((entry) =>
            tx.mutate.messageRoomOrderEntry.upsert({
              messageId: args.messageId,
              rank: entry.rank,
              position: entry.position,
              hour: entry.hour,
              team: entry.team,
              tags: entry.tags.slice(),
              effectValue: entry.effectValue,
              deletedAt: null,
            }),
          ),
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
        await tx.mutate.messageRoomOrderEntry.update({
          messageId: args.messageId,
          rank: args.rank,
          position: args.position,
          deletedAt: Date.now() / 1000,
        }),
    }),
  );

  const MessageSlotGroup = ZeroApiGroup.make("messageSlot").add(
    ZeroApiEndpoint.query("getMessageSlotData", {
      request: Schema.Struct({ messageId: Schema.String }),
      success: success.messageSlot.getMessageSlotData,
      query: ({ args: { messageId } }) =>
        builder.messageSlot.where("messageId", "=", messageId).where("deletedAt", "IS", null).one(),
    }),
    ZeroApiEndpoint.mutator("upsertMessageSlotData", {
      request: Schema.Struct({
        messageId: Schema.String,
        day: Schema.Number,
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageSlot.upsert({
          messageId: args.messageId,
          day: args.day,
          guildId: args.guildId,
          messageChannelId: args.messageChannelId,
          createdByUserId: args.createdByUserId,
          deletedAt: null,
        }),
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
