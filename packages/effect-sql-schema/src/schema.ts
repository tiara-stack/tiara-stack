import type { EffectSqlSchema, EffectSqlSchemaOptions, EffectSqlTable } from "./types";

export const schema = <const Tables extends Record<string, EffectSqlTable>>(
  tables: Tables,
  options?: EffectSqlSchemaOptions,
): EffectSqlSchema<Tables> => ({
  _tag: "EffectSqlSchema",
  tables,
  tablePrefix: options?.tablePrefix,
});
