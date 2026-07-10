import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export class MessageRoomOrder extends Schema.TaggedClass<MessageRoomOrder>()("MessageRoomOrder", {
  clientPlatform: Schema.String,
  clientId: Schema.String,
  messageId: Schema.String,
  previousFills: Schema.Array(Schema.String),
  fills: Schema.Array(Schema.String),
  hour: Schema.Number,
  rank: Schema.Number,
  tentative: Schema.Boolean,
  monitor: Schema.OptionFromNullOr(Schema.String),
  workspaceId: Schema.OptionFromNullOr(Schema.String),
  conversationId: Schema.OptionFromNullOr(Schema.String),
  createdByUserId: Schema.OptionFromNullOr(Schema.String),
  sendClaimId: Schema.OptionFromNullOr(Schema.String),
  sendClaimedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  sentMessageId: Schema.OptionFromNullOr(Schema.String),
  sentConversationId: Schema.OptionFromNullOr(Schema.String),
  sentAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  tentativeUpdateClaimId: Schema.OptionFromNullOr(Schema.String),
  tentativeUpdateClaimedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  tentativePinClaimId: Schema.OptionFromNullOr(Schema.String),
  tentativePinClaimedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  tentativePinnedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  ...AuditTimestampFields,
}) {}
