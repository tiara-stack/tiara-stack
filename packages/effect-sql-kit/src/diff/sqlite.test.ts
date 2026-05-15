import { describe, expect, it } from "vitest";
import { diffSqlite } from "./sqlite";
import { emptySnapshot, type SchemaSnapshot } from "../snapshot";

describe("SQLite push diff", () => {
  it("creates tables and safe columns", () => {
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };

    expect(diffSqlite(emptySnapshot("sqlite"), next).statements[0]?.sql).toContain("create table");
  });

  it("aborts rebuild cases", () => {
    const prev: SchemaSnapshot = {
      version: 1,
      dialect: "sqlite",
      tables: {
        users: {
          name: "users",
          columns: {
            id: { fieldName: "id", name: "id", kind: "text", notNull: true, primaryKey: true },
            name: {
              fieldName: "name",
              name: "name",
              kind: "text",
              notNull: false,
              primaryKey: false,
            },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };
    const next: SchemaSnapshot = {
      ...prev,
      tables: {
        users: {
          ...prev.tables.users!,
          columns: {
            id: prev.tables.users!.columns.id!,
          },
        },
      },
    };

    expect(diffSqlite(prev, next).statements.some((statement) => statement.unsupported)).toBe(true);
  });
});
