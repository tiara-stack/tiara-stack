import type { Schema as RocicorpSchema, Transaction } from "@rocicorp/zero";
import { Option, Predicate, Schema } from "effect";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "../accessors";
import { preserveOmitted } from "../timestamps";
import { MessageKeyRequest } from "./requests";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

type CheckinKey = {
  readonly clientPlatform: string;
  readonly clientId: string;
  readonly messageId: string;
};

type CheckinData = {
  readonly initialMessage: ReadonlyArray<typeof ReadonlyJSONValue.Type>;
  readonly hour: number;
  readonly runningConversationId: string;
  readonly roleId?: string | null | undefined;
  readonly workspaceId: string | null;
  readonly conversationId: string | null;
  readonly createdByUserId: string | null;
};

type CheckinTransaction = Transaction<RocicorpSchema, unknown>;

const checkinProgress = <
  T extends {
    readonly checkinAt?: number | null | undefined;
    readonly checkinClaimId?: string | null | undefined;
  },
>(
  member: T | null | undefined,
) =>
  Option.match(Option.fromNullishOr(member), {
    onNone: () => ({ checkinAt: null, checkinClaimId: null }),
    onSome: ({ checkinAt, checkinClaimId }) => ({ checkinAt, checkinClaimId }),
  });

const upsertCheckinRow = async (tx: CheckinTransaction, key: CheckinKey, data: CheckinData) => {
  const existingCheckin = await tx.run(
    zeroTableAccess.messageCheckin.table
      .where("clientPlatform", "=", key.clientPlatform)
      .where("clientId", "=", key.clientId)
      .where("messageId", "=", key.messageId)
      .one(),
  );
  await tx.mutate.messageCheckin.upsert(
    zeroTableAccess.messageCheckin.upsertWithTimestamps(
      {
        clientPlatform: key.clientPlatform,
        clientId: key.clientId,
        messageId: key.messageId,
        initialMessage: data.initialMessage,
        hour: data.hour,
        runningConversationId: data.runningConversationId,
        roleId: preserveOmitted(data.roleId, existingCheckin?.roleId),
        workspaceId: data.workspaceId,
        conversationId: data.conversationId,
        createdByUserId: data.createdByUserId,
        deletedAt: null,
      },
      existingCheckin,
    ),
  );
};

const upsertCheckinMembers = async (
  tx: CheckinTransaction,
  key: CheckinKey,
  memberIds: ReadonlyArray<string>,
) => {
  await Promise.all(
    memberIds.map(async (memberId) => {
      const existingMember = await tx.run(
        zeroTableAccess.messageCheckinMember.table
          .where("clientPlatform", "=", key.clientPlatform)
          .where("clientId", "=", key.clientId)
          .where("messageId", "=", key.messageId)
          .where("memberId", "=", memberId)
          .one(),
      );
      return tx.mutate.messageCheckinMember.upsert(
        zeroTableAccess.messageCheckinMember.upsertWithTimestamps(
          {
            clientPlatform: key.clientPlatform,
            clientId: key.clientId,
            messageId: key.messageId,
            memberId,
            ...checkinProgress(existingMember),
            deletedAt: null,
          },
          existingMember,
        ),
      );
    }),
  );
};

export const makeMessageCheckinGroup = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("messageCheckin").add(
    ZeroApiEndpoint.query("getMessageCheckinData", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageCheckin.getMessageCheckinData,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageCheckin.getActiveByPrimaryKey(zeroTableAccess.messageCheckin.table, {
          clientPlatform,
          clientId,
          messageId,
        }),
    }),
    ZeroApiEndpoint.query("getMessageCheckinMembers", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageCheckin.getMessageCheckinMembers,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageCheckinMember.listActiveWhere(
          zeroTableAccess.messageCheckinMember.table
            .where("clientPlatform", "=", clientPlatform)
            .where("clientId", "=", clientId)
            .where("messageId", "=", messageId),
        ),
    }),
    ZeroApiEndpoint.mutator("upsertMessageCheckinData", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        initialMessage: Schema.Array(ReadonlyJSONValue),
        hour: Schema.Number,
        runningConversationId: Schema.String,
        roleId: Schema.optional(Schema.NullOr(Schema.String)),
        workspaceId: Schema.NullOr(Schema.String),
        conversationId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) =>
        upsertCheckinRow(tx, args, {
          initialMessage: args.initialMessage,
          hour: args.hour,
          runningConversationId: args.runningConversationId,
          roleId: args.roleId,
          workspaceId: args.workspaceId,
          conversationId: args.conversationId,
          createdByUserId: args.createdByUserId,
        }),
    }),
    ZeroApiEndpoint.mutator("addMessageCheckinMembers", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        memberIds: Schema.Array(Schema.String),
      }),
      mutator: async ({ tx, args }) => upsertCheckinMembers(tx, args, args.memberIds),
    }),
    ZeroApiEndpoint.mutator("persistMessageCheckin", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        data: Schema.Struct({
          initialMessage: Schema.Array(ReadonlyJSONValue),
          hour: Schema.Number,
          runningConversationId: Schema.String,
          roleId: Schema.optional(Schema.NullOr(Schema.String)),
          workspaceId: Schema.NullOr(Schema.String),
          conversationId: Schema.NullOr(Schema.String),
          createdByUserId: Schema.NullOr(Schema.String),
        }),
        memberIds: Schema.Array(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        await upsertCheckinRow(tx, args, args.data);
        await upsertCheckinMembers(tx, args, args.memberIds);
      },
    }),
    ZeroApiEndpoint.mutator("setMessageCheckinMemberCheckinAt", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        memberId: Schema.String,
        checkinAt: Schema.Number,
        checkinClaimId: Schema.optional(Schema.String),
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            memberId: args.memberId,
            checkinAt: args.checkinAt,
            checkinClaimId: args.checkinClaimId ?? null,
          }),
        ),
    }),
    ZeroApiEndpoint.mutator("setMessageCheckinMemberCheckinAtIfUnset", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        memberId: Schema.String,
        checkinAt: Schema.Number,
        checkinClaimId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const member = await tx.run(
          zeroTableAccess.messageCheckinMember.getActiveByPrimaryKey(
            zeroTableAccess.messageCheckinMember.table,
            {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              memberId: args.memberId,
            },
          ),
        );
        if (Predicate.isNullish(member) || Predicate.isNotNullish(member.checkinAt)) return;
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.updateWithTimestamp({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
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
        ...MessageKeyRequest,
        memberId: Schema.String,
      }),
      mutator: async ({ tx, args }) =>
        await tx.mutate.messageCheckinMember.update(
          zeroTableAccess.messageCheckinMember.softDeleteByPrimaryKey({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            memberId: args.memberId,
          }),
        ),
    }),
  );

export type MessageCheckinGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeMessageCheckinGroup<SuccessSchemas>
>;
