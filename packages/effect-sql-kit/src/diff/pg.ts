import { isDeepStrictEqual } from "node:util";
import type { ColumnSnapshot, SchemaSnapshot, TableSnapshot } from "../snapshot";
import { quoteIdentifier, quoteQualified } from "../util";
import type { DiffResult, MigrationStatement } from "./types";

const columnType = (column: ColumnSnapshot): string => {
  switch (column.kind) {
    case "varchar":
      return `varchar${typeof column.config?.length === "number" ? `(${column.config.length})` : ""}`;
    case "uuid":
      return "uuid";
    case "integer":
      return "integer";
    case "bigint":
      return "bigint";
    case "real":
      return "real";
    case "doublePrecision":
      return "double precision";
    case "numeric": {
      const precision = column.config?.precision;
      const scale = column.config?.scale;
      return typeof precision === "number"
        ? `numeric(${precision}${typeof scale === "number" ? `, ${scale}` : ""})`
        : "numeric";
    }
    case "boolean":
      return "boolean";
    case "json":
      return "json";
    case "jsonb":
      return "jsonb";
    case "timestamp":
      return column.config?.withTimezone ? "timestamp with time zone" : "timestamp";
    case "date":
      return "date";
    case "text":
    default:
      return "text";
  }
};

const literal = (value: ColumnSnapshot["default"]): string => {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replaceAll("'", "''")}'`;
};

const columnSql = (column: ColumnSnapshot, inlinePrimaryKey = false): string =>
  [
    quoteIdentifier(column.name, "postgresql"),
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

const tableName = (table: TableSnapshot) => quoteQualified("postgresql", table.name, table.schema);

const requireColumn = (table: TableSnapshot, field: string, context: string): ColumnSnapshot => {
  const column = table.columns[field];
  if (!column) {
    throw new Error(`effect-sql-kit: ${context} references missing column ${table.name}.${field}`);
  }
  return column;
};

const tableStatements = (table: TableSnapshot): MigrationStatement[] => {
  const columns = Object.values(table.columns);
  const inlinePrimaryKey = table.primaryKey.length === 1;
  const definitions = columns.map((column) => columnSql(column, inlinePrimaryKey));
  if (table.primaryKey.length > 1) {
    definitions.push(
      `primary key (${table.primaryKey
        .map((field) =>
          quoteIdentifier(requireColumn(table, field, "primary key").name, "postgresql"),
        )
        .join(", ")})`,
    );
  }
  const statements: MigrationStatement[] = [
    {
      sql: `create table ${tableName(table)} (\n  ${definitions.join(",\n  ")}\n)`,
    },
  ];
  statements.push(...indexStatements(table));
  statements.push(...foreignKeyStatements(table));
  return statements;
};

const indexStatements = (table: TableSnapshot): MigrationStatement[] =>
  table.indexes.map((index) => ({
    sql: `create ${index.unique ? "unique " : ""}index ${quoteIdentifier(index.name, "postgresql")} on ${tableName(table)} (${index.fields
      .map((field) =>
        quoteIdentifier(requireColumn(table, field, `index ${index.name}`).name, "postgresql"),
      )
      .join(", ")})`,
  }));

const foreignKeyStatements = (table: TableSnapshot): MigrationStatement[] =>
  Object.values(table.columns).flatMap((column) => {
    if (!column.references) {
      return [];
    }
    const name = `${table.name}_${column.name}_fk`;
    const actions = [
      column.references.onDelete ? `on delete ${column.references.onDelete}` : "",
      column.references.onUpdate ? `on update ${column.references.onUpdate}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return [
      {
        sql: `alter table ${tableName(table)} add constraint ${quoteIdentifier(name, "postgresql")} foreign key (${quoteIdentifier(column.name, "postgresql")}) references ${quoteIdentifier(column.references.table, "postgresql")} (${quoteIdentifier(column.references.column, "postgresql")})${actions ? ` ${actions}` : ""}`,
      },
    ];
  });

const columnChanged = (a: ColumnSnapshot, b: ColumnSnapshot): boolean =>
  !isDeepStrictEqual(normalizeColumnForComparison(a), normalizeColumnForComparison(b));

const normalizeColumnForComparison = (column: ColumnSnapshot) =>
  Object.fromEntries(
    Object.entries({ ...column, fieldName: undefined }).filter(([, value]) => value !== undefined),
  );

export const diffPg = (prev: SchemaSnapshot, next: SchemaSnapshot): DiffResult => {
  const statements: MigrationStatement[] = [];
  for (const [key, table] of Object.entries(next.tables)) {
    const previous = prev.tables[key];
    if (!previous) {
      statements.push(...tableStatements(table));
      continue;
    }
    if (JSON.stringify(previous.primaryKey) !== JSON.stringify(table.primaryKey)) {
      statements.push({
        sql: "",
        unsupported: true,
        reason: `primary key changes on ${table.name} require a manual migration`,
      });
    }
    for (const [field, column] of Object.entries(table.columns)) {
      const prevColumn = previous.columns[field];
      if (!prevColumn) {
        statements.push({
          sql: `alter table ${tableName(table)} add column ${columnSql(column)}`,
        });
        continue;
      }
      if (prevColumn.notNull !== column.notNull) {
        statements.push({
          sql: `alter table ${tableName(table)} alter column ${quoteIdentifier(column.name, "postgresql")} ${column.notNull ? "set not null" : "drop not null"}`,
        });
      }
      if (columnChanged(prevColumn, column)) {
        statements.push({
          sql: "",
          unsupported: true,
          reason: `column change on ${table.name}.${field} may require a manual migration`,
        });
      }
    }
    for (const [field, column] of Object.entries(previous.columns)) {
      if (!table.columns[field]) {
        statements.push({
          sql: `alter table ${tableName(table)} drop column ${quoteIdentifier(column.name, "postgresql")}`,
          destructive: true,
        });
      }
    }
  }
  for (const [key, table] of Object.entries(prev.tables)) {
    if (!next.tables[key]) {
      statements.push({
        sql: `drop table ${tableName(table)}`,
        destructive: true,
      });
    }
  }
  return { statements };
};
