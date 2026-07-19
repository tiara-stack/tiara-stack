import type { AnyEffectSqlTable, EffectSqlSchema, EffectSqlTable } from "effect-sql-schema";
import type { EffectZeroSchema, EffectZeroTable, RelationshipConfig } from "./types";
import { fromSqlTable, isEffectSqlTable, type SchemaTable } from "./sql-table";

type NormalizedTables<Tables extends Record<string, SchemaTable>> = {
  readonly [K in keyof Tables]: Tables[K] extends EffectSqlTable<any, infer Model, any>
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
  // Object.entries necessarily widens the source keys while the loop preserves
  // each table's model at runtime. Restore that mapped key/model relationship at
  // this single construction boundary instead of erasing the result with never.
  return normalized as NormalizedTables<Tables>;
};

export const schema = <const Tables extends Record<string, SchemaTable>>(
  tables: Tables,
  options?: {
    readonly relationships?: RelationshipConfig | undefined;
    readonly prefix?: string | undefined;
    readonly enableLegacyQueries?: boolean | undefined;
    readonly enableLegacyMutators?: boolean | undefined;
  },
): EffectZeroSchema<NormalizedTables<Tables>> => ({
  tables: normalizeTables(tables, options?.prefix),
  relationships: options?.relationships ?? {},
  prefix: options?.prefix,
  enableLegacyQueries: options?.enableLegacyQueries,
  enableLegacyMutators: options?.enableLegacyMutators,
});

export const fromSqlSchema = <const Tables extends Record<string, AnyEffectSqlTable>>(
  sqlSchema: EffectSqlSchema<Tables>,
): EffectZeroSchema<NormalizedTables<Tables>> =>
  schema(sqlSchema.tables, {
    prefix: sqlSchema.prefix,
    relationships: sqlSchema.relationships,
  });
