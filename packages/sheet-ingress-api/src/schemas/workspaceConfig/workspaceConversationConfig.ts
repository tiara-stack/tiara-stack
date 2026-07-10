import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export class WorkspaceConversationConfig extends Schema.TaggedClass<WorkspaceConversationConfig>()(
  "WorkspaceConversationConfig",
  {
    workspaceId: Schema.String,
    conversationId: Schema.String,
    name: Schema.OptionFromNullOr(Schema.String),
    running: Schema.OptionFromNullOr(Schema.Boolean),
    roleId: Schema.OptionFromNullOr(Schema.String),
    checkinConversationId: Schema.OptionFromNullOr(Schema.String),
    ...AuditTimestampFields,
  },
) {}
