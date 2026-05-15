import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { pg, schema, sqlite } from "./index";
import { snapshotSchema } from "./snapshot";

const User = {
  fields: {
    id: Schema.String,
    name: Schema.String,
    orgId: Schema.String,
  },
};

describe("table DSL", () => {
  it("creates integrated Postgres model metadata", () => {
    const UserId = Schema.String.pipe(Schema.brand("UserId"));

    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey().defaultRandom().decodeTo(UserId),
        name: pg.text().notNull(),
        orgId: pg.uuid("org_id").notNull(),
      },
      indexes: [pg.index("users_org_id_idx").on("orgId")],
    }) {}

    expect(User.sqlName).toBe("users");
    expect(User.primaryKey).toEqual(["id"]);
    expect(User.columns.orgId.data.name).toBe("org_id");
    expect(snapshotSchema(schema({ users: User })).tables.users?.indexes[0]?.name).toBe(
      "users_org_id_idx",
    );
  });

  it("creates integrated SQLite model metadata", () => {
    class User extends sqlite.Class<User>("User")({
      table: "users",
      fields: {
        id: sqlite.text().primaryKey(),
        name: sqlite.text().notNull(),
      },
    }) {}

    expect(User.dialect).toBe("sqlite");
    expect(User.columns.id.data.primaryKey).toBe(true);
  });

  it("creates Postgres table metadata", () => {
    const users = pg.table(User, {
      name: "users",
      columns: {
        id: pg.uuid().primaryKey().defaultRandom(),
        name: pg.text().notNull(),
        orgId: pg.uuid("org_id").notNull(),
      },
      indexes: [pg.index("users_org_id_idx").on("orgId")],
    });

    expect(users.name).toBe("users");
    expect(users.primaryKey).toEqual(["id"]);
    expect(users.columns.orgId.data.name).toBe("org_id");
    expect(snapshotSchema(schema({ users })).tables.users?.indexes[0]?.name).toBe(
      "users_org_id_idx",
    );
  });

  it("creates SQLite table metadata", () => {
    const users = sqlite.table(User, {
      name: "users",
      columns: {
        id: sqlite.text().primaryKey(),
        name: sqlite.text().notNull(),
        orgId: sqlite.text("org_id").notNull(),
      },
    });

    expect(users.dialect).toBe("sqlite");
    expect(users.columns.id.data.primaryKey).toBe(true);
  });

  it("requires a primary key", () => {
    expect(() =>
      pg.table(User, {
        name: "users",
        columns: {
          id: pg.uuid(),
          name: pg.text().notNull(),
          orgId: pg.uuid("org_id").notNull(),
        },
      }),
    ).toThrow(/primary key/);
  });
});
