import { defineMutator } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { zeroTableAccess } from "../accessors";
import { builder, type Schema as ZeroSchema } from "../schema";

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: ZeroSchema;
  }
}

export const messageSlot = {
  upsertMessageSlotData: defineMutator(
    pipe(
      Schema.Struct({
        messageId: Schema.String,
        day: Schema.Number,
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
      const existingSlot = await tx.run(
        builder.messageSlot.where("messageId", "=", args.messageId).one(),
      );

      await tx.mutate.messageSlot.upsert(
        zeroTableAccess.messageSlot.upsertWithTimestamps(
          {
            messageId: args.messageId,
            day: args.day,
            guildId: args.guildId,
            messageChannelId: args.messageChannelId,
            createdByUserId: args.createdByUserId,
            deletedAt: null,
          },
          existingSlot,
        ),
      );
    },
  ),
};
