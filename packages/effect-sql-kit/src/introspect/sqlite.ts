import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SchemaSnapshot, TableSnapshot } from "../snapshot";
import { snapshotVersion } from "../snapshot";
import { quoteIdentifier } from "../util";

type SqliteTableRow = { readonly name: string };
type SqliteColumnRow = {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
  readonly dflt_value: string | null;
};
type SqliteIndexRow = { readonly name: string; readonly unique: number; readonly origin: string };
type SqliteIndexInfoRow = { readonly name: string };

const normalizeType = (type: string): string => {
  const lowered = type.toLowerCase();
  if (lowered.includes("int")) return "integer";
  if (lowered.includes("real") || lowered.includes("floa") || lowered.includes("doub"))
    return "real";
  if (lowered.includes("blob")) return "blob";
  if (lowered.includes("numeric") || lowered.includes("decimal")) return "numeric";
  return "text";
};

export const introspectSqlite = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tableRows = yield* sql.unsafe<SqliteTableRow>(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name != 'effect_sql_migrations' order by name",
  );
  const tables: Record<string, TableSnapshot> = {};
  for (const tableRow of tableRows) {
    const columnsRows = yield* sql.unsafe<SqliteColumnRow>(
      `pragma table_info(${quoteIdentifier(tableRow.name, "sqlite")})`,
    );
    const indexesRows = yield* sql.unsafe<SqliteIndexRow>(
      `pragma index_list(${quoteIdentifier(tableRow.name, "sqlite")})`,
    );
    const indexes = yield* Effect.forEach(
      indexesRows.filter((index) => index.origin === "c"),
      (index) =>
        Effect.map(
          sql.unsafe<SqliteIndexInfoRow>(
            `pragma index_info(${quoteIdentifier(index.name, "sqlite")})`,
          ),
          (rows) => ({
            name: index.name,
            unique: index.unique === 1,
            fields: rows.map((row) => row.name),
          }),
        ),
    );
    const table: TableSnapshot = {
      name: tableRow.name,
      columns: {},
      primaryKey: columnsRows
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
      indexes,
    };
    for (const column of columnsRows) {
      table.columns[column.name] = {
        fieldName: column.name,
        name: column.name,
        kind: normalizeType(column.type),
        notNull: column.notnull === 1 || column.pk > 0,
        primaryKey: column.pk > 0,
        defaultSql: column.dflt_value ?? undefined,
      };
    }
    tables[tableRow.name] = table;
  }
  return {
    version: snapshotVersion,
    dialect: "sqlite" as const,
    tables,
  } satisfies SchemaSnapshot;
});
