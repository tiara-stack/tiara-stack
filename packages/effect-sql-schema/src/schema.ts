import type { EffectSqlSchema, EffectSqlTable } from "./types";

export const schema = <const Tables extends Record<string, EffectSqlTable>>(
  tables: Tables,
): EffectSqlSchema<Tables> => ({
  _tag: "EffectSqlSchema",
  tables,
});
