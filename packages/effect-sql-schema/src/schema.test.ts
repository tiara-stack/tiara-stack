import { Schema } from "effect";
import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { pg, schema, sqlite } from "./index.mjs";
import { snapshotSchema } from "./snapshot.mjs";
import type { EffectSqlColumn, TableOptions } from "./types.js";

describe("effect-sql-schema", () => {
  it("defines Postgres model classes", () => {
    const UserId = Schema.String.pipe(Schema.brand("UserId"));

    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey().defaultRandom().decodeTo(UserId),
        name: pg.text().notNull(),
        age: pg.integer(),
        orgId: pg.uuid("org_id").notNull(),
      },
      indexes: [pg.index("users_org_id_idx").on("orgId")],
    }) {}

    const snapshot = snapshotSchema(schema({ users: User }));
    expect(snapshot.tables.users?.columns.id?.kind).toBe("uuid");
    expect(snapshot.tables.users?.columns.id?.notNull).toBe(true);
    expect(snapshot.tables.users?.columns.id?.defaultSql).toBe("gen_random_uuid()");
    expect(snapshot.tables.users?.columns.orgId?.name).toBe("org_id");
    expect(snapshot.tables.users?.indexes[0]?.name).toBe("users_org_id_idx");
    expect(
      (User as unknown as { readonly fields: Record<string, unknown> }).fields.id,
    ).toBeDefined();
    expectTypeOf(User.columns.id.data.fieldSchema).toEqualTypeOf<typeof UserId>();
    expectTypeOf(User.fields.id).toEqualTypeOf<typeof UserId>();
    expectTypeOf(User.fields.name).toEqualTypeOf<typeof Schema.String>();
    expectTypeOf(User.fields.age).toEqualTypeOf<Schema.NullOr<typeof Schema.Int>>();
  });

  it("preserves fluent column transition types", () => {
    const column = pg.integer();

    expectTypeOf(column.notNull()).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "integer", typeof Schema.Int, true, "none">
    >();
    expectTypeOf(column.primaryKey()).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "integer", typeof Schema.Int, true, "none">
    >();
    expectTypeOf(column.default(0)).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "integer", typeof Schema.Int, false, "database">
    >();
    expectTypeOf(column.defaultSql("0")).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "integer", typeof Schema.Int, false, "database">
    >();
    expectTypeOf(column.defaultRandom()).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "integer", typeof Schema.Int, false, "database">
    >();
    expectTypeOf(column.generatedByDatabase()).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "integer", typeof Schema.Int, false, "database">
    >();
    expectTypeOf(column.generatedByApp()).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "integer", typeof Schema.Int, false, "application">
    >();
    expectTypeOf(column.decodeTo(Schema.String)).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "integer", typeof Schema.String, false, "none">
    >();
  });

  it("preserves SQLite integer mode types", () => {
    const booleanColumn = sqlite.integer("active", { mode: "boolean" });
    const timestampColumn = sqlite.integer({ mode: "timestamp" });
    const timestampMillisecondsColumn = sqlite.integer("updatedAt", { mode: "timestamp_ms" });
    const numberColumn = sqlite.integer({ mode: "number" });
    const defaultColumn = sqlite.integer();

    expectTypeOf(booleanColumn.data.fieldSchema).toEqualTypeOf<typeof Schema.Boolean>();
    expectTypeOf(timestampColumn.data.fieldSchema).toEqualTypeOf<typeof Schema.Number>();
    expectTypeOf(timestampMillisecondsColumn.data.fieldSchema).toEqualTypeOf<
      typeof Schema.Number
    >();
    expectTypeOf(numberColumn.data.fieldSchema).toEqualTypeOf<typeof Schema.Number>();
    expectTypeOf(defaultColumn.data.fieldSchema).toEqualTypeOf<typeof Schema.Number>();
    expectTypeOf<{ readonly mode: "unsupported" }>().not.toExtend<
      NonNullable<Parameters<typeof sqlite.integer>[1]>
    >();
  });

  it("makes declared primary-key fields non-null before constructing the model", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid(),
        name: pg.text(),
      },
      primaryKey: ["id"],
    }) {}

    expectTypeOf(User.fields.id).toEqualTypeOf<typeof Schema.String>();
    expectTypeOf(User.fields.name).toEqualTypeOf<Schema.NullOr<typeof Schema.String>>();
    expectTypeOf(User.columns.id).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "uuid", typeof Schema.String, true, "none">
    >();
  });

  it("marks database generated fields as omitted from inserts", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey().defaultRandom(),
        name: pg.text().notNull(),
      },
    }) {}

    expect(Object.keys(User.insert.fields)).toEqual(["name"]);
  });

  it("keeps application generated fields in database variants and out of JSON writes", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey(),
        name: pg.text().notNull(),
        createdAt: pg.timestamp("created_at").notNull().generatedByApp(),
      },
    }) {}

    expect(Object.keys(User.insert.fields)).toEqual(["id", "name", "createdAt"]);
    expect(Object.keys(User.update.fields)).toEqual(["id", "name", "createdAt"]);
    expect(Object.keys(User.json.fields)).toEqual(["id", "name", "createdAt"]);
    expect(Object.keys(User.jsonCreate.fields)).toEqual(["id", "name"]);
    expect(Object.keys(User.jsonUpdate.fields)).toEqual(["id", "name"]);
  });

  it("defines Postgres array columns", () => {
    class Message extends pg.Class<Message>("Message")({
      table: "messages",
      fields: {
        id: pg.varchar("message_id").primaryKey(),
        fills: pg.varchar().array().notNull(),
      },
    }) {}

    const snapshot = snapshotSchema(schema({ messages: Message }));
    expect(snapshot.tables.messages?.columns.fills).toMatchObject({
      kind: "array",
      name: "fills",
      notNull: true,
      config: {
        elementKind: "varchar",
      },
    });
  });

  it("defines SQLite model classes", () => {
    class User extends sqlite.Class<User>("User")({
      table: "users",
      fields: {
        id: sqlite.text().primaryKey(),
        name: sqlite.text().notNull(),
        createdAt: sqlite.integer("created_at", { mode: "timestamp" }).notNull(),
        active: sqlite.integer("active", { mode: "boolean" }).notNull(),
      },
    }) {}

    const snapshot = snapshotSchema(schema({ users: User }));
    expect(snapshot.dialect).toBe("sqlite");
    expect(snapshot.tables.users?.columns.createdAt?.name).toBe("created_at");
    expect((User as unknown as { readonly fields: Record<string, unknown> }).fields.active).toBe(
      Schema.Boolean,
    );
  });

  it("rejects raw Effect schemas in class fields", () => {
    expect(() =>
      pg.Class("User")({
        table: "users",
        fields: {
          id: Schema.String,
        } as never,
      }),
    ).toThrow(/column/);
  });

  it("defines Postgres tables", () => {
    const users = pg.table(
      { fields: { id: Schema.String, name: Schema.String } },
      {
        name: "users",
        columns: {
          id: pg.uuid().primaryKey().defaultRandom(),
          name: pg.text().notNull(),
        },
      },
    );

    const snapshot = snapshotSchema(schema({ users }));
    expect(snapshot.tables.users?.columns.id?.kind).toBe("uuid");
    expect(snapshot.tables.users?.columns.id?.defaultSql).toBe("gen_random_uuid()");
    expectTypeOf(users.columns.id).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "uuid", typeof Schema.String, true, "database">
    >();
    expectTypeOf(users.columns.name).toEqualTypeOf<
      EffectSqlColumn<"postgresql", "text", typeof Schema.String, true, "none">
    >();
  });

  it("keeps table columns tied to model fields", () => {
    const model = { fields: { id: Schema.String, ignored: Schema.String } };
    const id = pg.uuid().primaryKey();
    const users = pg.table(model, {
      name: "users",
      columns: {
        id,
        ignored: false,
      },
    });

    expect(users.columns).not.toHaveProperty("ignored");
    expectTypeOf<keyof typeof users.columns>().toEqualTypeOf<"id">();
    expectTypeOf(users.columns.id).toEqualTypeOf<typeof id>();

    type UnknownColumnOptions = TableOptions<
      typeof model,
      { readonly id: typeof id; readonly unknown: typeof id }
    >;
    expectTypeOf<{
      readonly columns: { readonly id: typeof id; readonly unknown: typeof id };
    }>().not.toExtend<UnknownColumnOptions>();
  });

  it("defines SQLite tables", () => {
    const users = sqlite.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: {
          id: sqlite.text().primaryKey(),
        },
      },
    );

    expect(snapshotSchema(schema({ users })).dialect).toBe("sqlite");
    expectTypeOf(users.columns.id).toEqualTypeOf<
      EffectSqlColumn<"sqlite", "text", typeof Schema.String, true, "none">
    >();
  });

  it("prefixes table names in schema snapshots", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey(),
      },
    }) {}

    const snapshot = snapshotSchema(schema({ users: User }, { prefix: "app" }));

    expect(snapshot.tables.users?.name).toBe("app_users");
  });

  it("prefixes index names in schema snapshots", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey(),
        email: pg.text().notNull(),
        name: pg.text().notNull(),
      },
      indexes: [
        pg.index("users_email_idx").on("email"),
        pg.uniqueIndex("users_name_idx").on("name"),
      ],
    }) {}

    const snapshot = snapshotSchema(schema({ users: User }, { prefix: "app_" }));

    expect(snapshot.tables.users?.indexes).toEqual([
      { name: "app_users_email_idx", unique: false, fields: ["email"] },
      { name: "app_users_name_idx", unique: true, fields: ["name"] },
    ]);
  });

  it("prefixes SQLite index names in schema snapshots", () => {
    class User extends sqlite.Class<User>("User")({
      table: "users",
      fields: {
        id: sqlite.text().primaryKey(),
        email: sqlite.text().notNull(),
      },
      indexes: [sqlite.index("users_email_idx").on("email")],
    }) {}

    const snapshot = snapshotSchema(schema({ users: User }, { prefix: "app" }));

    expect(snapshot.tables.users?.indexes[0]?.name).toBe("app_users_email_idx");
  });

  it("prefixes referenced table names in schema snapshots", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey(),
      },
    }) {}

    class Post extends pg.Class<Post>("Post")({
      table: "posts",
      fields: {
        id: pg.uuid().primaryKey(),
        userId: pg
          .uuid("user_id")
          .notNull()
          .references(() => User.columns.id),
      },
    }) {}

    const snapshot = snapshotSchema(schema({ users: User, posts: Post }, { prefix: "app" }));

    expect(snapshot.tables.posts?.columns.userId?.references?.table).toBe("app_users");
  });
});
