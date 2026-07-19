import { NodeServices } from "@effect/platform-node";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { pg, schema, sqlite } from "../index";
import { generateMigration, generateMigrationEffect } from "./generate";

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
        prefix: "",
        migrations: { table: "effect_sql_migrations", schema: "public" },
        breakpoints: true,
        extensions: [],
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
      prefix: "",
      migrations: { table: "effect_sql_migrations", schema: "public" },
      breakpoints: true,
      extensions: [],
    };
    await generateMigration({ config, schema: schema({ users }), name: "initial" });
    const result = await generateMigration({ config, schema: schema({ users }), name: "again" });

    expect(result.written).toBe(false);
  });

  it("uses config prefix for generated SQLite migration SQL", async () => {
    const out = await temp();
    const users = sqlite.table(
      { fields: { id: Schema.String, email: Schema.String } },
      {
        name: "users",
        columns: {
          id: sqlite.text().primaryKey(),
          email: sqlite.text().notNull(),
        },
        indexes: [sqlite.index("users_email_idx").on("email")],
      },
    );

    const result = await generateMigration({
      config: {
        dialect: "sqlite",
        out,
        prefix: "app",
        migrations: { table: "app_effect_sql_migrations", schema: "public" },
        breakpoints: true,
        extensions: [],
      },
      schema: schema({ users }),
      name: "initial",
    });

    const migration = await readFile(join(out, `${result.tag}.ts`), "utf8");
    expect(migration).toContain('create table "app_users"');
    expect(migration).toContain('create index "app_users_email_idx"');
  });

  it.live("uses the canonical schema prefix when config prefix is empty", () =>
    Effect.gen(function* () {
      const out = yield* Effect.promise(temp);
      const users = sqlite.table(
        { fields: { id: Schema.String } },
        {
          name: "users",
          columns: { id: sqlite.text().primaryKey() },
        },
      );

      const result = yield* generateMigrationEffect({
        config: {
          dialect: "sqlite",
          out,
          prefix: "",
          migrations: { table: "effect_sql_migrations", schema: "public" },
          breakpoints: true,
          extensions: [],
        },
        schema: schema({ users }, { prefix: "canonical" }),
        name: "initial",
      }).pipe(Effect.provide(NodeServices.layer));

      const migration = yield* Effect.promise(() =>
        readFile(join(out, `${result.tag}.ts`), "utf8"),
      );
      expect(migration).toContain('create table "canonical_users"');
    }),
  );

  it("uses config prefix for generated Postgres migration SQL", async () => {
    const out = await temp();
    const users = pg.table(
      { fields: { id: Schema.String, email: Schema.String } },
      {
        name: "users",
        columns: {
          id: pg.uuid().primaryKey(),
          email: pg.text().notNull(),
        },
        indexes: [pg.index("users_email_idx").on("email")],
      },
    );

    const result = await generateMigration({
      config: {
        dialect: "postgresql",
        out,
        prefix: "app",
        migrations: { table: "app_effect_sql_migrations", schema: "public" },
        breakpoints: true,
        extensions: [],
      },
      schema: schema({ users }),
      name: "initial",
    });

    const migration = await readFile(join(out, `${result.tag}.ts`), "utf8");
    expect(migration).toContain('create table "app_users"');
    expect(migration).toContain('create index "app_users_email_idx"');
  });

  it("writes migrations when only extension statements changed", async () => {
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
      prefix: "",
      migrations: { table: "effect_sql_migrations", schema: "public" },
      breakpoints: true,
      extensions: [
        {
          _tag: "EffectSqlKitMigrationExtension" as const,
          name: "test-extension",
          generate: ({
            previousExtensions,
          }: {
            previousExtensions: Readonly<Record<string, unknown>>;
          }) => ({
            statements:
              previousExtensions["test-extension"] === "done"
                ? []
                : [{ sql: 'select "extension-only";' }],
            snapshot: "done",
          }),
        },
      ],
    };

    await generateMigration({ config, schema: schema({ users }), name: "initial" });
    const result = await generateMigration({
      config,
      schema: schema({ users }),
      name: "extension",
    });

    expect(result.written).toBe(false);
    const extensionConfig = {
      ...config,
      extensions: [
        {
          _tag: "EffectSqlKitMigrationExtension" as const,
          name: "test-extension",
          generate: () => ({
            statements: [{ sql: 'select "extension-only";' }],
            snapshot: "changed",
          }),
        },
      ],
    };
    const extensionResult = await generateMigration({
      config: extensionConfig,
      schema: schema({ users }),
      name: "extension",
    });

    expect(extensionResult.written).toBe(true);
    expect(extensionResult.statements.map((statement) => statement.sql)).toContain(
      'select "extension-only";',
    );
  });

  it("fails duplicate extension names before invoking extensions", async () => {
    const out = await temp();
    const users = pg.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: { id: pg.uuid().primaryKey() },
      },
    );
    let called = false;
    const extension = {
      _tag: "EffectSqlKitMigrationExtension" as const,
      name: "duplicate-extension",
      generate: () => {
        called = true;
        return {
          statements: [{ sql: 'select "extension";' }],
          snapshot: null,
        };
      },
    };

    await expect(
      generateMigration({
        config: {
          dialect: "postgresql",
          out,
          prefix: "",
          migrations: { table: "effect_sql_migrations", schema: "public" },
          breakpoints: true,
          extensions: [extension, extension],
        },
        schema: schema({ users }),
        name: "duplicate",
      }),
    ).rejects.toThrow("duplicate migration extension name(s): duplicate-extension");
    expect(called).toBe(false);
  });

  it("fails invalid extension results before consuming statements", async () => {
    const out = await temp();
    const users = pg.table(
      { fields: { id: Schema.String } },
      {
        name: "users",
        columns: { id: pg.uuid().primaryKey() },
      },
    );

    await expect(
      generateMigration({
        config: {
          dialect: "postgresql",
          out,
          prefix: "",
          migrations: { table: "effect_sql_migrations", schema: "public" },
          breakpoints: true,
          extensions: [
            {
              _tag: "EffectSqlKitMigrationExtension",
              name: "invalid-extension",
              generate: () => ({
                statements: [{ sql: 123 as never }],
                snapshot: null,
              }),
            },
          ],
        },
        schema: schema({ users }),
        name: "invalid",
      }),
    ).rejects.toThrow("invalid migration extension result from invalid-extension");
  });
});
