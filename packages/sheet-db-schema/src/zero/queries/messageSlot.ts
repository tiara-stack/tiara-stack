import { defineQuery } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { zeroTableAccess } from "../accessors";
import { builder } from "../schema";

export const messageSlot = {
  getMessageSlotData: defineQuery(
    pipe(Schema.Struct({ messageId: Schema.String }), Schema.toStandardSchemaV1),
    ({ args: { messageId } }) =>
      zeroTableAccess.messageSlot.getActiveByPrimaryKey(builder.messageSlot, { messageId }),
  ),
};
