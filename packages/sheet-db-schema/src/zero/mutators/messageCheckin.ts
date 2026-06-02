import { defineMutator } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { zeroTableAccess } from "../accessors";
import { builder, type Schema as ZeroSchema } from "../schema";

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: ZeroSchema;
  }
}

export const messageCheckin = {
  upsertMessageCheckinData: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        initialMessage: Schema.String,
        hour: Schema.Number,
        channelId: Schema.String,
        roleId: Schema.optional(Schema.NullOr(Schema.String)),
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  addMessageCheckinMembers: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        memberIds: Schema.Array(Schema.String),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  persistMessageCheckin: defineMutator(
    pipe(
      Schema.Struct({
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
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  setMessageCheckinMemberCheckinAt: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
        checkinAt: Schema.Number,
        checkinClaimId: Schema.optional(Schema.String),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) =>
      await tx.mutate.messageCheckinMember.update(
        zeroTableAccess.messageCheckinMember.updateWithTimestamp({
          messageId: args.messageId,
          memberId: args.memberId,
          checkinAt: args.checkinAt,
          checkinClaimId: args.checkinClaimId ?? null,
        }),
      ),
  ),
  setMessageCheckinMemberCheckinAtIfUnset: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
        checkinAt: Schema.Number,
        checkinClaimId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
  ),
  removeMessageCheckinMember: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) =>
      await tx.mutate.messageCheckinMember.update(
        zeroTableAccess.messageCheckinMember.softDeleteByPrimaryKey({
          messageId: args.messageId,
          memberId: args.memberId,
        }),
      ),
  ),
};
