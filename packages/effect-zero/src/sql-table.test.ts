import { describe, expect, it } from "vitest";
import { pg } from "effect-sql-schema";
import { fromSqlTable, schema } from "./index";

describe("effect-sql-schema adapter", () => {
  it("converts SQL DSL tables into Zero tables", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey(),
        orgId: pg.uuid("org_id").notNull(),
      },
    }) {}

    const zeroTable = fromSqlTable(User);
    expect(zeroTable.key).toEqual(["id"]);
    expect(zeroTable.columns?.orgId).toMatchObject({
      name: "org_id",
      type: "string",
      optional: false,
    });
  });

  it("accepts SQL DSL tables directly in schema()", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey(),
      },
    }) {}

    expect(schema({ users: User }).tables.users.key).toEqual(["id"]);
  });
});
