import { Schema } from "effect";
import { GeneratedSheetText } from "../client";

export class CheckinGenerateResult extends Schema.TaggedClass<CheckinGenerateResult>()(
  "CheckinGenerateResult",
  {
    hour: Schema.Number,
    runningConversationId: Schema.String,
    checkinConversationId: Schema.String,
    fillCount: Schema.Number,
    roleId: Schema.NullOr(Schema.String),
    initialMessage: Schema.NullOr(GeneratedSheetText),
    monitorCheckinMessage: GeneratedSheetText,
    monitorUserId: Schema.NullOr(Schema.String),
    monitorFailureMessage: Schema.NullOr(GeneratedSheetText),
    fillIds: Schema.Array(Schema.String),
  },
) {}
