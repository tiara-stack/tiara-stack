import type { SchemaSnapshot } from "../snapshot";
import {
  diffExistingTable,
  dropRemovedTables,
  tableStatements,
  tablesBySqlName,
} from "./sqliteStatements";
import type { DiffResult, MigrationStatement } from "./types";

export const diffSqlite = (prev: SchemaSnapshot, next: SchemaSnapshot): DiffResult => {
  const statements: MigrationStatement[] = [];
  const previousTablesBySqlName = tablesBySqlName(prev);
  for (const [key, table] of Object.entries(next.tables)) {
    const previous = prev.tables[key] ?? previousTablesBySqlName.get(table.name);
    statements.push(...(previous ? diffExistingTable(previous, table) : tableStatements(table)));
  }
  statements.push(...dropRemovedTables(prev, next));
  return { statements };
};
