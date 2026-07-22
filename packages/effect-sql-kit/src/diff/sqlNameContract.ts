import { expect, it } from "@effect/vitest";
import type { SchemaSnapshot } from "../snapshot";
import { testColumn, testSnapshot, testTable } from "./testFixtures";

interface DiffResult {
  readonly statements: ReadonlyArray<{ readonly sql: string }>;
}

interface SqlNameContractOptions {
  readonly dialect: SchemaSnapshot["dialect"];
  readonly idKind: string;
  readonly diff: (previous: SchemaSnapshot, next: SchemaSnapshot) => DiffResult;
}

export const testSqlNameContract = ({ dialect, idKind, diff }: SqlNameContractOptions) => {
  const idColumn = (fieldName = "id", name = fieldName) =>
    testColumn(fieldName, { name, kind: idKind, primaryKey: true });
  const snapshot = (
    tableKey: string,
    name: string,
    columns: Parameters<typeof testTable>[2],
    options: Parameters<typeof testTable>[3] = {},
  ) => testSnapshot(dialect, tableKey, testTable(dialect, name, columns, options));

  it("matches existing columns by SQL name", () => {
    const prev = snapshot("users", "users", {
      id: idColumn(),
      display_name: testColumn("display_name"),
      ...(dialect === "sqlite" ? { active: testColumn("active", { kind: "integer" }) } : {}),
    });
    const next = snapshot("users", "users", {
      id: idColumn(),
      displayName: testColumn("displayName", { name: "display_name" }),
      ...(dialect === "sqlite"
        ? { active: testColumn("active", { kind: "integer", config: { mode: "boolean" } }) }
        : {}),
    });

    expect(diff(prev, next).statements).toEqual([]);
  });

  it("matches primary keys by SQL name", () => {
    const prev = snapshot(
      "users",
      "users",
      { user_id: idColumn("user_id") },
      { primaryKey: ["user_id"] },
    );
    const next = snapshot(
      "users",
      "users",
      { userId: idColumn("userId", "user_id") },
      { primaryKey: ["userId"] },
    );

    expect(diff(prev, next).statements).toEqual([]);
  });

  it("matches composite primary keys by SQL names", () => {
    const prev = snapshot(
      "userRoles",
      "user_roles",
      {
        user_id: idColumn("user_id"),
        role_id: idColumn("role_id"),
      },
      { primaryKey: ["user_id", "role_id"] },
    );
    const next = snapshot(
      "userRoles",
      "user_roles",
      {
        userId: idColumn("userId", "user_id"),
        roleId: idColumn("roleId", "role_id"),
      },
      { primaryKey: ["userId", "roleId"] },
    );

    expect(diff(prev, next).statements).toEqual([]);
  });

  it("matches indexes by SQL column names", () => {
    const prev = snapshot(
      "tasks",
      "tasks",
      { id: idColumn(), account_id: testColumn("account_id", { kind: idKind }) },
      { indexes: [{ name: "tasks_account_id_idx", unique: false, fields: ["account_id"] }] },
    );
    const next = snapshot(
      "tasks",
      "tasks",
      { id: idColumn(), accountId: testColumn("accountId", { name: "account_id", kind: idKind }) },
      { indexes: [{ name: "tasks_account_id_idx", unique: false, fields: ["accountId"] }] },
    );

    expect(diff(prev, next).statements).toEqual([]);
  });

  it("matches multi-column indexes by SQL column names", () => {
    const prev = snapshot(
      "userRoles",
      "user_roles",
      { id: idColumn(), a: testColumn("a"), b: testColumn("b") },
      { indexes: [{ name: "user_roles_a_b_idx", unique: false, fields: ["a", "b"] }] },
    );
    const next = snapshot(
      "userRoles",
      "user_roles",
      {
        id: idColumn(),
        aField: testColumn("aField", { name: "a" }),
        bField: testColumn("bField", { name: "b" }),
      },
      {
        indexes: [{ name: "user_roles_a_b_idx", unique: false, fields: ["aField", "bField"] }],
      },
    );

    expect(diff(prev, next).statements).toEqual([]);
  });
};
