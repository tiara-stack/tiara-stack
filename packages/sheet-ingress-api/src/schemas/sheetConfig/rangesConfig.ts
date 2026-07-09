import { Schema } from "effect";

export class RangesConfig extends Schema.TaggedClass<RangesConfig>()("RangesConfig", {
  userIds: Schema.String,
  userSheetNames: Schema.String,
  userNotes: Schema.OptionFromNullOr(Schema.String),
  monitorIds: Schema.OptionFromNullOr(Schema.String),
  monitorNames: Schema.OptionFromNullOr(Schema.String),
  oshis: Schema.OptionFromNullOr(Schema.String),
}) {}
