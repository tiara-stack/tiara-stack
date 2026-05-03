import { Schema } from "effect";

export class MessageRoomOrder extends Schema.TaggedClass<MessageRoomOrder>()("MessageRoomOrder", {
  messageId: Schema.String,
  hour: Schema.Number,
  previousFills: Schema.Array(Schema.String),
  fills: Schema.Array(Schema.String),
  rank: Schema.Number,
  monitor: Schema.OptionFromNullOr(Schema.String),
  guildId: Schema.OptionFromNullOr(Schema.String),
  messageChannelId: Schema.OptionFromNullOr(Schema.String),
  createdByUserId: Schema.OptionFromNullOr(Schema.String),
  sendClaimId: Schema.OptionFromNullOr(Schema.String),
  sendClaimedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  sentMessageId: Schema.OptionFromNullOr(Schema.String),
  sentMessageChannelId: Schema.OptionFromNullOr(Schema.String),
  sentAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  tentativePinClaimId: Schema.OptionFromNullOr(Schema.String),
  tentativePinClaimedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  tentativePinnedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  createdAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  updatedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  deletedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
}) {}
