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
type SqliteBuilder = {
  readonly default: (value: unknown) => SqliteBuilder;
  readonly primaryKey: () => unknown;
  readonly notNull: () => unknown;
};

type RuntimeTableFactory<Builder> = (
  name: string,
  columns: Record<string, Builder>,
  extraConfig: (table: Record<string, unknown>) => readonly unknown[],
) => unknown;

// Drizzle's builders intentionally infer a static column object and non-empty
// column tuples. This package reconstructs the same values from validated
// Effect SQL metadata at runtime, so those types cannot be inferred at the call
// site. Keep every Drizzle bridge here:
// - config restores the kind-specific config selected by the factory lookup;
// - sqliteBuilder exposes only the modifier methods shared by SQLite builders;
// - defaultValue bridges incompatible overload inputs across builder unions;
// - table invokes a generic table factory with a runtime column record;
// - index / primaryKey bridge validated fields to Drizzle's non-empty tuples.
const drizzleAdapter = {
  config: <Config>(value: unknown): Config => value as Config,
  sqliteBuilder: (value: unknown): SqliteBuilder => value as SqliteBuilder,
  defaultValue: <Result>(builder: { readonly default: unknown }, value: unknown): Result =>
    (builder.default as (input: unknown) => Result)(value),
  table: <Builder>(
    factory: unknown,
    name: string,
    columns: Record<string, Builder>,
    extraConfig: (table: Record<string, unknown>) => readonly unknown[],
  ): unknown => (factory as RuntimeTableFactory<Builder>)(name, columns, extraConfig),
  index: (builder: unknown, columns: readonly unknown[]): unknown =>
    (builder as { readonly on: (...values: unknown[]) => unknown }).on(...columns),
  primaryKey: (factory: unknown, columns: readonly unknown[]): unknown =>
    (factory as (config: { readonly columns: readonly unknown[] }) => unknown)({ columns }),
};

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

type PgScalarFactory = (pg: PgModule, name: string, config: unknown) => PgScalarBuilder;

const pgScalarFactories: Record<string, PgScalarFactory> = {
  uuid: (pg, name) => pg.uuid(name),
  varchar: (pg, name, config) =>
    pg.varchar(name, drizzleAdapter.config<Parameters<typeof pg.varchar>[1]>(config)),
  integer: (pg, name) => pg.integer(name),
  bigint: (pg, name, config) =>
    pg.bigint(name, drizzleAdapter.config<Parameters<typeof pg.bigint>[1]>(config)),
  real: (pg, name) => pg.real(name),
  doublePrecision: (pg, name) => pg.doublePrecision(name),
  numeric: (pg, name, config) =>
    pg.numeric(name, drizzleAdapter.config<Parameters<typeof pg.numeric>[1]>(config)),
  boolean: (pg, name) => pg.boolean(name),
  json: (pg, name) => pg.json(name),
  jsonb: (pg, name) => pg.jsonb(name),
  timestamp: (pg, name, config) =>
    pg.timestamp(name, drizzleAdapter.config<Parameters<typeof pg.timestamp>[1]>(config)),
  date: (pg, name) => pg.date(name),
  text: (pg, name) => pg.text(name),
};

const makePgScalar = (
  pg: PgModule,
  name: string,
  kind: string,
  config?: unknown,
): PgScalarBuilder => {
  const factory = pgScalarFactories[kind];
  if (factory === undefined) {
    throw new Error(`effect-sql-kit: unsupported postgres column kind ${kind} for ${name}`);
  }
  return factory(pg, name, config);
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
        ? drizzleAdapter.defaultValue<PgDefaultedBuilder>(scalar, column.data.defaultValue)
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
    drizzleAdapter.index(
      index.unique
        ? pg.uniqueIndex(prefixedIdentifierName(schema.prefix, index.name))
        : pg.index(prefixedIdentifierName(schema.prefix, index.name)),
      requireDrizzleFields(drizzleTable, tableName, `index ${index.name}`, index.fields),
    ),
  );

const lowerPgTable = (
  pg: PgModule,
  drizzleOrm: DrizzleOrmModule,
  schema: EffectSqlSchema,
  table: EffectSqlTable,
): unknown => {
  const tableName = tableDisplayName(table, schema.prefix);
  const columns = lowerPgColumns(pg, drizzleOrm, table);
  if (table.primaryKey.length > 1) {
    validateTableFields(columns, tableName, "primary key", table.primaryKey);
  }
  for (const index of table.indexes) {
    validateTableFields(columns, tableName, `index ${index.name}`, index.fields);
  }
  return drizzleAdapter.table(pg.pgTable, tableName, columns, (drizzleTable) => [
    ...(table.primaryKey.length > 1
      ? [
          drizzleAdapter.primaryKey(
            pg.primaryKey,
            requireDrizzleFields(drizzleTable, tableName, "primary key", table.primaryKey),
          ),
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

type SqliteBuilderFactory = (sqlite: SqliteModule, name: string, config: unknown) => SqliteBuilder;

const sqliteBuilderFactories: Record<string, SqliteBuilderFactory> = {
  integer: (sqlite, name, config) =>
    drizzleAdapter.sqliteBuilder(
      sqlite.integer(name, drizzleAdapter.config<Parameters<typeof sqlite.integer>[1]>(config)),
    ),
  real: (sqlite, name) => drizzleAdapter.sqliteBuilder(sqlite.real(name)),
  blob: (sqlite, name) => drizzleAdapter.sqliteBuilder(sqlite.blob(name)),
  numeric: (sqlite, name) => drizzleAdapter.sqliteBuilder(sqlite.numeric(name)),
  text: (sqlite, name) => drizzleAdapter.sqliteBuilder(sqlite.text(name)),
};

const makeSqliteBuilder = (sqlite: SqliteModule, name: string, column: EffectSqlColumn) => {
  const factory = sqliteBuilderFactories[column.data.kind];
  if (factory === undefined) {
    throw new Error(
      `effect-sql-kit: unsupported sqlite column kind ${String(column.data.kind)} for ${name}`,
    );
  }
  return factory(sqlite, name, column.data.config);
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
          ? drizzleAdapter.defaultValue<SqliteBuilder>(builder, column.data.defaultValue)
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
    drizzleAdapter.index(
      index.unique
        ? sqlite.uniqueIndex(prefixedIdentifierName(schema.prefix, index.name))
        : sqlite.index(prefixedIdentifierName(schema.prefix, index.name)),
      requireDrizzleFields(drizzleTable, tableName, `index ${index.name}`, index.fields),
    ),
  );

const lowerSqliteTable = (
  sqlite: SqliteModule,
  drizzleOrm: DrizzleOrmModule,
  schema: EffectSqlSchema,
  table: EffectSqlTable,
): unknown => {
  const tableName = tableDisplayName(table, schema.prefix);
  const columns = lowerSqliteColumns(sqlite, drizzleOrm, table);
  if (table.primaryKey.length > 1) {
    validateTableFields(columns, tableName, "primary key", table.primaryKey);
  }
  for (const index of table.indexes) {
    validateTableFields(columns, tableName, `index ${index.name}`, index.fields);
  }
  return drizzleAdapter.table(sqlite.sqliteTable, tableName, columns, (drizzleTable) => [
    ...(table.primaryKey.length > 1
      ? [
          drizzleAdapter.primaryKey(
            sqlite.primaryKey,
            requireDrizzleFields(drizzleTable, tableName, "primary key", table.primaryKey),
          ),
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
