import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export class MessageRoomOrderEntry extends Schema.TaggedClass<MessageRoomOrderEntry>()(
  "MessageRoomOrderEntry",
  {
    clientPlatform: Schema.String,
    clientId: Schema.String,
    messageId: Schema.String,
    rank: Schema.Number,
    position: Schema.Number,
    team: Schema.String,
    tags: Schema.Array(Schema.String),
    effectValue: Schema.Number,
    ...AuditTimestampFields,
  },
) {}
