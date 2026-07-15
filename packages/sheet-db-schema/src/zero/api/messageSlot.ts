import { Schema } from "effect";
import { ZeroApiEndpoint, ZeroApiGroup } from "typhoon-zero/zeroApi";
import { zeroTableAccess } from "../accessors";
import { MessageKeyRequest } from "./requests";
import type { SheetZeroApiSuccessSchemas } from "./successSchemas";

export const makeMessageSlotGroup = <const SuccessSchemas extends SheetZeroApiSuccessSchemas>(
  success: SuccessSchemas,
) =>
  ZeroApiGroup.make("messageSlot").add(
    ZeroApiEndpoint.query("getMessageSlotData", {
      request: Schema.Struct(MessageKeyRequest),
      success: success.messageSlot.getMessageSlotData,
      query: ({ args: { clientPlatform, clientId, messageId } }) =>
        zeroTableAccess.messageSlot.getActiveByPrimaryKey(zeroTableAccess.messageSlot.table, {
          clientPlatform,
          clientId,
          messageId,
        }),
    }),
    ZeroApiEndpoint.mutator("upsertMessageSlotData", {
      request: Schema.Struct({
        ...MessageKeyRequest,
        day: Schema.Number,
        workspaceId: Schema.NullOr(Schema.String),
        conversationId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      mutator: async ({ tx, args }) => {
        const existingSlot = await tx.run(
          zeroTableAccess.messageSlot.getByPrimaryKey(zeroTableAccess.messageSlot.table, {
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
          }),
        );

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
            existingSlot,
          ),
        );
      },
    }),
  );

export type MessageSlotGroup<SuccessSchemas extends SheetZeroApiSuccessSchemas> = ReturnType<
  typeof makeMessageSlotGroup<SuccessSchemas>
>;
