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
});
