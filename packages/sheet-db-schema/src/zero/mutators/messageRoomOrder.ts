import { defineMutator } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import {
  hasActiveSendClaim,
  hasActiveTentativePinClaim,
  hasActiveTentativeUpdateClaim,
  hasStaleUntrackedSendClaim,
  isActiveSendClaim,
} from "../claimHelpers";
import { zeroTableAccess } from "../accessors";
import { builder, type Schema as ZeroSchema } from "../schema";

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: ZeroSchema;
  }
}

export const messageRoomOrder = {
  decrementMessageRoomOrderRank: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        expectedRank: Schema.optional(Schema.Number),
        tentativeUpdateClaimId: Schema.optional(Schema.String),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
      // drizzle-zero represents timestamp columns as unix-ms numbers in Zero mutators.
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
  ),
  incrementMessageRoomOrderRank: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        expectedRank: Schema.optional(Schema.Number),
        tentativeUpdateClaimId: Schema.optional(Schema.String),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  claimMessageRoomOrderSend: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  completeMessageRoomOrderSend: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
        sentMessageId: Schema.String,
        sentMessageChannelId: Schema.String,
        sentAt: Schema.Number,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  releaseMessageRoomOrderSendClaim: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  claimMessageRoomOrderTentativeUpdate: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  releaseMessageRoomOrderTentativeUpdateClaim: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  claimMessageRoomOrderTentativePin: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  completeMessageRoomOrderTentativePin: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
        pinnedAt: Schema.Number,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  releaseMessageRoomOrderTentativePinClaim: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  markMessageRoomOrderTentative: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        guildId: Schema.String,
        messageChannelId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
      await tx.mutate.messageRoomOrder.update(
        zeroTableAccess.messageRoomOrder.updateWithTimestamp({
          messageId: args.messageId,
          tentative: true,
          guildId: args.guildId,
          messageChannelId: args.messageChannelId,
        }),
      );
    },
  ),
  upsertMessageRoomOrder: defineMutator(
    pipe(
      Schema.Struct({
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
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  persistMessageRoomOrder: defineMutator(
    pipe(
      Schema.Struct({
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
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  upsertMessageRoomOrderEntry: defineMutator(
    pipe(
      Schema.Struct({
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
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  removeMessageRoomOrderEntry: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        rank: Schema.Number,
        position: Schema.Number,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) =>
      await tx.mutate.messageRoomOrderEntry.update(
        zeroTableAccess.messageRoomOrderEntry.softDeleteByPrimaryKey({
          messageId: args.messageId,
          rank: args.rank,
          position: args.position,
        }),
      ),
  ),
};
