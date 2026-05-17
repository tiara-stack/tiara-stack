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

const prefixedTableName = (prefix: string | undefined, tableName: string): string =>
  prefix ? `${prefix.replace(/_+$/, "")}_${tableName}` : tableName;

const tableDisplayName = (
  table: { readonly sqlName?: string; readonly name: string },
  prefix?: string,
): string => prefixedTableName(prefix, table.sqlName ?? table.name);

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

export const lowerToDrizzleExports = async (
  schema: EffectSqlSchema,
): Promise<Record<string, unknown>> => {
  if (firstTable(schema).dialect === "postgresql") {
    const [pg, drizzleOrm] = await Promise.all([
      import("drizzle-orm/pg-core"),
      import("drizzle-orm"),
    ]);
    const exports: Record<string, unknown> = {};
    for (const [key, table] of Object.entries(schema.tables)) {
      const tableName = tableDisplayName(table, schema.tablePrefix);
      const columns: Record<string, PgFinalBuilder> = {};
      for (const [fieldName, column] of Object.entries(table.columns)) {
        const name = column.data.name ?? fieldName;
        const makeScalar = (kind: string, config?: unknown): PgScalarBuilder => {
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
            default:
              return pg.text(name);
          }
        };
        const elementConfig = column.data.config?.elementConfig;
        const scalar: PgMutableBuilder =
          column.data.kind === "array"
            ? (
                makeScalar(
                  requireArrayElementKind(column.data),
                  typeof elementConfig === "object" && elementConfig !== null
                    ? (elementConfig as Record<string, unknown>)
                    : undefined,
                ) as PgScalarBuilder
              ).array()
            : makeScalar(column.data.kind, column.data.config);
        const mutableBuilder: PgMutableBuilder = scalar;
        const withDefault: PgDefaultedBuilder =
          column.data.defaultExpression !== undefined
            ? mutableBuilder.default(drizzleOrm.sql.raw(column.data.defaultExpression))
            : column.data.defaultValue !== undefined
              ? mutableBuilder.default(column.data.defaultValue as never)
              : scalar;
        const mutableWithDefault: PgDefaultedBuilder = withDefault;
        columns[fieldName] =
          column.data.primaryKey && table.primaryKey.length === 1
            ? mutableWithDefault.primaryKey()
            : column.data.notNull
              ? mutableWithDefault.notNull()
              : withDefault;
      }
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
      exports[key] = pgTable(tableName, columns, (drizzleTable) => [
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
        ...table.indexes.map((index) =>
          (
            (index.unique ? pg.uniqueIndex(index.name) : pg.index(index.name)) as unknown as {
              readonly on: (...columns: unknown[]) => unknown;
            }
          ).on(
            ...requireDrizzleFields(drizzleTable, tableName, `index ${index.name}`, index.fields),
          ),
        ),
      ]);
    }
    return exports;
  }

  const [sqlite, drizzleOrm] = await Promise.all([
    import("drizzle-orm/sqlite-core"),
    import("drizzle-orm"),
  ]);
  const exports: Record<string, unknown> = {};
  for (const [key, table] of Object.entries(schema.tables)) {
    const tableName = tableDisplayName(table, schema.tablePrefix);
    const columns: Record<string, unknown> = {};
    for (const [fieldName, column] of Object.entries(table.columns)) {
      const name = column.data.name ?? fieldName;
      const builder =
        column.data.kind === "integer"
          ? sqlite.integer(name, column.data.config as Parameters<typeof sqlite.integer>[1])
          : column.data.kind === "real"
            ? sqlite.real(name)
            : column.data.kind === "blob"
              ? sqlite.blob(name)
              : column.data.kind === "numeric"
                ? sqlite.numeric(name)
                : sqlite.text(name);
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
    exports[key] = sqliteTable(tableName, columns, (drizzleTable) => [
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
      ...table.indexes.map((index) =>
        (
          (index.unique ? sqlite.uniqueIndex(index.name) : sqlite.index(index.name)) as unknown as {
            readonly on: (...columns: unknown[]) => unknown;
          }
        ).on(...requireDrizzleFields(drizzleTable, tableName, `index ${index.name}`, index.fields)),
      ),
    ]);
  }
  return exports;
};

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
