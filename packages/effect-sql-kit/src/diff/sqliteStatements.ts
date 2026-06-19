import type { ColumnSnapshot, SchemaSnapshot, TableSnapshot } from "../snapshot";
import { quoteIdentifier } from "../util";
import type { MigrationStatement } from "./types";

const columnTypes: Record<string, string> = {
  integer: "integer",
  real: "real",
  blob: "blob",
  numeric: "numeric",
  text: "text",
};

const columnType = (column: ColumnSnapshot): string => columnTypes[column.kind] ?? "text";

const literal = (value: ColumnSnapshot["default"]): string => {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
};

const columnSql = (column: ColumnSnapshot, inlinePrimaryKey = false): string =>
  [
    quoteIdentifier(column.name, "sqlite"),
    columnType(column),
    column.notNull ? "not null" : "",
    inlinePrimaryKey && column.primaryKey ? "primary key" : "",
    column.defaultSql
      ? `default ${column.defaultSql}`
      : column.default !== undefined
        ? `default ${literal(column.default)}`
        : "",
  ]
    .filter(Boolean)
    .join(" ");

const requireColumn = (table: TableSnapshot, field: string, context: string): ColumnSnapshot => {
  const column = table.columns[field];
  if (!column) {
    throw new Error(`effect-sql-kit: ${context} references missing column ${table.name}.${field}`);
  }
  return column;
};

const sqlNameForField = (table: TableSnapshot, field: string): string =>
  table.columns[field]?.name ?? field;

const primaryKeySqlNames = (table: TableSnapshot): readonly string[] =>
  table.primaryKey.map((field) => sqlNameForField(table, field));

const indexSqlFields = (table: TableSnapshot, fields: readonly string[]): readonly string[] =>
  fields.map((field) => sqlNameForField(table, field));

const comparableColumn = (column: ColumnSnapshot) => ({
  name: column.name,
  kind: column.kind,
  notNull: column.notNull,
  primaryKey: column.primaryKey,
  unique: column.unique,
  default: column.default,
  defaultSql: column.defaultSql,
});

const createIndexStatement = (table: TableSnapshot, index: TableSnapshot["indexes"][number]) => ({
  sql: `create ${index.unique ? "unique " : ""}index ${quoteIdentifier(index.name, "sqlite")} on ${quoteIdentifier(table.name, "sqlite")} (${index.fields
    .map((field) =>
      quoteIdentifier(requireColumn(table, field, `index ${index.name}`).name, "sqlite"),
    )
    .join(", ")})`,
});

export const tableStatements = (table: TableSnapshot): MigrationStatement[] => {
  const columns = Object.values(table.columns);
  const inlinePrimaryKey = table.primaryKey.length === 1;
  const definitions = columns.map((column) => columnSql(column, inlinePrimaryKey));
  if (table.primaryKey.length > 1) {
    definitions.push(
      `primary key (${table.primaryKey
        .map((field) => quoteIdentifier(requireColumn(table, field, "primary key").name, "sqlite"))
        .join(", ")})`,
    );
  }
  const statements: MigrationStatement[] = [
    {
      sql: `create table ${quoteIdentifier(table.name, "sqlite")} (\n  ${definitions.join(",\n  ")}\n)`,
    },
  ];
  statements.push(...table.indexes.map((index) => createIndexStatement(table, index)));
  return statements;
};

export const tablesBySqlName = (snapshot: SchemaSnapshot): Map<string, TableSnapshot> =>
  new Map(Object.values(snapshot.tables).map((table) => [table.name, table]));

const columnsBySqlName = (table: TableSnapshot): Map<string, ColumnSnapshot> =>
  new Map(Object.values(table.columns).map((column) => [column.name, column]));

const hasPrimaryKeyChange = (previous: TableSnapshot, table: TableSnapshot): boolean =>
  JSON.stringify(primaryKeySqlNames(previous)) !== JSON.stringify(primaryKeySqlNames(table));

const primaryKeyChangeStatement = (table: TableSnapshot): MigrationStatement => ({
  sql: "",
  unsupported: true,
  reason: `primary key changes on ${table.name} require a manual migration`,
});

const addColumnStatement = (
  table: TableSnapshot,
  field: string,
  column: ColumnSnapshot,
): MigrationStatement =>
  column.notNull && column.default === undefined && column.defaultSql === undefined
    ? {
        sql: "",
        unsupported: true,
        reason: `adding required SQLite column ${table.name}.${field} requires a default or manual migration`,
      }
    : {
        sql: `alter table ${quoteIdentifier(table.name, "sqlite")} add column ${columnSql(column)}`,
      };

