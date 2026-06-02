import { defineMutator } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { zeroTableAccess } from "../accessors";
import { builder, type Schema as ZeroSchema } from "../schema";
import { preserveOmitted } from "../timestamps";

declare module "@rocicorp/zero" {
  interface DefaultTypes {
    schema: ZeroSchema;
  }
}

export const guildConfig = {
  upsertGuildConfig: defineMutator(
    pipe(
      Schema.Struct({
        guildId: Schema.String,
        sheetId: Schema.optional(Schema.NullOr(Schema.String)),
        autoCheckin: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
      const existingConfigGuild = await tx.run(
        builder.configGuild.where("guildId", "=", args.guildId).one(),
      );

      await tx.mutate.configGuild.upsert(
        zeroTableAccess.configGuild.upsertWithTimestamps(
          {
            guildId: args.guildId,
            sheetId: preserveOmitted(args.sheetId, existingConfigGuild?.sheetId),
            autoCheckin: preserveOmitted(args.autoCheckin, existingConfigGuild?.autoCheckin),
            deletedAt: null,
          },
          existingConfigGuild,
        ),
      );
    },
  ),
  addGuildMonitorRole: defineMutator(
    pipe(
      Schema.Struct({
        guildId: Schema.String,
        roleId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
      const existingRole = await tx.run(
        builder.configGuildManagerRole
          .where("guildId", "=", args.guildId)
          .where("roleId", "=", args.roleId)
          .one(),
      );

      await tx.mutate.configGuildManagerRole.upsert(
        zeroTableAccess.configGuildManagerRole.upsertWithTimestamps(
          {
            guildId: args.guildId,
            roleId: args.roleId,
            deletedAt: null,
          },
          existingRole,
        ),
      );
    },
  ),
  removeGuildMonitorRole: defineMutator(
    pipe(
      Schema.Struct({
        guildId: Schema.String,
        roleId: Schema.String,
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) =>
      await tx.mutate.configGuildManagerRole.update(
        zeroTableAccess.configGuildManagerRole.softDeleteByPrimaryKey({
          guildId: args.guildId,
          roleId: args.roleId,
        }),
      ),
  ),
  upsertGuildChannelConfig: defineMutator(
    pipe(
      Schema.Struct({
        guildId: Schema.String,
        channelId: Schema.String,
        name: Schema.optional(Schema.NullOr(Schema.String)),
        running: Schema.optional(Schema.NullOr(Schema.Boolean)),
        roleId: Schema.optional(Schema.NullOr(Schema.String)),
        checkinChannelId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
      Schema.toStandardSchemaV1,
    ),
    async ({ tx, args }) => {
      const existingChannel = await tx.run(
        builder.configGuildChannel
          .where("guildId", "=", args.guildId)
          .where("channelId", "=", args.channelId)
          .one(),
      );

      await tx.mutate.configGuildChannel.upsert(
        zeroTableAccess.configGuildChannel.upsertWithTimestamps(
          {
            guildId: args.guildId,
            channelId: args.channelId,
            name: preserveOmitted(args.name, existingChannel?.name),
            running: preserveOmitted(args.running, existingChannel?.running),
            roleId: preserveOmitted(args.roleId, existingChannel?.roleId),
            checkinChannelId: preserveOmitted(
              args.checkinChannelId,
              existingChannel?.checkinChannelId,
            ),
            deletedAt: null,
          },
          existingChannel,
        ),
      );
    },
  ),
};
