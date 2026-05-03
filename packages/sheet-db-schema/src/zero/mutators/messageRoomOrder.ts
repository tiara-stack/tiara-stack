import { defineMutator } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { builder, Schema as ZeroSchema } from "../schema";

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

export const messageRoomOrder = {
  decrementMessageRoomOrderRank: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
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
        hasActiveTentativePinClaim(messageRoomOrder)
      ) {
        return;
      }
      await tx.mutate.messageRoomOrder.update({
        messageId: args.messageId,
        rank: messageRoomOrder.rank - 1,
      });
    },
  ),
  incrementMessageRoomOrderRank: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
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
        hasActiveTentativePinClaim(messageRoomOrder)
      ) {
        return;
      }
      await tx.mutate.messageRoomOrder.update({
        messageId: args.messageId,
        rank: messageRoomOrder.rank + 1,
      });
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
      await tx.mutate.messageRoomOrder.update({
        messageId: args.messageId,
        sendClaimId: null,
        sendClaimedAt: null,
        sentMessageId: args.sentMessageId,
        sentMessageChannelId: args.sentMessageChannelId,
        sentAt: args.sentAt,
      });
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
      await tx.mutate.messageRoomOrder.update({
        messageId: args.messageId,
        sendClaimId: null,
        sendClaimedAt: null,
      });
    },
  ),
  claimMessageRoomOrderTentativePin: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        claimId: Schema.String,
        claimedAt: Schema.Number,
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
      await tx.mutate.messageRoomOrder.update({
        messageId: args.messageId,
        tentativePinClaimId: null,
        tentativePinClaimedAt: null,
        tentativePinnedAt: args.pinnedAt,
      });
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
      await tx.mutate.messageRoomOrder.update({
        messageId: args.messageId,
        tentativePinClaimId: null,
        tentativePinClaimedAt: null,
      });
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
        monitor: Schema.optional(Schema.NullOr(Schema.String)),
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) =>
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
      await tx.mutate.messageRoomOrderEntry.update({
        messageId: args.messageId,
        rank: args.rank,
        position: args.position,
        deletedAt: Date.now() / 1000,
      }),
  ),
};
