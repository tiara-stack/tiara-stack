import { defineQuery } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { zeroTableAccess } from "../accessors";
import { builder } from "../schema";

export const messageCheckin = {
  getMessageCheckinData: defineQuery(
    pipe(Schema.Struct({ messageId: Schema.String }), Schema.toStandardSchemaV1),
    ({ args: { messageId } }) =>
      zeroTableAccess.messageCheckin.getActiveByPrimaryKey(builder.messageCheckin, { messageId }),
  ),
  getMessageCheckinMembers: defineQuery(
    pipe(Schema.Struct({ messageId: Schema.String }), Schema.toStandardSchemaV1),
    ({ args: { messageId } }) =>
      zeroTableAccess.messageCheckinMember.listActiveWhere(
        builder.messageCheckinMember.where("messageId", "=", messageId),
      ),
  ),
};
