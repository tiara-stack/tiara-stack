import { describe, expect, it } from "@effect/vitest";
import { emptySnapshot } from "../snapshot";
import { diffSqlite } from "./sqlite";
import { testSnapshot, testTable, testColumn } from "./testFixtures";
import { testSqlNameContract } from "./sqlNameContract";

const id = () => testColumn("id", { primaryKey: true });
const sqliteSnapshot = (
  tableKey: string,
  name: string,
  columns: Parameters<typeof testTable>[2],
  options: Parameters<typeof testTable>[3] = {},
) => testSnapshot("sqlite", tableKey, testTable("sqlite", name, columns, options));

describe("SQLite push diff", () => {
  testSqlNameContract({ dialect: "sqlite", idKind: "text", diff: diffSqlite });

  it("creates tables and safe columns", () => {
    const next = sqliteSnapshot("users", "users", { id: id() });

    expect(diffSqlite(emptySnapshot("sqlite"), next).statements[0]?.sql).toContain("create table");
  });

  it("aborts rebuild cases", () => {
    const prev = sqliteSnapshot("users", "users", {
      id: id(),
      name: testColumn("name", { notNull: false }),
    });
    const next = {
      ...prev,
      tables: { users: { ...prev.tables.users!, columns: { id: id() } } },
    };

    expect(diffSqlite(prev, next).statements.some((statement) => statement.unsupported)).toBe(true);
  });

  it("emits index drop and create statements for changed multi-column indexes", () => {
    const prev = sqliteSnapshot(
      "userRoles",
      "user_roles",
      { id: id(), a: testColumn("a"), b: testColumn("b") },
      { indexes: [{ name: "user_roles_a_b_idx", unique: false, fields: ["a", "b"] }] },
    );
    const next = {
      ...prev,
      tables: {
        userRoles: {
          ...prev.tables.userRoles!,
          indexes: [{ name: "user_roles_a_b_idx", unique: false, fields: ["b", "a"] }],
        },
      },
    };

    expect(diffSqlite(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "user_roles_a_b_idx"`,
      `create index "user_roles_a_b_idx" on "user_roles" ("b", "a")`,
    ]);
  });

  it("emits index drop and create statements for changed indexes", () => {
    const prev = sqliteSnapshot(
      "tasks",
      "tasks",
      { id: id(), title: testColumn("title") },
      { indexes: [{ name: "tasks_title_idx", unique: false, fields: ["title"] }] },
    );
    const next = {
      ...prev,
      tables: {
        tasks: {
          ...prev.tables.tasks!,
          indexes: [{ name: "tasks_title_idx", unique: true, fields: ["title"] }],
        },
      },
    };

    expect(diffSqlite(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "tasks_title_idx"`,
      `create unique index "tasks_title_idx" on "tasks" ("title")`,
    ]);
  });

  it("creates prefixed indexes on prefixed tables", () => {
    const next = sqliteSnapshot(
      "users",
      "app_users",
      { id: id(), email: testColumn("email") },
      { indexes: [{ name: "app_users_email_idx", unique: false, fields: ["email"] }] },
    );

    expect(
      diffSqlite(emptySnapshot("sqlite"), next).statements.map((statement) => statement.sql),
    ).toContain(`create index "app_users_email_idx" on "app_users" ("email")`);
  });

  it("matches live prefixed indexes during push diffs", () => {
    const live = sqliteSnapshot(
      "app_users",
      "app_users",
      { id: id(), email: testColumn("email") },
      { indexes: [{ name: "app_users_email_idx", unique: false, fields: ["email"] }] },
    );
    const desired = { ...live, tables: { users: live.tables.app_users! } };

    expect(diffSqlite(live, desired).statements).toEqual([]);
  });
});
