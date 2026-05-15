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

const indexName = (table: TableSnapshot, name: string) =>
  quoteQualified("postgresql", name, table.schema);

const requireColumn = (table: TableSnapshot, field: string, context: string): ColumnSnapshot => {
  const column = table.columns[field];
  if (!column) {
    throw new Error(`effect-sql-kit: ${context} references missing column ${table.name}.${field}`);
  }
  return column;
};

const sqlNameForField = (
  table: TableSnapshot,
  field: string,
  options?: { readonly allowMissing?: boolean },
): string => {
  const column = table.columns[field];
  if (column) {
    return column.name;
  }
  if (options?.allowMissing) {
    return field;
  }
  throw new Error(`effect-sql-kit: missing column ${table.name}.${field}`);
};

const primaryKeySqlNames = (table: TableSnapshot): readonly string[] =>
  table.primaryKey.map((field) => sqlNameForField(table, field, { allowMissing: true }));

const indexSqlFields = (table: TableSnapshot, fields: readonly string[]): readonly string[] =>
  fields.map((field) => sqlNameForField(table, field, { allowMissing: true }));

const createIndexStatement = (table: TableSnapshot, index: TableSnapshot["indexes"][number]) => ({
  sql: `create ${index.unique ? "unique " : ""}index ${quoteIdentifier(index.name, "postgresql")} on ${tableName(table)} (${index.fields
    .map((field) =>
      quoteIdentifier(requireColumn(table, field, `index ${index.name}`).name, "postgresql"),
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
  table.indexes.map((index) => createIndexStatement(table, index));

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
    const renamedColumnNames = new Set<string>();
    for (const [field, column] of Object.entries(table.columns)) {
      const previousFieldColumn = previous.columns[field];
      if (previousFieldColumn && previousFieldColumn.name !== column.name) {
        renamedColumnNames.add(previousFieldColumn.name);
        statements.push({
          sql: `alter table ${tableName(table)} add column ${columnSql(column)}`,
        });
        statements.push({
          sql: "",
          unsupported: true,
          reason: `column rename on ${table.name}.${field} from ${quoteIdentifier(previousFieldColumn.name, "postgresql")} to ${quoteIdentifier(column.name, "postgresql")} may require a manual migration`,
        });
        continue;
      }
      const prevColumn = previousFieldColumn ?? previousColumnsBySqlName.get(column.name);
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
    const nextColumnSqlNames = new Set(Object.values(table.columns).map((column) => column.name));
    const droppedColumnNames = new Set<string>();
    for (const column of Object.values(previous.columns)) {
      if (!nextColumnSqlNames.has(column.name) && !renamedColumnNames.has(column.name)) {
        droppedColumnNames.add(column.name);
        statements.push({
          sql: `alter table ${tableName(table)} drop column ${quoteIdentifier(column.name, "postgresql")}`,
          destructive: true,
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
        if (!previousFields.some((field) => droppedColumnNames.has(field))) {
          statements.push({
            sql: `drop index ${indexName(previous, previousIndex.name)}`,
            destructive: true,
          });
        }
        statements.push(createIndexStatement(table, index));
      }
    }
    for (const index of previous.indexes) {
      if (!nextIndexes.has(index.name)) {
        const fields = indexSqlFields(previous, index.fields);
        if (fields.some((field) => droppedColumnNames.has(field))) {
          continue;
        }
        statements.push({
          sql: `drop index ${indexName(previous, index.name)}`,
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
