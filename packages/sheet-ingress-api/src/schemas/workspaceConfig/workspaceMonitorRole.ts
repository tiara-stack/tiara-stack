import { Schema } from "effect";
import { configWorkspaceMonitorRole } from "sheet-db-schema/models";
import type { DateTimeOptionField, StringField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const WorkspaceMonitorRoleFields = validateTaggedFields<{
  readonly workspaceId: StringField;
  readonly roleId: StringField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configWorkspaceMonitorRole), [
  "workspaceId",
  "roleId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class WorkspaceMonitorRole extends Schema.TaggedClass<WorkspaceMonitorRole>()(
  "WorkspaceMonitorRole",
  WorkspaceMonitorRoleFields,
) {}
