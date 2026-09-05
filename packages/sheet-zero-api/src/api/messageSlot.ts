import { Schema } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "../accessors";
import { activeRecord } from "../timestamps";
import { MessageConversationKeyRequest, MessageKeyRequest } from "./requests";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

const messageSlotBindingConflictCode = "MESSAGE_SLOT_BINDING_CONFLICT";

export const makeMessageSlotGroup = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("messageSlot").add(
    ZeroApiEndpoint.query("getMessageSlotData", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageSlot.getMessageSlotData,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageSlot
          .listActiveWhere(
            zeroTableAccess.messageSlot.table
              .where("clientPlatform", "=", clientPlatform)
              .where("clientId", "=", clientId)
              .where("messageId", "=", messageId),
          )
          .one(),
    }),
    ZeroApiEndpoint.query("getMessageSlotDataByConversation", {
      request: Schema.Struct(MessageConversationKeyRequest),
      success: success.messageSlot.getMessageSlotDataByConversation,
      query: ({ args: { clientPlatform, clientId, workspaceId, conversationId } }) =>
        zeroTableAccess.messageSlot.getActiveByPrimaryKey(zeroTableAccess.messageSlot.table, {
          clientPlatform,
          clientId,
          workspaceId,
          conversationId,
        }),
    }),
    ZeroApiEndpoint.mutator("upsertMessageSlotData", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        day: Schema.Number,
        workspaceId: Schema.String,
        conversationId: Schema.String,
        createdByUserId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingSlot = await tx.run(
          zeroTableAccess.messageSlot.getByPrimaryKey(zeroTableAccess.messageSlot.table, {
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
          }),
        );
        const activeExistingSlot = activeRecord(existingSlot);

        await tx.mutate.messageSlot.upsert(
          zeroTableAccess.messageSlot.upsertWithTimestamps(
            {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              day: args.day,
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              createdByUserId: args.createdByUserId,
              deletedAt: null,
            },
            activeExistingSlot,
          ),
        );
      },
    }),
    ZeroApiEndpoint.mutator("removeMessageSlotData", {
      request: Schema.Struct({
        ...MessageConversationKeyRequest,
        expectedMessageId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingSlot = await tx.run(
          zeroTableAccess.messageSlot.getByPrimaryKey(zeroTableAccess.messageSlot.table, {
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
          }),
        );
        const activeExistingSlot = activeRecord(existingSlot);
        if (activeExistingSlot?.messageId !== args.expectedMessageId) {
          throw makeArgumentError("The slot button changed before it could be removed", {
            code: messageSlotBindingConflictCode,
          });
        }

        await tx.mutate.messageSlot.update(
          zeroTableAccess.messageSlot.softDeleteByPrimaryKey({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
          }),
        );
      },
    }),
    ZeroApiEndpoint.mutator("replaceMessageSlotData", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        day: Schema.Number,
        workspaceId: Schema.String,
        conversationId: Schema.String,
        createdByUserId: Schema.String,
        expectedMessageId: Schema.String,
      }),
      mutator: async ({ tx, args }) => {
        const existingSlot = await tx.run(
          zeroTableAccess.messageSlot.getByPrimaryKey(zeroTableAccess.messageSlot.table, {
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            workspaceId: args.workspaceId,
            conversationId: args.conversationId,
          }),
        );
        const activeExistingSlot = activeRecord(existingSlot);
        if (activeExistingSlot?.messageId !== args.expectedMessageId) {
          throw makeArgumentError("The slot button changed before its replacement was bound", {
            code: messageSlotBindingConflictCode,
          });
        }

        await tx.mutate.messageSlot.upsert(
          zeroTableAccess.messageSlot.upsertWithTimestamps(
            {
              clientPlatform: args.clientPlatform,
              clientId: args.clientId,
              messageId: args.messageId,
              day: args.day,
              workspaceId: args.workspaceId,
              conversationId: args.conversationId,
              createdByUserId: args.createdByUserId,
              deletedAt: null,
            },
            activeExistingSlot,
          ),
        );
      },
    }),
  );

export type MessageSlotGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeMessageSlotGroup<SuccessSchemas>
>;
