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
};
type PgPrimaryKeyRow = { readonly column_name: string };
type PgIndexRow = {
  readonly indexname: string;
  readonly indexdef: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
};

const normalizeType = (row: PgColumnRow): string => {
  if (row.udt_name === "uuid") return "uuid";
  if (row.data_type === "integer") return "integer";
  if (row.data_type === "bigint") return "bigint";
  if (row.data_type === "real") return "real";
  if (row.data_type === "double precision") return "doublePrecision";
  if (row.data_type === "numeric") return "numeric";
  if (row.data_type === "boolean") return "boolean";
  if (row.data_type === "json") return "json";
  if (row.data_type === "jsonb") return "jsonb";
  if (row.data_type.includes("timestamp")) return "timestamp";
  if (row.data_type === "date") return "date";
  return "text";
};

export const introspectPg = (schemaFilter = "public") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tableRows = yield* sql.unsafe<PgTableRow>(
      "select table_schema, table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' and table_name != 'effect_sql_migrations' order by table_name",
      [schemaFilter],
    );
    const tables: Record<string, TableSnapshot> = {};
    for (const tableRow of tableRows) {
      const columnsRows = yield* sql.unsafe<PgColumnRow>(
        "select column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position",
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
