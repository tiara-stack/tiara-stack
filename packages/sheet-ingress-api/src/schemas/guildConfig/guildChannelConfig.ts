import { Schema } from "effect";
import { configGuildChannel } from "sheet-db-schema/models";
import type {
  BooleanOptionField,
  DateTimeOptionField,
  StringField,
  StringOptionField,
} from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const GuildChannelConfigFields = validateTaggedFields<{
  readonly guildId: StringField;
  readonly channelId: StringField;
  readonly name: StringOptionField;
  readonly running: BooleanOptionField;
  readonly roleId: StringOptionField;
  readonly checkinChannelId: StringOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configGuildChannel), [
  "guildId",
  "channelId",
  "name",
  "running",
  "roleId",
  "checkinChannelId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class GuildChannelConfig extends Schema.TaggedClass<GuildChannelConfig>()(
  "GuildChannelConfig",
  GuildChannelConfigFields,
) {}
