import type { EffectSqlTable } from "effect-sql-schema";
import type { EffectZeroSchema, EffectZeroTable, RelationshipConfig } from "./types";
import { fromSqlTable, isEffectSqlTable, type SchemaTable } from "./sql-table";

type NormalizedTables<Tables extends Record<string, SchemaTable>> = {
  readonly [K in keyof Tables]: Tables[K] extends EffectSqlTable<any, infer Model>
    ? EffectZeroTable<Model>
    : Tables[K] extends EffectZeroTable
      ? Tables[K]
      : never;
};

const prefixedIdentifierName = (prefix: string | undefined, tableName: string): string =>
  prefix ? `${prefix.replace(/_+$/, "")}_${tableName}` : tableName;

const normalizeTables = <const Tables extends Record<string, SchemaTable>>(
  tables: Tables,
  prefix?: string,
): NormalizedTables<Tables> => {
  const normalized: Record<string, EffectZeroTable> = {};
  for (const [key, table] of Object.entries(tables)) {
    normalized[key] = isEffectSqlTable(table)
      ? fromSqlTable(table, {
          name: key,
          serverName: prefixedIdentifierName(prefix, table.sqlName ?? table.name),
        })
      : prefix
        ? {
            ...table,
            serverName: prefixedIdentifierName(prefix, table.serverName ?? table.name),
          }
        : table;
  }
  return normalized as never;
};

export const schema = <const Tables extends Record<string, SchemaTable>>(
  tables: Tables,
  options?: {
    readonly relationships?: RelationshipConfig;
    readonly prefix?: string;
    readonly enableLegacyQueries?: boolean;
    readonly enableLegacyMutators?: boolean;
  },
): EffectZeroSchema<NormalizedTables<Tables>> => ({
  tables: normalizeTables(tables, options?.prefix),
  relationships: options?.relationships ?? {},
  prefix: options?.prefix,
  enableLegacyQueries: options?.enableLegacyQueries,
  enableLegacyMutators: options?.enableLegacyMutators,
});
