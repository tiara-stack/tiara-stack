import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export class WorkspaceConfig extends Schema.TaggedClass<WorkspaceConfig>()("WorkspaceConfig", {
  workspaceId: Schema.String,
  sheetId: Schema.OptionFromNullOr(Schema.String),
  autoCheckin: Schema.OptionFromNullOr(Schema.Boolean),
  monitorConversationId: Schema.OptionFromNullOr(Schema.String),
  ...AuditTimestampFields,
}) {}
