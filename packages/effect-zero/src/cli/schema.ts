import { Schema } from "effect";

export const EffectZeroSchemaExportSchema = Schema.Struct({
  tables: Schema.Record(Schema.String, Schema.Unknown),
  relationships: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  enableLegacyQueries: Schema.optional(Schema.Boolean),
  enableLegacyMutators: Schema.optional(Schema.Boolean),
});
