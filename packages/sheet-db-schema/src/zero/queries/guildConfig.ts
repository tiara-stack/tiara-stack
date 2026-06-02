import { defineQuery } from "@rocicorp/zero";
import { Schema, pipe } from "effect";
import { zeroTableAccess } from "../accessors";
import { builder } from "../schema";

export const guildConfig = {
  getAutoCheckinGuilds: defineQuery(pipe(Schema.Struct({}), Schema.toStandardSchemaV1), () =>
    zeroTableAccess.configGuild.listActiveWhere(
      builder.configGuild.where("autoCheckin", "=", true),
    ),
  ),
  getGuildConfigByGuildId: defineQuery(
    pipe(Schema.Struct({ guildId: Schema.String }), Schema.toStandardSchemaV1),
    ({ args: { guildId } }) =>
      zeroTableAccess.configGuild.getActiveByPrimaryKey(builder.configGuild, { guildId }),
  ),
  getGuildMonitorRoles: defineQuery(
    pipe(Schema.Struct({ guildId: Schema.String }), Schema.toStandardSchemaV1),
    ({ args: { guildId } }) =>
      zeroTableAccess.configGuildManagerRole.listActiveWhere(
        builder.configGuildManagerRole.where("guildId", "=", guildId),
      ),
  ),
  getGuildChannels: defineQuery(
    pipe(
      Schema.Struct({
        guildId: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      Schema.toStandardSchemaV1,
    ),
    ({ args: { guildId, running } }) => {
      const query = zeroTableAccess.configGuildChannel.listActiveWhere(
        builder.configGuildChannel.where("guildId", "=", guildId),
      );

      return typeof running === "undefined" ? query : query.where("running", "=", running);
    },
  ),
  getGuildChannelById: defineQuery(
    pipe(
      Schema.Struct({
        guildId: Schema.String,
        channelId: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      Schema.toStandardSchemaV1,
    ),
    ({ args: { guildId, channelId, running } }) => {
      const query = zeroTableAccess.configGuildChannel.listActiveWhere(
        builder.configGuildChannel
          .where("guildId", "=", guildId)
          .where("channelId", "=", channelId),
      );

      return (typeof running === "undefined" ? query : query.where("running", "=", running)).one();
    },
  ),
  getGuildChannelByName: defineQuery(
    pipe(
      Schema.Struct({
        guildId: Schema.String,
        channelName: Schema.String,
        running: Schema.optional(Schema.Boolean),
      }),
      Schema.toStandardSchemaV1,
    ),
    ({ args: { guildId, channelName, running } }) => {
      const query = zeroTableAccess.configGuildChannel.listActiveWhere(
        builder.configGuildChannel.where("guildId", "=", guildId).where("name", "=", channelName),
      );

      return (typeof running === "undefined" ? query : query.where("running", "=", running)).one();
    },
  ),
};
