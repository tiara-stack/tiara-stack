import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";
import { SheetTextPart } from "../client";

export class MessageCheckin extends Schema.TaggedClass<MessageCheckin>()("MessageCheckin", {
  clientPlatform: Schema.String,
  clientId: Schema.String,
  messageId: Schema.String,
  initialMessage: Schema.Array(SheetTextPart),
  hour: Schema.Number,
  runningConversationId: Schema.String,
  roleId: Schema.OptionFromNullOr(Schema.String),
  workspaceId: Schema.OptionFromNullOr(Schema.String),
  conversationId: Schema.OptionFromNullOr(Schema.String),
  createdByUserId: Schema.OptionFromNullOr(Schema.String),
  ...AuditTimestampFields,
}) {}
