import { describe, expect, it } from "vitest";
import { diffPg } from "./diff/pg";
import { lowerToDrizzleSnapshot } from "./drizzle-lower";
import { pg, schema } from "./index";
import { emptySnapshot, snapshotSchema, type SchemaSnapshot, type TableSnapshot } from "./snapshot";

const liveTable = (table: TableSnapshot): TableSnapshot => ({
  ...table,
  schema: "public",
  columns: Object.fromEntries(
    Object.values(table.columns).map((column) => [
      column.name,
      {
        ...column,
        fieldName: column.name,
      },
    ]),
  ),
  primaryKey: table.primaryKey.map((field) => table.columns[field]?.name ?? field),
  indexes: table.indexes.map((index) => ({
    ...index,
    fields: index.fields.map((field) => table.columns[field]?.name ?? field),
  })),
});

const liveSnapshot = (snapshot: SchemaSnapshot): SchemaSnapshot => ({
  ...snapshot,
  tables: Object.fromEntries(
    Object.values(snapshot.tables).map((table) => [table.name, liveTable(table)]),
  ),
});

describe("sheet-db-schema parity features", () => {
  it("creates Postgres SQL for representative sheet-db-schema features", () => {
    class ConfigGuild extends pg.Class<ConfigGuild>("ConfigGuild")({
      table: "config_guild",
      fields: {
        guildId: pg.varchar("guild_id").primaryKey(),
        sheetId: pg.varchar("sheet_id"),
        createdAt: pg.timestamp("created_at", { withTimezone: true }).defaultSql("now()").notNull(),
      },
      indexes: [pg.index("config_guild_sheet_id_idx").on("sheetId")],
    }) {}

    class MessageRoomOrder extends pg.Class<MessageRoomOrder>("MessageRoomOrder")({
      table: "message_room_order",
      fields: {
        messageId: pg.varchar("message_id").primaryKey(),
        fills: pg.varchar().array().notNull(),
        payload: pg.jsonb().notNull(),
      },
    }) {}

    class MessageRoomOrderEntry extends pg.Class<MessageRoomOrderEntry>("MessageRoomOrderEntry")({
      table: "message_room_order_entry",
      fields: {
        messageId: pg.varchar("message_id").notNull(),
        rank: pg.integer().notNull(),
        position: pg.integer().notNull(),
        team: pg.varchar().notNull(),
      },
      primaryKey: ["messageId", "rank", "position"],
      indexes: [pg.index("message_room_order_entry_message_id_rank_idx").on("messageId", "rank")],
    }) {}

    const desired = snapshotSchema(
      schema({
        configGuild: ConfigGuild,
        messageRoomOrder: MessageRoomOrder,
        messageRoomOrderEntry: MessageRoomOrderEntry,
      }),
    );
    const statements = diffPg(emptySnapshot("postgresql"), desired).statements.map(
      (statement) => statement.sql,
    );

    expect(statements.join("\n")).toContain('"fills" varchar[] not null');
    expect(statements.join("\n")).toContain('primary key ("message_id", "rank", "position")');
    expect(statements.join("\n")).toContain(
      'create index "message_room_order_entry_message_id_rank_idx"',
    );
  });

  it("treats SQL-name keyed live snapshots as equivalent", () => {
    class ConfigGuild extends pg.Class<ConfigGuild>("ConfigGuild")({
      table: "config_guild",
      fields: {
        guildId: pg.varchar("guild_id").primaryKey(),
        sheetId: pg.varchar("sheet_id"),
        createdAt: pg.timestamp("created_at", { withTimezone: true }).defaultSql("now()").notNull(),
      },
      indexes: [pg.index("config_guild_sheet_id_idx").on("sheetId")],
    }) {}

    const desired = snapshotSchema(schema({ configGuild: ConfigGuild }));
    const live = liveSnapshot(desired);

    expect(diffPg(live, desired).statements).toEqual([]);
  });

  it("lowers representative Postgres metadata to a Drizzle snapshot", async () => {
    class DispatchJob extends pg.Class<DispatchJob>("DispatchJob")({
      table: "sheet_apis_dispatch_jobs",
      fields: {
        dispatchRequestId: pg.text("dispatch_request_id").primaryKey(),
        status: pg.text().notNull(),
        updatedAt: pg.timestamp("updated_at", { withTimezone: true }).defaultSql("now()").notNull(),
        payload: pg.jsonb().notNull(),
        tags: pg.varchar().array().notNull(),
      },
      indexes: [
        pg.index("sheet_apis_dispatch_jobs_status_updated_at_idx").on("status", "updatedAt"),
      ],
    }) {}

    await expect(
      lowerToDrizzleSnapshot(schema({ dispatchJob: DispatchJob })),
    ).resolves.toMatchObject({
      dialect: "postgresql",
    });
  });
});
