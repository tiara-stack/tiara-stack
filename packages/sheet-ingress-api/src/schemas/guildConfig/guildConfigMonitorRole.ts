import { Schema } from "effect";
import { configGuildManagerRole } from "sheet-db-schema/models";
import type { DateTimeOptionField, StringField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const GuildConfigMonitorRoleFields = validateTaggedFields<{
  readonly guildId: StringField;
  readonly roleId: StringField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configGuildManagerRole), [
  "guildId",
  "roleId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class GuildConfigMonitorRole extends Schema.TaggedClass<GuildConfigMonitorRole>()(
  "GuildConfigMonitorRole",
  GuildConfigMonitorRoleFields,
) {}
