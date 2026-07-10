import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export class MessageCheckinMember extends Schema.TaggedClass<MessageCheckinMember>()(
  "MessageCheckinMember",
  {
    clientPlatform: Schema.String,
    clientId: Schema.String,
    messageId: Schema.String,
    memberId: Schema.String,
    checkinAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
    checkinClaimId: Schema.OptionFromNullOr(Schema.String),
    ...AuditTimestampFields,
  },
) {}
