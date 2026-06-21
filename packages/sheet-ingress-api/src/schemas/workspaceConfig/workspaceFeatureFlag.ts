import { Schema } from "effect";
import { configWorkspaceFeatureFlag } from "sheet-db-schema/models";
import type { DateTimeOptionField, StringField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

export const FeatureFlagName = Schema.String.check(
  Schema.makeFilter<string>((value) => value.trim().length > 0, {
    expected: "a non-empty feature flag name",
  }),
);

const WorkspaceFeatureFlagFields = validateTaggedFields<{
  readonly workspaceId: StringField;
  readonly flagName: StringField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configWorkspaceFeatureFlag), [
  "workspaceId",
  "flagName",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class WorkspaceFeatureFlag extends Schema.TaggedClass<WorkspaceFeatureFlag>()(
  "WorkspaceFeatureFlag",
  WorkspaceFeatureFlagFields,
) {}
