import type * as PgCore from "drizzle-orm/pg-core";
import type { EffectSqlSchema } from "./types";
import { snapshotSchema } from "./snapshot";

type PgScalarBuilder =
  | ReturnType<typeof PgCore.uuid>
  | ReturnType<typeof PgCore.varchar>
  | ReturnType<typeof PgCore.integer>
  | ReturnType<typeof PgCore.bigint>
  | ReturnType<typeof PgCore.real>
  | ReturnType<typeof PgCore.doublePrecision>
  | ReturnType<typeof PgCore.numeric>
  | ReturnType<typeof PgCore.boolean>
  | ReturnType<typeof PgCore.json>
  | ReturnType<typeof PgCore.jsonb>
  | ReturnType<typeof PgCore.timestamp>
  | ReturnType<typeof PgCore.date>
  | ReturnType<typeof PgCore.text>;

type PgArrayBuilder = ReturnType<PgScalarBuilder["array"]>;
type PgMutableBuilder = PgScalarBuilder | PgArrayBuilder;
type PgDefaultedBuilder = PgMutableBuilder | ReturnType<PgMutableBuilder["default"]>;
type PgFinalBuilder =
  | PgDefaultedBuilder
  | ReturnType<PgDefaultedBuilder["primaryKey"]>
  | ReturnType<PgDefaultedBuilder["notNull"]>;

type PgModule = typeof import("drizzle-orm/pg-core");
type SqliteModule = typeof import("drizzle-orm/sqlite-core");
type DrizzleOrmModule = typeof import("drizzle-orm");
type EffectSqlTable = EffectSqlSchema["tables"][string];
type EffectSqlColumn = EffectSqlTable["columns"][string];

const supportedPgArrayElementKinds = new Set([
  "uuid",
  "varchar",
  "integer",
  "bigint",
  "real",
  "doublePrecision",
  "numeric",
  "boolean",
  "json",
  "jsonb",
  "timestamp",
  "date",
  "text",
]);

const prefixedIdentifierName = (prefix: string | undefined, name: string): string =>
  prefix ? `${prefix.replace(/_+$/, "")}_${name}` : name;

const tableDisplayName = (
  table: { readonly sqlName?: string; readonly name: string },
  prefix?: string,
): string => prefixedIdentifierName(prefix, table.sqlName ?? table.name);

const requireDrizzleField = (
  drizzleTable: Record<string, unknown>,
  tableName: string,
  context: string,
  field: string,
) => {
  const column = drizzleTable[field];
  if (column === undefined) {
    throw new Error(`effect-sql-kit: ${tableName} ${context} references missing field ${field}`);
  }
  return column;
};

const requireDrizzleFields = (
  drizzleTable: Record<string, unknown>,
  tableName: string,
  context: string,
  fields: readonly string[],
) => fields.map((field) => requireDrizzleField(drizzleTable, tableName, context, field));

const validateTableFields = (
  columns: Record<string, unknown>,
  tableName: string,
  context: string,
  fields: readonly string[],
) => {
  const missing = fields.filter((field) => columns[field] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `effect-sql-kit: ${tableName} ${context} references missing field ${missing.join(", ")}`,
    );
  }
};

const requireArrayElementKind = (columnData: {
  readonly name?: string;
  readonly fieldName?: string;
  readonly config?: Record<string, unknown>;
}): string => {
  const elementKind = columnData.config?.elementKind;
  if (typeof elementKind !== "string" || !supportedPgArrayElementKinds.has(elementKind)) {
    throw new Error(
      `effect-sql-kit: array column ${columnData.name ?? columnData.fieldName ?? "<unknown>"} has invalid elementKind ${String(elementKind)}`,
    );
  }
  return elementKind;
};

const firstTable = (schema: EffectSqlSchema) => {
  const [firstKey] = Object.keys(schema.tables);
  if (!firstKey) {
    throw new Error("effect-sql-kit: schema must contain at least one table");
  }
  return schema.tables[firstKey]!;
};

const makePgScalar = (
  pg: PgModule,
  name: string,
  kind: string,
  config?: unknown,
): PgScalarBuilder => {
  switch (kind) {
    case "uuid":
      return pg.uuid(name);
    case "varchar":
      return pg.varchar(name, config as Parameters<typeof pg.varchar>[1]);
    case "integer":
      return pg.integer(name);
    case "bigint":
      return pg.bigint(name, config as Parameters<typeof pg.bigint>[1]);
    case "real":
      return pg.real(name);
    case "doublePrecision":
      return pg.doublePrecision(name);
    case "numeric":
      return pg.numeric(name, config as Parameters<typeof pg.numeric>[1]);
    case "boolean":
      return pg.boolean(name);
    case "json":
      return pg.json(name);
    case "jsonb":
      return pg.jsonb(name);
    case "timestamp":
      return pg.timestamp(name, config as Parameters<typeof pg.timestamp>[1]);
    case "date":
      return pg.date(name);
    case "text":
      return pg.text(name);
    default:
      throw new Error(`effect-sql-kit: unsupported postgres column kind ${kind} for ${name}`);
  }
};

