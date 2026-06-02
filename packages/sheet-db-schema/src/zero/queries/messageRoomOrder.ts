import { defineQuery } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { zeroTableAccess } from "../accessors";
import { builder } from "../schema";

export const messageRoomOrder = {
  getMessageRoomOrder: defineQuery(
    pipe(Schema.Struct({ messageId: Schema.String }), Schema.toStandardSchemaV1),
    ({ args: { messageId } }) =>
      zeroTableAccess.messageRoomOrder.getActiveByPrimaryKey(builder.messageRoomOrder, {
        messageId,
      }),
  ),
  getMessageRoomOrderEntry: defineQuery(
    pipe(
      Schema.Struct({ messageId: Schema.String, rank: Schema.Number }),
      Schema.toStandardSchemaV1,
    ),
    ({ args: { messageId, rank } }) =>
      zeroTableAccess.messageRoomOrderEntry
        .listActiveWhere(
          builder.messageRoomOrderEntry.where("messageId", "=", messageId).where("rank", "=", rank),
        )
        .orderBy("position", "asc"),
  ),
  getMessageRoomOrderRange: defineQuery(
    pipe(Schema.Struct({ messageId: Schema.String }), Schema.toStandardSchemaV1),
    ({ args: { messageId } }) =>
      zeroTableAccess.messageRoomOrderEntry.listActiveWhere(
        builder.messageRoomOrderEntry.where("messageId", "=", messageId),
      ),
  ),
};
