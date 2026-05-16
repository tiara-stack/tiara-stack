import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { pg, schema, sqlite } from "./index";
import { lowerToDrizzleExports, lowerToDrizzleSnapshot } from "./drizzle-lower";

describe("Drizzle lowering", () => {
  it("lowers Postgres metadata to Drizzle exports", async () => {
    const users = pg.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: { id: pg.uuid().primaryKey() },
      },
    );

    const exports = await lowerToDrizzleExports(schema({ users }));
    expect(exports.users).toBeTruthy();
    await expect(lowerToDrizzleSnapshot(schema({ users }))).resolves.toMatchObject({
      dialect: "postgresql",
    });
  });

  it("lowers SQLite metadata to Drizzle exports", async () => {
    const users = sqlite.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: { id: sqlite.text().primaryKey() },
      },
    );

    const exports = await lowerToDrizzleExports(schema({ users }));
    expect(exports.users).toBeTruthy();
    await expect(lowerToDrizzleSnapshot(schema({ users }))).resolves.toMatchObject({
      dialect: "sqlite",
    });
  });

  it("lowers SQLite defaults to Drizzle columns", async () => {
    class User extends sqlite.Class<User>("User")({
      table: "users",
      fields: {
        id: sqlite.text().primaryKey(),
        active: sqlite.integer("active", { mode: "boolean" }).default(1).notNull(),
        createdAt: sqlite.integer("created_at").defaultSql("(unixepoch())").notNull(),
      },
    }) {}

    const exports = await lowerToDrizzleExports(schema({ users: User }));
    const users = exports.users as {
      readonly active: { readonly default: unknown; readonly hasDefault: boolean };
      readonly createdAt: { readonly default: unknown; readonly hasDefault: boolean };
    };

    expect(users.active.default).toBe(1);
    expect(users.active.hasDefault).toBe(true);
    expect(users.createdAt.default).toHaveProperty("queryChunks");
    expect(users.createdAt.hasDefault).toBe(true);
  });

  it("lowers SQLite composite primary keys as table constraints", async () => {
    const memberships = sqlite.table(
      { fields: { userId: Schema.String, orgId: Schema.String } },
      {
        name: "memberships",
        columns: {
          userId: sqlite.text("user_id").notNull(),
          orgId: sqlite.text("org_id").notNull(),
        },
        primaryKey: ["userId", "orgId"],
      },
    );

    const lowered = await lowerToDrizzleSnapshot(schema({ memberships }));
    expect(lowered).toMatchObject({ dialect: "sqlite" });

    const table = (
      lowered as { readonly tables?: Record<string, { readonly primaryKey?: unknown }> }
    ).tables?.memberships;
    expect(table?.primaryKey).toEqual(["userId", "orgId"]);
  });

  it("rejects malformed Postgres array metadata", async () => {
    const users = pg.table(
      { fields: { id: Schema.String, tags: Schema.Array(Schema.String) } },
      {
        name: "users",
        columns: {
          id: pg.uuid().primaryKey(),
          tags: pg.varchar().array().notNull(),
        },
      },
    );
    const malformedUsers = {
      ...users,
      columns: {
        ...users.columns,
        tags: {
          ...users.columns.tags,
          data: {
            ...users.columns.tags.data,
            config: {},
          },
        },
      },
    } as typeof users;

    await expect(lowerToDrizzleExports(schema({ users: malformedUsers }))).rejects.toThrow(
      "effect-sql-kit: array column tags has invalid elementKind undefined",
    );

    const invalidKindUsers = {
      ...users,
      columns: {
        ...users.columns,
        tags: {
          ...users.columns.tags,
          data: {
            ...users.columns.tags.data,
            config: { elementKind: "unsupported" },
          },
        },
      },
    } as typeof users;

    await expect(lowerToDrizzleExports(schema({ users: invalidKindUsers }))).rejects.toThrow(
      "effect-sql-kit: array column tags has invalid elementKind unsupported",
    );
  });

  it("rejects Postgres indexes with missing fields", async () => {
    const users = pg.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: { id: pg.uuid().primaryKey() },
        indexes: [pg.index("users_missing_idx").on("missing")],
      },
    );

    await expect(lowerToDrizzleExports(schema({ users }))).rejects.toThrow(
      "effect-sql-kit: users index users_missing_idx references missing field missing",
    );
  });

  it("rejects SQLite indexes with missing fields", async () => {
    const users = sqlite.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: { id: sqlite.text().primaryKey() },
        indexes: [sqlite.index("users_missing_idx").on("missing")],
      },
    );

    await expect(lowerToDrizzleExports(schema({ users }))).rejects.toThrow(
      "effect-sql-kit: users index users_missing_idx references missing field missing",
    );
  });
});