const pgScalarOrArray = (pg: PgModule, name: string, column: EffectSqlColumn): PgMutableBuilder => {
  if (column.data.kind !== "array") {
    return makePgScalar(pg, name, column.data.kind, column.data.config);
  }

  const elementConfig = column.data.config?.elementConfig;
  return makePgScalar(
    pg,
    name,
    requireArrayElementKind(column.data),
    typeof elementConfig === "object" && elementConfig !== null
      ? (elementConfig as Record<string, unknown>)
      : undefined,
  ).array();
};

const applyPgColumnModifiers = (
  drizzleOrm: DrizzleOrmModule,
  table: EffectSqlTable,
  column: EffectSqlColumn,
  scalar: PgMutableBuilder,
): PgFinalBuilder => {
  const withDefault: PgDefaultedBuilder =
    column.data.defaultExpression !== undefined
      ? scalar.default(drizzleOrm.sql.raw(column.data.defaultExpression))
      : column.data.defaultValue !== undefined
        ? scalar.default(column.data.defaultValue as never)
        : scalar;
  return column.data.primaryKey && table.primaryKey.length === 1
    ? withDefault.primaryKey()
    : column.data.notNull
      ? withDefault.notNull()
      : withDefault;
};

const lowerPgColumns = (
  pg: PgModule,
  drizzleOrm: DrizzleOrmModule,
  table: EffectSqlTable,
): Record<string, PgFinalBuilder> => {
  const columns: Record<string, PgFinalBuilder> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    const name = column.data.name ?? fieldName;
    columns[fieldName] = applyPgColumnModifiers(
      drizzleOrm,
      table,
      column,
      pgScalarOrArray(pg, name, column),
    );
  }
  return columns;
};

const pgIndexConfig = (
  pg: PgModule,
  schema: EffectSqlSchema,
  table: EffectSqlTable,
  tableName: string,
  drizzleTable: Record<string, unknown>,
) =>
  table.indexes.map((index) =>
    (
      (index.unique
        ? pg.uniqueIndex(prefixedIdentifierName(schema.prefix, index.name))
        : pg.index(prefixedIdentifierName(schema.prefix, index.name))) as unknown as {
        readonly on: (...columns: unknown[]) => unknown;
      }
    ).on(...requireDrizzleFields(drizzleTable, tableName, `index ${index.name}`, index.fields)),
  );

const lowerPgTable = (
  pg: PgModule,
  drizzleOrm: DrizzleOrmModule,
  schema: EffectSqlSchema,
  table: EffectSqlTable,
): unknown => {
  const tableName = tableDisplayName(table, schema.prefix);
  const columns = lowerPgColumns(pg, drizzleOrm, table);
  const pgTable = pg.pgTable as unknown as (
    name: string,
    columns: Record<string, PgFinalBuilder>,
    extraConfig: (table: Record<string, unknown>) => readonly unknown[],
  ) => unknown;
  if (table.primaryKey.length > 1) {
    validateTableFields(columns, tableName, "primary key", table.primaryKey);
  }
  for (const index of table.indexes) {
    validateTableFields(columns, tableName, `index ${index.name}`, index.fields);
  }
  return pgTable(tableName, columns, (drizzleTable) => [
    ...(table.primaryKey.length > 1
      ? [
          pg.primaryKey({
            columns: requireDrizzleFields(
              drizzleTable,
              tableName,
              "primary key",
              table.primaryKey,
            ) as never,
          }),
        ]
      : []),
    ...pgIndexConfig(pg, schema, table, tableName, drizzleTable),
  ]);
};

const lowerPostgresExports = async (schema: EffectSqlSchema): Promise<Record<string, unknown>> => {
  const [pg, drizzleOrm] = await Promise.all([
    import("drizzle-orm/pg-core"),
    import("drizzle-orm"),
  ]);
  const exports: Record<string, unknown> = {};
  for (const [key, table] of Object.entries(schema.tables)) {
    exports[key] = lowerPgTable(pg, drizzleOrm, schema, table);
  }
  return exports;
};

