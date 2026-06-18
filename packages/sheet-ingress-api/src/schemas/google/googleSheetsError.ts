import { Schema } from "effect";

export class GoogleSheetsError extends Schema.TaggedErrorClass<GoogleSheetsError>()(
  "GoogleSheetsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.String),
  },
) {}
