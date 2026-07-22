import { describe, expect, it } from "@effect/vitest";
import { emptySnapshot } from "../snapshot";
import { diffPg } from "./pg";
import { testSnapshot, testTable, testColumn } from "./testFixtures";
import { testSqlNameContract } from "./sqlNameContract";

const id = () => testColumn("id", { kind: "uuid", primaryKey: true });
const pgSnapshot = (
  tableKey: string,
  name: string,
  columns: Parameters<typeof testTable>[2],
  options: Parameters<typeof testTable>[3] = {},
) => testSnapshot("postgresql", tableKey, testTable("postgresql", name, columns, options));

describe("Postgres push diff", () => {
  testSqlNameContract({ dialect: "postgresql", idKind: "uuid", diff: diffPg });

  it("creates tables and marks drops as destructive", () => {
    const next = pgSnapshot("users", "users", { id: id() });
    const create = diffPg(emptySnapshot("postgresql"), next);
    const drop = diffPg(next, emptySnapshot("postgresql"));

    expect(create.statements[0]?.sql).toContain('create table "public"."users"');
    expect(drop.statements[0]?.destructive).toBe(true);
  });

  it("emits index drop and create statements for changed indexes", () => {
    const prev = pgSnapshot(
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

    expect(diffPg(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "public"."tasks_title_idx"`,
      `create unique index "tasks_title_idx" on "public"."tasks" ("title")`,
    ]);
  });

  it("does not explicitly drop indexes removed by dropped columns", () => {
    const prev = pgSnapshot(
      "tasks",
      "tasks",
      { id: id(), title: testColumn("title") },
      { indexes: [{ name: "tasks_title_idx", unique: false, fields: ["title"] }] },
    );
    const next = {
      ...prev,
      tables: {
        tasks: { ...prev.tables.tasks!, columns: { id: id() }, indexes: [] },
      },
    };

    expect(diffPg(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `alter table "public"."tasks" drop column "title"`,
    ]);
  });

  it("schema-qualifies removed index drops", () => {
    const prev = pgSnapshot(
      "tasks",
      "tasks",
      { id: id(), title: testColumn("title") },
      { indexes: [{ name: "tasks_title_idx", unique: false, fields: ["title"] }] },
    );
    const next = {
      ...prev,
      tables: { tasks: { ...prev.tables.tasks!, indexes: [] } },
    };

    expect(diffPg(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "public"."tasks_title_idx"`,
    ]);
  });

  it("treats same-field SQL name changes as manual renames", () => {
    const prev = pgSnapshot("users", "users", {
      id: id(),
      displayName: testColumn("displayName", { name: "display_name", notNull: false }),
    });
    const next = {
      ...prev,
      tables: {
        users: {
          ...prev.tables.users!,
          columns: {
            id: id(),
            displayName: testColumn("displayName", { name: "full_name", notNull: false }),
          },
        },
      },
    };

    expect(diffPg(prev, next).statements).toEqual([
      { sql: `alter table "public"."users" add column "full_name" text` },
      {
        sql: "",
        unsupported: true,
        reason: `column rename on users.displayName from "display_name" to "full_name" may require a manual migration`,
      },
    ]);
  });

  it("uses the previous schema for existing index drops", () => {
    const prev = pgSnapshot(
      "tasks",
      "tasks",
      { id: id(), title: testColumn("title") },
      {
        schema: "old_schema",
        indexes: [{ name: "tasks_title_idx", unique: false, fields: ["title"] }],
      },
    );
    const next = {
      ...prev,
      tables: {
        tasks: {
          ...prev.tables.tasks!,
          schema: "new_schema",
          indexes: [{ name: "tasks_title_idx", unique: true, fields: ["title"] }],
        },
      },
    };

    expect(diffPg(prev, next).statements.map((statement) => statement.sql)).toEqual([
      `drop index "old_schema"."tasks_title_idx"`,
      `create unique index "tasks_title_idx" on "new_schema"."tasks" ("title")`,
    ]);
  });

  it("creates prefixed indexes on prefixed tables", () => {
    const next = pgSnapshot(
      "users",
      "app_users",
      { id: id(), email: testColumn("email") },
      { indexes: [{ name: "app_users_email_idx", unique: false, fields: ["email"] }] },
    );

    expect(
      diffPg(emptySnapshot("postgresql"), next).statements.map((statement) => statement.sql),
    ).toContain(`create index "app_users_email_idx" on "public"."app_users" ("email")`);
  });

  it("matches live prefixed indexes during push diffs", () => {
    const live = pgSnapshot(
      "app_users",
      "app_users",
      { id: id(), email: testColumn("email") },
      { indexes: [{ name: "app_users_email_idx", unique: false, fields: ["email"] }] },
    );
    const desired = { ...live, tables: { users: live.tables.app_users! } };

    expect(diffPg(live, desired).statements).toEqual([]);
  });
});