const columnChangeStatement = (table: TableSnapshot, field: string): MigrationStatement => ({
  sql: "",
  unsupported: true,
  reason: `SQLite column change on ${table.name}.${field} requires a table rebuild`,
});

const dropColumnStatement = (table: TableSnapshot, column: ColumnSnapshot): MigrationStatement => ({
  sql: "",
  destructive: true,
  unsupported: true,
  reason: `dropping SQLite column ${table.name}.${column.name} requires a table rebuild`,
});

const diffColumns = (previous: TableSnapshot, table: TableSnapshot): MigrationStatement[] => {
  const statements: MigrationStatement[] = [];
  const previousColumnsBySqlName = columnsBySqlName(previous);
  for (const [field, column] of Object.entries(table.columns)) {
    const prevColumn = previous.columns[field] ?? previousColumnsBySqlName.get(column.name);
    if (!prevColumn) {
      statements.push(addColumnStatement(table, field, column));
      continue;
    }
    if (JSON.stringify(comparableColumn(prevColumn)) !== JSON.stringify(comparableColumn(column))) {
      statements.push(columnChangeStatement(table, field));
    }
  }

  const nextColumnSqlNames = new Set(Object.values(table.columns).map((column) => column.name));
  for (const previousColumn of Object.values(previous.columns)) {
    if (!nextColumnSqlNames.has(previousColumn.name)) {
      statements.push(dropColumnStatement(table, previousColumn));
    }
  }
  return statements;
};

const indexesByName = (table: TableSnapshot) =>
  new Map(table.indexes.map((index) => [index.name, index]));

const indexChanged = (
  previous: TableSnapshot,
  table: TableSnapshot,
  previousIndex: TableSnapshot["indexes"][number],
  index: TableSnapshot["indexes"][number],
): boolean => {
  const previousFields = indexSqlFields(previous, previousIndex.fields);
  const nextFields = indexSqlFields(table, index.fields);
  return (
    previousIndex.unique !== index.unique ||
    JSON.stringify(previousFields) !== JSON.stringify(nextFields)
  );
};

const recreateIndexStatements = (
  table: TableSnapshot,
  previousIndex: TableSnapshot["indexes"][number],
  index: TableSnapshot["indexes"][number],
): MigrationStatement[] => [
  {
    sql: `drop index ${quoteIdentifier(previousIndex.name, "sqlite")}`,
    destructive: true,
  },
  createIndexStatement(table, index),
];

const dropIndexStatement = (index: TableSnapshot["indexes"][number]): MigrationStatement => ({
  sql: `drop index ${quoteIdentifier(index.name, "sqlite")}`,
  destructive: true,
});

const diffIndexes = (previous: TableSnapshot, table: TableSnapshot): MigrationStatement[] => {
  const statements: MigrationStatement[] = [];
  const previousIndexes = indexesByName(previous);
  const nextIndexes = indexesByName(table);
  for (const index of table.indexes) {
    const previousIndex = previousIndexes.get(index.name);
    if (!previousIndex) {
      statements.push(createIndexStatement(table, index));
    } else if (indexChanged(previous, table, previousIndex, index)) {
      statements.push(...recreateIndexStatements(table, previousIndex, index));
    }
  }
  for (const index of previous.indexes) {
    if (!nextIndexes.has(index.name)) {
      statements.push(dropIndexStatement(index));
    }
  }
  return statements;
};

export const diffExistingTable = (
  previous: TableSnapshot,
  table: TableSnapshot,
): MigrationStatement[] => [
  ...(hasPrimaryKeyChange(previous, table) ? [primaryKeyChangeStatement(table)] : []),
  ...diffColumns(previous, table),
  ...diffIndexes(previous, table),
];

export const dropRemovedTables = (
  prev: SchemaSnapshot,
  next: SchemaSnapshot,
): MigrationStatement[] => {
  const statements: MigrationStatement[] = [];
  const nextTableSqlNames = new Set(Object.values(next.tables).map((table) => table.name));
  for (const [key, table] of Object.entries(prev.tables)) {
    if (!next.tables[key] && !nextTableSqlNames.has(table.name)) {
      statements.push({
        sql: `drop table ${quoteIdentifier(table.name, "sqlite")}`,
        destructive: true,
      });
    }
  }
  return statements;
};
