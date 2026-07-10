import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export class MessageSlot extends Schema.TaggedClass<MessageSlot>()("MessageSlot", {
  clientPlatform: Schema.String,
  clientId: Schema.String,
  messageId: Schema.String,
  day: Schema.Number,
  workspaceId: Schema.OptionFromNullOr(Schema.String),
  conversationId: Schema.OptionFromNullOr(Schema.String),
  createdByUserId: Schema.OptionFromNullOr(Schema.String),
  ...AuditTimestampFields,
}) {}
