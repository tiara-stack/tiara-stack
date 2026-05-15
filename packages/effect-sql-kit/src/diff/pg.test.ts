import { describe, expect, it } from "vitest";
import { diffPg } from "./pg";
import { emptySnapshot, type SchemaSnapshot } from "../snapshot";

describe("Postgres push diff", () => {
  it("creates tables and marks drops as destructive", () => {
    const next: SchemaSnapshot = {
      version: 1,
      dialect: "postgresql",
      tables: {
        users: {
          name: "users",
          schema: "public",
          columns: {
            id: { fieldName: "id", name: "id", kind: "uuid", notNull: true, primaryKey: true },
          },
          primaryKey: ["id"],
          indexes: [],
        },
      },
    };
    const create = diffPg(emptySnapshot("postgresql"), next);
    const drop = diffPg(next, emptySnapshot("postgresql"));

    expect(create.statements[0]?.sql).toContain('create table "public"."users"');
    expect(drop.statements[0]?.destructive).toBe(true);
  });
});