const makeSqliteBuilder = (sqlite: SqliteModule, name: string, column: EffectSqlColumn) => {
  switch (column.data.kind) {
    case "integer":
      return sqlite.integer(name, column.data.config as Parameters<typeof sqlite.integer>[1]);
    case "real":
      return sqlite.real(name);
    case "blob":
      return sqlite.blob(name);
    case "numeric":
      return sqlite.numeric(name);
    case "text":
      return sqlite.text(name);
    default:
      throw new Error(
        `effect-sql-kit: unsupported sqlite column kind ${String(column.data.kind)} for ${name}`,
      );
  }
};

const lowerSqliteColumns = (
  sqlite: SqliteModule,
  drizzleOrm: DrizzleOrmModule,
  table: EffectSqlTable,
): Record<string, unknown> => {
  const columns: Record<string, unknown> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    const name = column.data.name ?? fieldName;
    const builder = makeSqliteBuilder(sqlite, name, column);
    const withDefault =
      column.data.defaultExpression !== undefined
        ? builder.default(drizzleOrm.sql.raw(column.data.defaultExpression))
        : column.data.defaultValue !== undefined
          ? builder.default(column.data.defaultValue as never)
          : builder;
    columns[fieldName] =
      column.data.primaryKey && table.primaryKey.length === 1
        ? withDefault.primaryKey()
        : column.data.notNull
          ? withDefault.notNull()
          : withDefault;
  }
  return columns;
};

const sqliteIndexConfig = (
  sqlite: SqliteModule,
  schema: EffectSqlSchema,
  table: EffectSqlTable,
  tableName: string,
  drizzleTable: Record<string, unknown>,
) =>
  table.indexes.map((index) =>
    (
      (index.unique
        ? sqlite.uniqueIndex(prefixedIdentifierName(schema.prefix, index.name))
        : sqlite.index(prefixedIdentifierName(schema.prefix, index.name))) as unknown as {
        readonly on: (...columns: unknown[]) => unknown;
      }
    ).on(...requireDrizzleFields(drizzleTable, tableName, `index ${index.name}`, index.fields)),
  );

const lowerSqliteTable = (
  sqlite: SqliteModule,
  drizzleOrm: DrizzleOrmModule,
  schema: EffectSqlSchema,
  table: EffectSqlTable,
): unknown => {
  const tableName = tableDisplayName(table, schema.prefix);
  const columns = lowerSqliteColumns(sqlite, drizzleOrm, table);
  const sqliteTable = sqlite.sqliteTable as unknown as (
    name: string,
    columns: Record<string, unknown>,
    extraConfig: (table: Record<string, unknown>) => readonly unknown[],
  ) => unknown;
  if (table.primaryKey.length > 1) {
    validateTableFields(columns, tableName, "primary key", table.primaryKey);
  }
  for (const index of table.indexes) {
    validateTableFields(columns, tableName, `index ${index.name}`, index.fields);
  }
  return sqliteTable(tableName, columns, (drizzleTable) => [
    ...(table.primaryKey.length > 1
      ? [
          sqlite.primaryKey({
            columns: requireDrizzleFields(
              drizzleTable,
              tableName,
              "primary key",
              table.primaryKey,
            ) as never,
          }),
        ]
      : []),
    ...sqliteIndexConfig(sqlite, schema, table, tableName, drizzleTable),
  ]);
};

const lowerSqliteExports = async (schema: EffectSqlSchema): Promise<Record<string, unknown>> => {
  const [sqlite, drizzleOrm] = await Promise.all([
    import("drizzle-orm/sqlite-core"),
    import("drizzle-orm"),
  ]);
  const exports: Record<string, unknown> = {};
  for (const [key, table] of Object.entries(schema.tables)) {
    exports[key] = lowerSqliteTable(sqlite, drizzleOrm, schema, table);
  }
  return exports;
};

export const lowerToDrizzleExports = async (
  schema: EffectSqlSchema,
): Promise<Record<string, unknown>> =>
  firstTable(schema).dialect === "postgresql"
    ? lowerPostgresExports(schema)
    : lowerSqliteExports(schema);

export const lowerToDrizzleSnapshot = async (schema: EffectSqlSchema): Promise<unknown> => {
  const drizzleExports = await lowerToDrizzleExports(schema);
  try {
    const api = await import("drizzle-kit/api");
    return firstTable(schema).dialect === "postgresql"
      ? api.generateDrizzleJson(drizzleExports)
      : await api.generateSQLiteDrizzleJson(drizzleExports);
  } catch (error) {
    return {
      fallback: "effect-sql-kit",
      reason: String(error),
      ...snapshotSchema(schema),
    };
  }
};
