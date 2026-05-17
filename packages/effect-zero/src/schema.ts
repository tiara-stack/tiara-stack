import type { EffectSqlTable } from "effect-sql-schema";
import type {
  ColumnOptions,
  EffectZeroSchema,
  EffectZeroTable,
  RelationshipConfig,
  ZeroValueType,
} from "./types";

type SchemaTable = EffectZeroTable | EffectSqlTable;

type NormalizedTables<Tables extends Record<string, SchemaTable>> = {
  readonly [K in keyof Tables]: Tables[K] extends EffectSqlTable
    ? EffectZeroTable<Tables[K]["model"]>
    : Tables[K] extends EffectZeroTable
      ? Tables[K]
      : never;
};

const zeroType = (kind: string): ZeroValueType => {
  switch (kind) {
    case "boolean":
      return "boolean";
    case "integer":
    case "bigint":
    case "real":
    case "doublePrecision":
    case "numeric":
    case "timestamp":
    case "date":
      return "number";
    case "json":
    case "jsonb":
    case "blob":
    case "array":
      return "json";
    case "text":
    case "varchar":
    case "uuid":
    default:
      return "string";
  }
};

const prefixedTableName = (prefix: string | undefined, tableName: string): string =>
  prefix ? `${prefix.replace(/_+$/, "")}_${tableName}` : tableName;

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
    const hasServerDefault =
      column.data.defaultExpression !== undefined || column.data.defaultValue !== undefined;
    const columnName = columnOptions.name ?? column.data.name ?? fieldName;
    columns[fieldName] = {
      name: columnName,
      serverName: columnOptions.serverName ?? (columnName === fieldName ? undefined : columnName),
      type: columnOptions.type ?? zeroType(column.data.kind),
      optional:
        columnOptions.optional ??
        (column.data.primaryKey ? false : hasServerDefault ? true : !column.data.notNull),
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
  tablePrefix?: string,
): NormalizedTables<Tables> => {
  const normalized: Record<string, EffectZeroTable> = {};
  for (const [key, table] of Object.entries(tables)) {
    normalized[key] = isEffectSqlTable(table)
      ? fromSqlTable(table, {
          name: key,
          serverName: prefixedTableName(tablePrefix, table.sqlName ?? table.name),
        })
      : tablePrefix
        ? {
            ...table,
            serverName: prefixedTableName(tablePrefix, table.serverName ?? table.name),
          }
        : table;
  }
  return normalized as never;
};

export const schema = <const Tables extends Record<string, SchemaTable>>(
  tables: Tables,
  options?: {
    readonly relationships?: RelationshipConfig;
    readonly tablePrefix?: string;
    readonly enableLegacyQueries?: boolean;
    readonly enableLegacyMutators?: boolean;
  },
): EffectZeroSchema<NormalizedTables<Tables>> => ({
  tables: normalizeTables(tables, options?.tablePrefix),
  relationships: options?.relationships ?? {},
  tablePrefix: options?.tablePrefix,
  enableLegacyQueries: options?.enableLegacyQueries,
  enableLegacyMutators: options?.enableLegacyMutators,
});
