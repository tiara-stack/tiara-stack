import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export const FeatureFlagName = Schema.String.check(
  Schema.makeFilter<string>((value) => value.trim().length > 0, {
    expected: "a non-empty feature flag name",
  }),
);

export class WorkspaceFeatureFlag extends Schema.TaggedClass<WorkspaceFeatureFlag>()(
  "WorkspaceFeatureFlag",
  {
    workspaceId: Schema.String,
    flagName: Schema.String,
    ...AuditTimestampFields,
  },
) {}
