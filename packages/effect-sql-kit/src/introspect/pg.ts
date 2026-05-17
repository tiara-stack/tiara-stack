import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { SchemaSnapshot, TableSnapshot } from "../snapshot";
import { snapshotVersion } from "../snapshot";

type PgTableRow = { readonly table_schema: string; readonly table_name: string };
type PgColumnRow = {
  readonly column_name: string;
  readonly data_type: string;
  readonly udt_name: string;
  readonly is_nullable: string;
  readonly column_default: string | null;
  readonly character_maximum_length: number | null;
};
type PgPrimaryKeyRow = { readonly column_name: string };
type PgIndexRow = {
  readonly indexname: string;
  readonly indexdef: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
};

const normalizeScalarType = (dataType: string, udtName: string): string => {
  if (udtName === "varchar" || dataType === "character varying") return "varchar";
  if (udtName === "uuid") return "uuid";
  if (udtName === "int4" || dataType === "integer") return "integer";
  if (udtName === "int8" || dataType === "bigint") return "bigint";
  if (udtName === "float4" || dataType === "real") return "real";
  if (udtName === "float8" || dataType === "double precision") return "doublePrecision";
  if (udtName === "numeric" || dataType === "numeric") return "numeric";
  if (udtName === "bool" || dataType === "boolean") return "boolean";
  if (udtName === "json" || dataType === "json") return "json";
  if (udtName === "jsonb" || dataType === "jsonb") return "jsonb";
  if (udtName === "timestamp" || udtName === "timestamptz" || dataType.includes("timestamp")) {
    return "timestamp";
  }
  if (udtName === "date" || dataType === "date") return "date";
  return "text";
};

const normalizeType = (row: PgColumnRow): string =>
  row.data_type === "ARRAY" || row.udt_name.startsWith("_")
    ? "array"
    : normalizeScalarType(row.data_type, row.udt_name);

const elementKind = (row: PgColumnRow): string | undefined =>
  row.udt_name.startsWith("_") ? normalizeScalarType("", row.udt_name.slice(1)) : undefined;

const columnConfig = (row: PgColumnRow): Record<string, unknown> | undefined => {
  if (row.data_type === "ARRAY" || row.udt_name.startsWith("_")) {
    const kind = elementKind(row) ?? "text";
    return {
      elementKind: kind,
      ...(kind === "varchar" && row.character_maximum_length !== null
        ? { elementConfig: { length: row.character_maximum_length } }
        : {}),
    };
  }
  if (row.udt_name === "varchar" && row.character_maximum_length !== null) {
    return { length: row.character_maximum_length };
  }
  if (row.data_type.includes("timestamp")) {
    return { withTimezone: row.data_type === "timestamp with time zone" };
  }
  return undefined;
};

export const introspectPg = (
  schemaFilter = "public",
  options?: { readonly excludedTables?: readonly string[] },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableRows = yield* sql.unsafe<PgTableRow>(
      "select table_schema, table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name",
      [schemaFilter],
    );
    const excludedTables = new Set(options?.excludedTables ?? []);
    const tables: Record<string, TableSnapshot> = {};
    for (const tableRow of tableRows.filter((row) => !excludedTables.has(row.table_name))) {
      const columnsRows = yield* sql.unsafe<PgColumnRow>(
        "select column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position",
        [tableRow.table_schema, tableRow.table_name],
      );
      const pkRows = yield* sql.unsafe<PgPrimaryKeyRow>(
        `select kcu.column_name
from information_schema.table_constraints tc
join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = $1 and tc.table_name = $2
order by kcu.ordinal_position`,
        [tableRow.table_schema, tableRow.table_name],
      );
      const indexRows = yield* sql.unsafe<PgIndexRow>(
        `select
  c.relname as indexname,
  pg_get_indexdef(i.indexrelid) as indexdef,
  i.indisunique as unique,
  coalesce(array_agg(a.attname order by key.ordinality) filter (where a.attname is not null), array[]::text[]) as columns
from pg_index i
join pg_class c on c.oid = i.indexrelid
join pg_class t on t.oid = i.indrelid
join pg_namespace n on n.oid = t.relnamespace
left join lateral unnest(i.indkey) with ordinality as key(attnum, ordinality) on true
left join pg_attribute a on a.attrelid = t.oid and a.attnum = key.attnum
where n.nspname = $1 and t.relname = $2 and not i.indisprimary
group by c.relname, i.indexrelid, i.indisunique
order by c.relname`,
        [tableRow.table_schema, tableRow.table_name],
      );
      const primaryKey = pkRows.map((row) => row.column_name);
      const table: TableSnapshot = {
        name: tableRow.table_name,
        schema: tableRow.table_schema,
        columns: {},
        primaryKey,
        indexes: indexRows.map((index) => ({
          name: index.indexname,
          unique: index.unique,
          fields: index.columns,
        })),
      };
      for (const column of columnsRows) {
        table.columns[column.column_name] = {
          fieldName: column.column_name,
          name: column.column_name,
          kind: normalizeType(column),
          notNull: column.is_nullable === "NO" || primaryKey.includes(column.column_name),
          primaryKey: primaryKey.includes(column.column_name),
          defaultSql: column.column_default ?? undefined,
          config: columnConfig(column),
        };
      }
      tables[tableRow.table_name] = table;
    }
    return {
      version: snapshotVersion,
      dialect: "postgresql" as const,
      tables,
    } satisfies SchemaSnapshot;
  });
