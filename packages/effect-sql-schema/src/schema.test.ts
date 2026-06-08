import { Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { pg, schema, sqlite } from "./index";
import { snapshotSchema } from "./snapshot";

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
