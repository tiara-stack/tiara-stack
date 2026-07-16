import type { AnyEffectSqlTable, EffectSqlSchema, EffectSqlSchemaOptions } from "./types.js";

export const schema = <const Tables extends Record<string, AnyEffectSqlTable>>(
  tables: Tables,
  options?: EffectSqlSchemaOptions,
): EffectSqlSchema<Tables> => ({
  _tag: "EffectSqlSchema",
  tables,
  prefix: options?.prefix,
});
