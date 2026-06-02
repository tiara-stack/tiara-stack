import { Schema } from "effect";
import { configGuild } from "sheet-db-schema/models";
import type {
  BooleanOptionField,
  DateTimeOptionField,
  StringField,
  StringOptionField,
} from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const GuildConfigFields = validateTaggedFields<{
  readonly guildId: StringField;
  readonly sheetId: StringOptionField;
  readonly autoCheckin: BooleanOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configGuild), [
  "guildId",
  "sheetId",
  "autoCheckin",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class GuildConfig extends Schema.TaggedClass<GuildConfig>()(
  "GuildConfig",
  GuildConfigFields,
) {}
