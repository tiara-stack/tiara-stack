import type { ColumnSnapshot, SchemaSnapshot, TableSnapshot } from "../snapshot";

type Dialect = SchemaSnapshot["dialect"];

export const testColumn = (
  fieldName: string,
  overrides: Partial<ColumnSnapshot> = {},
): ColumnSnapshot => ({
  fieldName,
  name: fieldName,
  kind: "text",
  notNull: true,
  primaryKey: false,
  ...overrides,
});

export const testTable = (
  dialect: Dialect,
  name: string,
  columns: TableSnapshot["columns"],
  options: Partial<Omit<TableSnapshot, "name" | "columns">> = {},
): TableSnapshot => ({
  name,
  ...(dialect === "postgresql" ? { schema: "public" } : {}),
  columns,
  primaryKey: ["id"],
  indexes: [],
  ...options,
});

export const testSnapshot = (
  dialect: Dialect,
  tableKey: string,
  table: TableSnapshot,
): SchemaSnapshot => ({
  version: 1,
  dialect,
  tables: { [tableKey]: table },
});
