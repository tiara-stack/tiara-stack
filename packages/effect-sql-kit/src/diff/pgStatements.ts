import { isDeepStrictEqual } from "node:util";
import type { ColumnSnapshot, SchemaSnapshot, TableSnapshot } from "../snapshot";
import { quoteIdentifier, quoteQualified } from "../util";
import type { MigrationStatement } from "./types";

const columnType = (column: ColumnSnapshot): string => {
  switch (column.kind) {
    case "array": {
      const elementKind = column.config?.elementKind;
      const elementConfig = column.config?.elementConfig;
      if (typeof elementKind !== "string") {
        return "text[]";
      }
      return `${columnType({
        ...column,
        kind: elementKind,
        config:
          typeof elementConfig === "object" && elementConfig !== null
            ? (elementConfig as Record<string, unknown>)
            : undefined,
      })}[]`;
    }
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

export const tableKey = (table: TableSnapshot): string =>
  `${table.schema ?? "public"}.${table.name}`;

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

const normalizeFields = (fields: readonly string[] | string): readonly string[] => {
  if (typeof fields !== "string") {
    return fields;
  }
  if (!fields.startsWith("{") || !fields.endsWith("}")) {
    return [fields];
  }
  return fields
    .slice(1, -1)
    .split(",")
    .filter((field) => field.length > 0);
};

const primaryKeySqlNames = (table: TableSnapshot): readonly string[] =>
  normalizeFields(table.primaryKey).map((field) =>
    sqlNameForField(table, field, { allowMissing: true }),
  );

const indexSqlFields = (
  table: TableSnapshot,
  fields: readonly string[] | string,
): readonly string[] =>
  normalizeFields(fields).map((field) => sqlNameForField(table, field, { allowMissing: true }));

const createIndexStatement = (table: TableSnapshot, index: TableSnapshot["indexes"][number]) => ({
  sql: `create ${index.unique ? "unique " : ""}index ${quoteIdentifier(index.name, "postgresql")} on ${tableName(table)} (${index.fields
    .map((field) =>
      quoteIdentifier(requireColumn(table, field, `index ${index.name}`).name, "postgresql"),
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

const normalizeColumnShapeForComparison = (column: ColumnSnapshot) =>
  Object.fromEntries(
    Object.entries({
      ...column,
      fieldName: undefined,
      default: undefined,
      defaultSql: undefined,
    }).filter(([, value]) => value !== undefined),
  );

const columnChanged = (a: ColumnSnapshot, b: ColumnSnapshot): boolean =>
  !isDeepStrictEqual(normalizeColumnShapeForComparison(a), normalizeColumnShapeForComparison(b));

const normalizeDefaultSql = (sql?: string): string | undefined => {
  if (!sql) return undefined;
  const normalized = sql.trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized === "current_timestamp") return "now()";
  const castMatch = normalized.match(/^'([^']*)'::(?:text|character varying|varchar)$/);
  if (castMatch) return `'${castMatch[1]}'`;
  return normalized;
};

const defaultValueFromSql = (sql?: string): ColumnSnapshot["default"] | undefined => {
  if (sql === "true") return true;
  if (sql === "false") return false;
  if (sql === "null") return null;
  if (sql?.startsWith("'") && sql.endsWith("'")) {
    return sql.slice(1, -1).replaceAll("''", "'");
  }
  if (sql && /^-?\d+(?:\.\d+)?$/.test(sql)) {
    return Number(sql);
  }
  return undefined;
};

const columnDefaultExpression = (column: ColumnSnapshot): string | undefined => {
  const defaultSql = normalizeDefaultSql(column.defaultSql);
  const sqlDefault = defaultValueFromSql(defaultSql);
  const defaultValue = column.default ?? sqlDefault;
  return defaultValue !== undefined && defaultSql === literal(defaultValue)
    ? literal(defaultValue)
    : (defaultSql ?? (column.default !== undefined ? literal(column.default) : undefined));
};

export const tablesBySqlName = (snapshot: SchemaSnapshot): Map<string, TableSnapshot> =>
  new Map(Object.values(snapshot.tables).map((table) => [tableKey(table), table]));

const columnsBySqlName = (table: TableSnapshot): Map<string, ColumnSnapshot> =>
  new Map(Object.values(table.columns).map((column) => [column.name, column]));

const hasPrimaryKeyChange = (previous: TableSnapshot, table: TableSnapshot): boolean =>
  JSON.stringify(primaryKeySqlNames(previous)) !== JSON.stringify(primaryKeySqlNames(table));

const primaryKeyChangeStatement = (table: TableSnapshot): MigrationStatement => ({
  sql: "",
  unsupported: true,
  reason: `primary key changes on ${table.name} require a manual migration`,
});

const addColumnStatement = (table: TableSnapshot, column: ColumnSnapshot): MigrationStatement => ({
  sql: `alter table ${tableName(table)} add column ${columnSql(column)}`,
});

const renameColumnStatements = (
  table: TableSnapshot,
  field: string,
  previousColumn: ColumnSnapshot,
  column: ColumnSnapshot,
): MigrationStatement[] => [
  addColumnStatement(table, column),
  {
    sql: "",
    unsupported: true,
    reason: `column rename on ${table.name}.${field} from ${quoteIdentifier(previousColumn.name, "postgresql")} to ${quoteIdentifier(column.name, "postgresql")} may require a manual migration`,
  },
];

const notNullStatement = (table: TableSnapshot, column: ColumnSnapshot): MigrationStatement => ({
  sql: `alter table ${tableName(table)} alter column ${quoteIdentifier(column.name, "postgresql")} ${column.notNull ? "set not null" : "drop not null"}`,
});

const defaultStatement = (
  table: TableSnapshot,
  column: ColumnSnapshot,
  nextDefault: string | undefined,
): MigrationStatement => ({
  sql: `alter table ${tableName(table)} alter column ${quoteIdentifier(column.name, "postgresql")} ${nextDefault === undefined ? "drop default" : `set default ${nextDefault}`}`,
});

const manualColumnChangeStatement = (table: TableSnapshot, field: string): MigrationStatement => ({
  sql: "",
  unsupported: true,
  reason: `column change on ${table.name}.${field} may require a manual migration`,
});

const diffExistingColumn = (
  table: TableSnapshot,
  field: string,
  prevColumn: ColumnSnapshot,
  column: ColumnSnapshot,
): MigrationStatement[] => {
  const statements: MigrationStatement[] = [];
  if (prevColumn.notNull !== column.notNull) {
    statements.push(notNullStatement(table, column));
  }
  const previousDefault = columnDefaultExpression(prevColumn);
  const nextDefault = columnDefaultExpression(column);
  if (previousDefault !== nextDefault) {
    statements.push(defaultStatement(table, column, nextDefault));
  }
  if (columnChanged(prevColumn, column)) {
    statements.push(manualColumnChangeStatement(table, field));
  }
  return statements;
};

const diffColumns = (
  previous: TableSnapshot,
  table: TableSnapshot,
): {
  readonly statements: readonly MigrationStatement[];
  readonly droppedColumnNames: ReadonlySet<string>;
} => {
  const statements: MigrationStatement[] = [];
  const previousColumnsBySqlName = columnsBySqlName(previous);
  const renamedColumnNames = new Set<string>();
  for (const [field, column] of Object.entries(table.columns)) {
    const previousFieldColumn = previous.columns[field];
    if (previousFieldColumn && previousFieldColumn.name !== column.name) {
      renamedColumnNames.add(previousFieldColumn.name);
      statements.push(...renameColumnStatements(table, field, previousFieldColumn, column));
      continue;
    }
    const prevColumn = previousFieldColumn ?? previousColumnsBySqlName.get(column.name);
    statements.push(
      ...(prevColumn
        ? diffExistingColumn(table, field, prevColumn, column)
        : [addColumnStatement(table, column)]),
    );
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
  return { statements, droppedColumnNames };
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

const dropIndexStatement = (
  table: TableSnapshot,
  index: TableSnapshot["indexes"][number],
): MigrationStatement => ({
  sql: `drop index ${indexName(table, index.name)}`,
  destructive: true,
});

const shouldSkipIndexDrop = (
  previous: TableSnapshot,
  index: TableSnapshot["indexes"][number],
  droppedColumnNames: ReadonlySet<string>,
): boolean => indexSqlFields(previous, index.fields).some((field) => droppedColumnNames.has(field));

const diffIndexes = (
  previous: TableSnapshot,
  table: TableSnapshot,
  droppedColumnNames: ReadonlySet<string>,
): MigrationStatement[] => {
  const statements: MigrationStatement[] = [];
  const previousIndexes = indexesByName(previous);
  const nextIndexes = indexesByName(table);
  for (const index of table.indexes) {
    const previousIndex = previousIndexes.get(index.name);
    if (!previousIndex) {
      statements.push(createIndexStatement(table, index));
    } else if (indexChanged(previous, table, previousIndex, index)) {
      if (!shouldSkipIndexDrop(previous, previousIndex, droppedColumnNames)) {
        statements.push(dropIndexStatement(previous, previousIndex));
      }
      statements.push(createIndexStatement(table, index));
    }
  }
  for (const index of previous.indexes) {
    if (!nextIndexes.has(index.name) && !shouldSkipIndexDrop(previous, index, droppedColumnNames)) {
      statements.push(dropIndexStatement(previous, index));
    }
  }
  return statements;
};

export const diffExistingTable = (
  previous: TableSnapshot,
  table: TableSnapshot,
): MigrationStatement[] => {
  const columnDiff = diffColumns(previous, table);
  return [
    ...(hasPrimaryKeyChange(previous, table) ? [primaryKeyChangeStatement(table)] : []),
    ...columnDiff.statements,
    ...diffIndexes(previous, table, columnDiff.droppedColumnNames),
  ];
};

export const dropRemovedTables = (
  prev: SchemaSnapshot,
  next: SchemaSnapshot,
): MigrationStatement[] => {
  const statements: MigrationStatement[] = [];
  const nextTableSqlNames = new Set(Object.values(next.tables).map((table) => tableKey(table)));
  for (const [key, table] of Object.entries(prev.tables)) {
    if (!next.tables[key] && !nextTableSqlNames.has(tableKey(table))) {
      statements.push({
        sql: `drop table ${tableName(table)}`,
        destructive: true,
      });
    }
  }
  return statements;
};
