import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { pg, schema, sqlite } from "../index";
import { generateMigration } from "./generate";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

const temp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "effect-sql-kit-"));
  dirs.push(dir);
  return dir;
};

describe("generateMigration", () => {
  it("creates 0001 migration modules", async () => {
    const out = await temp();
    class User extends sqlite.Class<User>("User")({
      table: "users",
      fields: { id: sqlite.text().primaryKey() },
    }) {}
    const result = await generateMigration({
      config: {
        dialect: "sqlite",
        out,
        tablePrefix: "",
        migrations: { table: "effect_sql_migrations", schema: "public" },
        breakpoints: true,
      },
      schema: schema({ users: User }),
      name: "initial",
    });

    expect(result.tag).toBe("0001_initial");
    expect(await readdir(out)).toContain("0001_initial.ts");
    const migration = await readFile(join(out, "0001_initial.ts"), "utf8");
    expect(migration).toContain("SqlClient.SqlClient");
    expect(migration).toContain("sql.unsafe");
  });

  it("writes nothing when there are no changes", async () => {
    const out = await temp();
    const users = pg.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: { id: pg.uuid().primaryKey() },
      },
    );
    const config = {
      dialect: "postgresql" as const,
      out,
      tablePrefix: "",
      migrations: { table: "effect_sql_migrations", schema: "public" },
      breakpoints: true,
    };
    await generateMigration({ config, schema: schema({ users }), name: "initial" });
    const result = await generateMigration({ config, schema: schema({ users }), name: "again" });

    expect(result.written).toBe(false);
  });

  it("uses config table prefix for generated migration SQL", async () => {
    const out = await temp();
    const users = sqlite.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: { id: sqlite.text().primaryKey() },
      },
    );

    const result = await generateMigration({
      config: {
        dialect: "sqlite",
        out,
        tablePrefix: "app",
        migrations: { table: "app_effect_sql_migrations", schema: "public" },
        breakpoints: true,
      },
      schema: schema({ users }),
      name: "initial",
    });

    const migration = await readFile(join(out, `${result.tag}.ts`), "utf8");
    expect(migration).toContain('create table "app_users"');
  });
});
