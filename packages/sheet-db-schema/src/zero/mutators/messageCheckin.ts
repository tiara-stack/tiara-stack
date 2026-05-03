import { defineMutator } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { builder, Schema as ZeroSchema } from "../schema";

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
    async ({ tx, args }) =>
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
  ),
  setMessageCheckinMemberCheckinAt: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
        checkinAt: Schema.Number,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) =>
      await tx.mutate.messageCheckinMember.update({
        messageId: args.messageId,
        memberId: args.memberId,
        checkinAt: args.checkinAt,
      }),
  ),
  setMessageCheckinMemberCheckinAtIfUnset: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        memberId: Schema.String,
        checkinAt: Schema.Number,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
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
      await tx.mutate.messageCheckinMember.update({
        messageId: args.messageId,
        memberId: args.memberId,
        deletedAt: Date.now() / 1000,
      }),
  ),
};
