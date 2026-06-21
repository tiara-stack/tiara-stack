import { Schema } from "effect";
import { configWorkspace } from "sheet-db-schema/models";
import type {
  BooleanOptionField,
  DateTimeOptionField,
  StringField,
  StringOptionField,
} from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const WorkspaceConfigFields = validateTaggedFields<{
  readonly workspaceId: StringField;
  readonly sheetId: StringOptionField;
  readonly autoCheckin: BooleanOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configWorkspace), [
  "workspaceId",
  "sheetId",
  "autoCheckin",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class WorkspaceConfig extends Schema.TaggedClass<WorkspaceConfig>()(
  "WorkspaceConfig",
  WorkspaceConfigFields,
) {}
