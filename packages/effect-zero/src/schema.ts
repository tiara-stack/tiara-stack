import type { EffectSqlTable } from "effect-sql-schema";
import type {
  ColumnOptions,
  EffectZeroSchema,
  EffectZeroTable,
  RelationshipConfig,
  ZeroValueType,
} from "./types";

type SchemaTable = EffectZeroTable | EffectSqlTable;

const zeroType = (kind: string): ZeroValueType => {
  switch (kind) {
    case "boolean":
      return "boolean";
    case "integer":
    case "bigint":
    case "real":
    case "doublePrecision":
    case "numeric":
      return "number";
    case "json":
    case "jsonb":
    case "blob":
    case "array":
      return "json";
    case "text":
    case "varchar":
    case "uuid":
    case "timestamp":
    case "date":
    default:
      return "string";
  }
};

export const isEffectSqlTable = (value: unknown): value is EffectSqlTable =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  (value as { readonly _tag?: unknown })._tag === "EffectSqlTable";

export const fromSqlTable = <const Table extends EffectSqlTable>(
  table: Table,
  options?: {
    readonly name?: string;
    readonly serverName?: string;
    readonly columns?: Partial<Record<keyof Table["columns"] & string, boolean | ColumnOptions>>;
  },
): EffectZeroTable<Table["model"]> => {
  const tableName = table.sqlName ?? table.name;
  const columns: Record<string, boolean | ColumnOptions> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    const override = options?.columns?.[fieldName];
    if (override === false) {
      columns[fieldName] = false;
      continue;
    }
    const columnOptions = typeof override === "object" && override !== null ? override : {};
    columns[fieldName] = {
      name: columnOptions.name ?? column.data.name ?? fieldName,
      serverName: columnOptions.serverName ?? column.data.name,
      type: columnOptions.type ?? zeroType(column.data.kind),
      optional: columnOptions.optional ?? !column.data.notNull,
    };
  }

  return {
    model: table.model,
    name: options?.name ?? tableName,
    serverName: options?.serverName ?? tableName,
    key: table.primaryKey,
    columns,
  };
};

const normalizeTables = <const Tables extends Record<string, SchemaTable>>(
  tables: Tables,
): {
  readonly [K in keyof Tables]: Tables[K] extends EffectSqlTable
    ? EffectZeroTable<Tables[K]["model"]>
    : Tables[K];
} => {
  const normalized: Record<string, EffectZeroTable> = {};
  for (const [key, table] of Object.entries(tables)) {
    normalized[key] = isEffectSqlTable(table) ? fromSqlTable(table) : table;
  }
  return normalized as never;
};

export const schema = <const Tables extends Record<string, SchemaTable>>(
  tables: Tables,
  options?: {
    readonly relationships?: RelationshipConfig;
    readonly enableLegacyQueries?: boolean;
    readonly enableLegacyMutators?: boolean;
  },
): EffectZeroSchema<Record<string, EffectZeroTable>> => ({
  tables: normalizeTables(tables) as Record<string, EffectZeroTable>,
  relationships: options?.relationships ?? {},
  enableLegacyQueries: options?.enableLegacyQueries,
  enableLegacyMutators: options?.enableLegacyMutators,
});
