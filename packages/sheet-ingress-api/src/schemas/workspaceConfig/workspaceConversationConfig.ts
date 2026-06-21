import { Schema } from "effect";
import { configWorkspaceConversation } from "sheet-db-schema/models";
import type {
  BooleanOptionField,
  DateTimeOptionField,
  StringField,
  StringOptionField,
} from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const WorkspaceConversationConfigFields = validateTaggedFields<{
  readonly workspaceId: StringField;
  readonly conversationId: StringField;
  readonly name: StringOptionField;
  readonly running: BooleanOptionField;
  readonly roleId: StringOptionField;
  readonly checkinConversationId: StringOptionField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configWorkspaceConversation), [
  "workspaceId",
  "conversationId",
  "name",
  "running",
  "roleId",
  "checkinConversationId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class WorkspaceConversationConfig extends Schema.TaggedClass<WorkspaceConversationConfig>()(
  "WorkspaceConversationConfig",
  WorkspaceConversationConfigFields,
) {}
