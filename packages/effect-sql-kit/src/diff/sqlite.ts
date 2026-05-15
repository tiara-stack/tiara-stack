import type { ColumnSnapshot, SchemaSnapshot, TableSnapshot } from "../snapshot";
import { quoteIdentifier } from "../util";
import type { DiffResult, MigrationStatement } from "./types";

const columnType = (column: ColumnSnapshot): string => {
  switch (column.kind) {
    case "integer":
      return "integer";
    case "real":
      return "real";
    case "blob":
      return "blob";
    case "numeric":
      return "numeric";
    case "text":
    default:
      return "text";
  }
};

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

const tableStatements = (table: TableSnapshot): MigrationStatement[] => {
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

export const diffSqlite = (prev: SchemaSnapshot, next: SchemaSnapshot): DiffResult => {
  const statements: MigrationStatement[] = [];
  for (const [key, table] of Object.entries(next.tables)) {
    const previous = prev.tables[key];
    if (!previous) {
      statements.push(...tableStatements(table));
      continue;
    }
    if (
      JSON.stringify(primaryKeySqlNames(previous)) !== JSON.stringify(primaryKeySqlNames(table))
    ) {
      statements.push({
        sql: "",
        unsupported: true,
        reason: `primary key changes on ${table.name} require a manual migration`,
      });
    }
    const previousColumnsBySqlName = new Map(
      Object.values(previous.columns).map((column) => [column.name, column]),
    );
    for (const [field, column] of Object.entries(table.columns)) {
      const prevColumn = previous.columns[field] ?? previousColumnsBySqlName.get(column.name);
      if (!prevColumn) {
        if (column.notNull && column.default === undefined && column.defaultSql === undefined) {
          statements.push({
            sql: "",
            unsupported: true,
            reason: `adding required SQLite column ${table.name}.${field} requires a default or manual migration`,
          });
        } else {
          statements.push({
            sql: `alter table ${quoteIdentifier(table.name, "sqlite")} add column ${columnSql(column)}`,
          });
        }
        continue;
      }
      if (
        JSON.stringify(comparableColumn(prevColumn)) !== JSON.stringify(comparableColumn(column))
      ) {
        statements.push({
          sql: "",
          unsupported: true,
          reason: `SQLite column change on ${table.name}.${field} requires a table rebuild`,
        });
      }
    }
    const nextColumnSqlNames = new Set(Object.values(table.columns).map((column) => column.name));
    for (const previousColumn of Object.values(previous.columns)) {
      if (!nextColumnSqlNames.has(previousColumn.name)) {
        statements.push({
          sql: "",
          destructive: true,
          unsupported: true,
          reason: `dropping SQLite column ${table.name}.${previousColumn.name} requires a table rebuild`,
        });
      }
    }
    const previousIndexes = new Map(previous.indexes.map((index) => [index.name, index]));
    const nextIndexes = new Map(table.indexes.map((index) => [index.name, index]));
    for (const index of table.indexes) {
      const previousIndex = previousIndexes.get(index.name);
      if (!previousIndex) {
        statements.push(createIndexStatement(table, index));
        continue;
      }
      const previousFields = indexSqlFields(previous, previousIndex.fields);
      const nextFields = indexSqlFields(table, index.fields);
      if (
        previousIndex.unique !== index.unique ||
        JSON.stringify(previousFields) !== JSON.stringify(nextFields)
      ) {
        statements.push({
          sql: `drop index ${quoteIdentifier(previousIndex.name, "sqlite")}`,
          destructive: true,
        });
        statements.push(createIndexStatement(table, index));
      }
    }
    for (const index of previous.indexes) {
      if (!nextIndexes.has(index.name)) {
        statements.push({
          sql: `drop index ${quoteIdentifier(index.name, "sqlite")}`,
          destructive: true,
        });
      }
    }
  }
  for (const [key, table] of Object.entries(prev.tables)) {
    if (!next.tables[key]) {
      statements.push({
        sql: `drop table ${quoteIdentifier(table.name, "sqlite")}`,
        destructive: true,
      });
    }
  }
  return { statements };
};
