import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { pg, schema, sqlite } from "./index";
import { snapshotSchema } from "./snapshot";

describe("column defaults", () => {
  it("uses SQL column builders as model and DDL source", () => {
    const ItemId = Schema.String.pipe(Schema.brand("ItemId"));

    class Item extends pg.Class<Item>("Item")({
      table: "items",
      fields: {
        id: pg.uuid().primaryKey().decodeTo(ItemId),
        count: pg.integer().notNull(),
        active: pg.boolean().notNull(),
      },
    }) {}

    const snapshot = snapshotSchema(schema({ items: Item }));

    expect(snapshot.tables.items?.columns.id?.kind).toBe("uuid");
    expect(snapshot.tables.items?.columns.count?.kind).toBe("integer");
    expect(snapshot.tables.items?.columns.active?.kind).toBe("boolean");
  });

  it("supports SQLite column overrides", () => {
    const Model = {
      fields: {
        id: Schema.String,
        createdAt: Schema.Number,
      },
    };
    const table = sqlite.table(Model, {
      name: "events",
      columns: {
        id: sqlite.text().primaryKey(),
        createdAt: sqlite.integer("created_at", { mode: "timestamp" }).notNull(),
      },
    });
    const snapshot = snapshotSchema(schema({ table }));

    expect(snapshot.tables.table?.columns.createdAt?.name).toBe("created_at");
    expect(snapshot.tables.table?.columns.createdAt?.kind).toBe("integer");
  });
});
