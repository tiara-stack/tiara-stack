import type { EffectSqlColumn, EffectSqlSchema, EffectSqlTable } from "./types";

export const snapshotVersion = 1;

export type ColumnSnapshot = {
  readonly fieldName: string;
  readonly name: string;
  readonly kind: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique?: string | boolean;
  readonly default?: string | number | boolean | null;
  readonly defaultSql?: string;
  readonly references?: {
    readonly table: string;
    readonly column: string;
    readonly onDelete?: string;
    readonly onUpdate?: string;
  };
  readonly config?: Record<string, unknown>;
};

export type IndexSnapshot = {
  readonly name: string;
  readonly unique: boolean;
  readonly fields: readonly string[];
};

export type TableSnapshot = {
  readonly name: string;
  readonly schema?: string;
  readonly columns: Record<string, ColumnSnapshot>;
  readonly primaryKey: readonly string[];
  readonly indexes: readonly IndexSnapshot[];
};

export type SchemaSnapshot = {
  readonly version: typeof snapshotVersion;
  readonly dialect: "postgresql" | "sqlite";
  readonly tables: Record<string, TableSnapshot>;
};

export type StoredSnapshot = {
  readonly version: typeof snapshotVersion;
  readonly dialect: "postgresql" | "sqlite";
  readonly id: string;
  readonly prevId: string;
  readonly schema: SchemaSnapshot;
  readonly drizzle?: unknown;
};

const columnName = (column: EffectSqlColumn): string =>
  column.data.name ?? column.data.fieldName ?? "";

const prefixedTableName = (prefix: string | undefined, tableName: string): string =>
  prefix ? `${prefix.replace(/_+$/, "")}_${tableName}` : tableName;

const referenceSnapshot = (
  column: EffectSqlColumn,
  tableNameMap: ReadonlyMap<EffectSqlColumn, string>,
): ColumnSnapshot["references"] => {
  const reference = column.data.references;
  if (!reference) {
    return undefined;
  }
  const target = reference.resolver();
  const table = tableNameMap.get(target);
  const targetName = target.data.name ?? target.data.fieldName;
  if (!table || !targetName) {
    return undefined;
  }
  return {
    table,
    column: targetName,
    onDelete: reference.options?.onDelete,
    onUpdate: reference.options?.onUpdate,
  };
};

export const snapshotTable = (
  table: EffectSqlTable,
  allTableNames?: ReadonlyMap<EffectSqlColumn, string>,
  options?: { readonly tablePrefix?: string },
): TableSnapshot => {
  const tableName = prefixedTableName(options?.tablePrefix, table.sqlName ?? table.name);
  const tableNameMap = new Map(allTableNames);
  for (const column of Object.values(table.columns)) {
    tableNameMap.set(column, tableName);
  }
  const columns: Record<string, ColumnSnapshot> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    columns[fieldName] = {
      fieldName,
      name: columnName(column),
      kind: column.data.kind,
      notNull: Boolean(column.data.notNull),
      primaryKey: Boolean(column.data.primaryKey),
      unique: column.data.unique,
      default: column.data.defaultValue,
      defaultSql: column.data.defaultExpression,
      references: referenceSnapshot(column, tableNameMap),
      config: column.data.config,
    };
  }
  return {
    name: tableName,
    schema: table.schema,
    columns,
    primaryKey: table.primaryKey,
    indexes: table.indexes.map((index) => ({
      name: index.name,
      unique: index.unique,
      fields: index.fields,
    })),
  };
};

export const snapshotSchema = (config: EffectSqlSchema): SchemaSnapshot => {
  const entries = Object.entries(config.tables);
  const [first] = entries;
  if (!first) {
    throw new Error("effect-sql-schema: schema must contain at least one table");
  }
  const dialect = first[1].dialect;
  const tableNameMap = new Map<EffectSqlColumn, string>();
  for (const [, table] of entries) {
    const tableName = prefixedTableName(config.tablePrefix, table.sqlName ?? table.name);
    for (const column of Object.values(table.columns)) {
      tableNameMap.set(column, tableName);
    }
  }
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, table] of entries) {
    if (table.dialect !== dialect) {
      throw new Error("effect-sql-schema: schema cannot mix Postgres and SQLite tables");
    }
    tables[name] = snapshotTable(table, tableNameMap, {
      tablePrefix: config.tablePrefix,
    });
  }
  return {
    version: snapshotVersion,
    dialect,
    tables,
  };
};

export const emptySnapshot = (dialect: "postgresql" | "sqlite"): SchemaSnapshot => ({
  version: snapshotVersion,
  dialect,
  tables: {},
});
