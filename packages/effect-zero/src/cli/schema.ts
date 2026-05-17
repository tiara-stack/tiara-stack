import { Schema } from "effect";

export const EffectZeroSchemaExportSchema = Schema.Struct({
  tables: Schema.Record(Schema.String, Schema.Unknown),
  relationships: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  tablePrefix: Schema.optional(Schema.String),
  enableLegacyQueries: Schema.optional(Schema.Boolean),
  enableLegacyMutators: Schema.optional(Schema.Boolean),
});
