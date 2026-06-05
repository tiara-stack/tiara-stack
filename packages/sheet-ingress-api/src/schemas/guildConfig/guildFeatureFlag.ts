import { Schema } from "effect";
import { configGuildFeatureFlag } from "sheet-db-schema/models";
import type { DateTimeOptionField, StringField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

export const FeatureFlagName = Schema.String.check(
  Schema.makeFilter<string>((value) => value.trim().length > 0, {
    expected: "a non-empty feature flag name",
  }),
);

const GuildFeatureFlagFields = validateTaggedFields<{
  readonly guildId: StringField;
  readonly flagName: StringField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configGuildFeatureFlag), [
  "guildId",
  "flagName",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class GuildFeatureFlag extends Schema.TaggedClass<GuildFeatureFlag>()(
  "GuildFeatureFlag",
  GuildFeatureFlagFields,
) {}
