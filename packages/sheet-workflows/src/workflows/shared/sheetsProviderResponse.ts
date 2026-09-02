import { Schema } from "effect";

/** The metadata fields shared by the read-only and configuration-sheet adapters. */
export const sheetsProviderTabProperties = Schema.Struct({
  sheetId: Schema.optional(Schema.NullOr(Schema.Number)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  hidden: Schema.optional(Schema.NullOr(Schema.Boolean)),
  sheetType: Schema.optional(Schema.NullOr(Schema.String)),
  gridProperties: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        rowCount: Schema.optional(Schema.NullOr(Schema.Number)),
        columnCount: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});

export const sheetsProviderMetadataResponse = Schema.Struct({
  spreadsheetId: Schema.optional(Schema.NullOr(Schema.String)),
  sheets: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          properties: Schema.optional(Schema.NullOr(sheetsProviderTabProperties)),
        }),
      ),
    ),
  ),
});
