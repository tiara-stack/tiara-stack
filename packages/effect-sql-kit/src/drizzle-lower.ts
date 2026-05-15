import type { EffectSqlSchema } from "./types";
import { snapshotSchema } from "./snapshot";

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
    const pg = await import("drizzle-orm/pg-core");
    const exports: Record<string, unknown> = {};
    for (const [key, table] of Object.entries(schema.tables)) {
      const columns: Record<string, unknown> = {};
      for (const [fieldName, column] of Object.entries(table.columns)) {
        const name = column.data.name ?? fieldName;
        const builder =
          column.data.kind === "uuid"
            ? pg.uuid(name)
            : column.data.kind === "integer"
              ? pg.integer(name)
              : column.data.kind === "boolean"
                ? pg.boolean(name)
                : column.data.kind === "json"
                  ? pg.json(name)
                  : column.data.kind === "jsonb"
                    ? pg.jsonb(name)
                    : column.data.kind === "timestamp"
                      ? pg.timestamp(name, column.data.config as Parameters<typeof pg.timestamp>[1])
                      : pg.text(name);
        const mutableBuilder = builder as unknown as {
          readonly primaryKey: () => unknown;
          readonly notNull: () => unknown;
        };
        columns[fieldName] = column.data.primaryKey
          ? mutableBuilder.primaryKey()
          : column.data.notNull
            ? mutableBuilder.notNull()
            : builder;
      }
      exports[key] = pg.pgTable(
        table.sqlName ?? table.name,
        columns as unknown as Parameters<typeof pg.pgTable>[1],
      );
    }
    return exports;
  }

  const sqlite = await import("drizzle-orm/sqlite-core");
  const exports: Record<string, unknown> = {};
  for (const [key, table] of Object.entries(schema.tables)) {
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
      const mutableBuilder = builder as unknown as {
        readonly primaryKey: () => unknown;
        readonly notNull: () => unknown;
      };
      columns[fieldName] = column.data.primaryKey
        ? mutableBuilder.primaryKey()
        : column.data.notNull
          ? mutableBuilder.notNull()
          : builder;
    }
    exports[key] = sqlite.sqliteTable(
      table.sqlName ?? table.name,
      columns as unknown as Parameters<typeof sqlite.sqliteTable>[1],
    );
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
