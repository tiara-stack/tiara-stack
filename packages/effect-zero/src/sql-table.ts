import { Predicate } from "effect";
import type { AnyEffectSqlTable } from "effect-sql-schema";
import type { ColumnOptions, EffectZeroTable, ZeroValueType } from "./types";

export type SchemaTable = EffectZeroTable | AnyEffectSqlTable;

const zeroTypesByColumnKind: Record<string, ZeroValueType> = {
  boolean: "boolean",
  integer: "number",
  bigint: "number",
  real: "number",
  doublePrecision: "number",
  numeric: "number",
  timestamp: "number",
  date: "number",
  json: "json",
  jsonb: "json",
  blob: "json",
  array: "json",
  text: "string",
  varchar: "string",
  uuid: "string",
};

const zeroType = (kind: string): ZeroValueType => zeroTypesByColumnKind[kind] ?? "string";

export const isEffectSqlTable = (value: unknown): value is AnyEffectSqlTable =>
  Predicate.isTagged("EffectSqlTable")(value);

export const fromSqlTable = <const Table extends AnyEffectSqlTable>(
  table: Table,
  options?: {
    readonly name?: string;
    readonly serverName?: string;
    readonly columns?: Partial<Record<keyof Table["columns"] & string, boolean | ColumnOptions>>;
  },
): EffectZeroTable<Table["model"]> => {
  const tableName = table.sqlName ?? table.name;
  const columns: Record<string, boolean | ColumnOptions> = {};
  for (const [fieldName, column] of Object.entries(table.columns)) {
    const override = options?.columns?.[fieldName];
    if (override === false) {
      columns[fieldName] = false;
      continue;
    }
    const columnOptions = typeof override === "object" && override !== null ? override : {};
    const hasServerDefault =
      column.data.defaultExpression !== undefined || column.data.defaultValue !== undefined;
    const columnName = columnOptions.name ?? column.data.name ?? fieldName;
    columns[fieldName] = {
      name: columnName,
      serverName: columnOptions.serverName ?? (columnName === fieldName ? undefined : columnName),
      type: columnOptions.type ?? zeroType(column.data.kind),
      optional:
        columnOptions.optional ??
        (column.data.primaryKey ? false : hasServerDefault ? true : !column.data.notNull),
    };
  }

  return {
    model: table.model,
    name: options?.name ?? tableName,
    serverName: options?.serverName ?? tableName,
    key: table.primaryKey,
    columns,
  };
};
