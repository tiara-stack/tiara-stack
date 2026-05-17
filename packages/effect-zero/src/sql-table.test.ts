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
    expect(zeroTable.columns?.id).toMatchObject({
      name: "id",
      serverName: undefined,
    });
    expect(zeroTable.columns?.orgId).toMatchObject({
      name: "org_id",
      serverName: "org_id",
      type: "string",
      optional: false,
    });
  });

  it("maps SQL array columns to Zero json columns", () => {
    class Message extends pg.Class<Message>("Message")({
      table: "messages",
      fields: {
        id: pg.uuid().primaryKey(),
        fills: pg.varchar().array().notNull(),
      },
    }) {}

    const zeroTable = fromSqlTable(Message);
    expect(zeroTable.columns?.fills).toMatchObject({
      name: "fills",
      type: "json",
      optional: false,
    });
  });

  it("maps SQL date/time columns to Zero number columns", () => {
    class Event extends pg.Class<Event>("Event")({
      table: "events",
      fields: {
        id: pg.uuid().primaryKey(),
        eventDate: pg.date("event_date"),
        createdAt: pg.timestamp("created_at", { withTimezone: true }),
      },
    }) {}

    const zeroTable = fromSqlTable(Event);
    expect(zeroTable.columns?.eventDate).toMatchObject({
      type: "number",
      optional: true,
    });
    expect(zeroTable.columns?.createdAt).toMatchObject({
      type: "number",
      optional: true,
    });
  });

  it("matches drizzle-zero optional inference for SQL table columns", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey().defaultRandom(),
        name: pg.text().notNull(),
        nickname: pg.text(),
        createdAt: pg.timestamp("created_at", { withTimezone: true }).defaultSql("now()").notNull(),
      },
    }) {}

    const zeroTable = fromSqlTable(User);
    expect(zeroTable.columns?.id).toMatchObject({
      optional: false,
    });
    expect(zeroTable.columns?.name).toMatchObject({
      optional: false,
    });
    expect(zeroTable.columns?.nickname).toMatchObject({
      optional: true,
    });
    expect(zeroTable.columns?.createdAt).toMatchObject({
      type: "number",
      optional: true,
    });
  });

  it("accepts SQL DSL tables directly in schema()", () => {
    class User extends pg.Class<User>("User")({
      table: "users",
      fields: {
        id: pg.uuid().primaryKey(),
      },
    }) {}

    expect(schema({ users: User }).tables.users).toMatchObject({
      name: "users",
      serverName: "users",
      key: ["id"],
    });
  });

  it("uses the schema object key as the Zero table name for SQL DSL tables", () => {
    class User extends pg.Class<User>("User")({
      table: "app_users",
      fields: {
        id: pg.uuid().primaryKey(),
      },
    }) {}

    expect(schema({ users: User }).tables.users).toMatchObject({
      name: "users",
      serverName: "app_users",
      key: ["id"],
    });
  });
});
