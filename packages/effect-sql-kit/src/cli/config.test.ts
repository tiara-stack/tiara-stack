import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Result } from "effect";
import { loadConfigEffect, loadSchemaEffect } from "./config";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

const withTempDir = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "effect-sql-kit-cli-"))),
    f,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

const linkNodeModules = (dir: string) =>
  Effect.promise(() =>
    symlink(join(packageRoot, "node_modules"), join(dir, "node_modules"), "dir"),
  );

describe("CLI config effects", () => {
  it.effect("loads default exported config and applies flags", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const configPath = join(dir, "effect-sql.config.ts");
        yield* Effect.promise(() =>
          writeFile(
            configPath,
            `export default { dialect: "sqlite", out: "./old", dbCredentials: { url: "old.db" } };
`,
          ),
        );

        const loaded = yield* loadConfigEffect(configPath, { out: "./new" });
        expect(loaded.config.out).toBe("./new");
        expect(loaded.config.dialect).toBe("sqlite");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("derives migration table from table prefix", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const configPath = join(dir, "effect-sql.config.ts");
        yield* Effect.promise(() =>
          writeFile(configPath, `export default { dialect: "sqlite", tablePrefix: "app" };\n`),
        );

        const loaded = yield* loadConfigEffect(configPath);

        expect(loaded.config.tablePrefix).toBe("app");
        expect(loaded.config.migrations.table).toBe("app_effect_sql_migrations");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps explicit migration table when table prefix is configured", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const configPath = join(dir, "effect-sql.config.ts");
        yield* Effect.promise(() =>
          writeFile(
            configPath,
            `export default { dialect: "sqlite", tablePrefix: "app", migrations: { table: "custom_migrations" } };\n`,
          ),
        );

        const loaded = yield* loadConfigEffect(configPath);

        expect(loaded.config.tablePrefix).toBe("app");
        expect(loaded.config.migrations.table).toBe("custom_migrations");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not double underscore migration tables for trailing underscore prefixes", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const configPath = join(dir, "effect-sql.config.ts");
        yield* Effect.promise(() =>
          writeFile(configPath, `export default { dialect: "sqlite", tablePrefix: "app_" };\n`),
        );

        const loaded = yield* loadConfigEffect(configPath);

        expect(loaded.config.migrations.table).toBe("app_effect_sql_migrations");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails invalid config through the schema parser", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const configPath = join(dir, "effect-sql.config.ts");
        yield* Effect.promise(() =>
          writeFile(configPath, `export default { dialect: "mysql" };\n`),
        );

        const result = yield* Effect.result(loadConfigEffect(configPath));
        expect(Result.isFailure(result)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("loads mjs default exported config", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const configPath = join(dir, "effect-sql.config.mjs");
        yield* Effect.promise(() =>
          writeFile(configPath, `export default { dialect: "sqlite", out: "./migrations" };\n`),
        );

        const loaded = yield* loadConfigEffect(configPath);
        expect(loaded.config.out).toBe("./migrations");
        expect(loaded.config.dialect).toBe("sqlite");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("loads TypeScript default schema exports", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* linkNodeModules(dir);
        const schemaPath = join(dir, "schema.ts");
        yield* Effect.promise(() =>
          writeFile(
            schemaPath,
            `import { schema, sqlite } from "effect-sql-schema";

class User extends sqlite.Class<User>("User")({
  table: "users",
  fields: {
    id: sqlite.text().primaryKey(),
    displayName: sqlite.text("display_name").notNull(),
  },
}) {}

export default schema({ users: User });
`,
          ),
        );

        const loaded = yield* loadSchemaEffect(schemaPath, {
          dialect: "sqlite",
          out: "./migrations",
          tablePrefix: "",
          migrations: {
            table: "effect_sql_migrations",
            schema: "public",
          },
          breakpoints: true,
        });
        expect(loaded.tables.users?._tag).toBe("EffectSqlTable");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("loads TypeScript named schema exports", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* linkNodeModules(dir);
        const schemaPath = join(dir, "schema.ts");
        yield* Effect.promise(() =>
          writeFile(
            schemaPath,
            `import { schema as makeSchema, sqlite } from "effect-sql-schema";

class User extends sqlite.Class<User>("User")({
  table: "users",
  fields: {
    id: sqlite.text().primaryKey(),
  },
}) {}

export const schema = makeSchema({ users: User });
`,
          ),
        );

        const loaded = yield* loadSchemaEffect(schemaPath, {
          dialect: "sqlite",
          out: "./migrations",
          tablePrefix: "",
          migrations: {
            table: "effect_sql_migrations",
            schema: "public",
          },
          breakpoints: true,
        });
        expect(loaded.tables.users?._tag).toBe("EffectSqlTable");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects invalid schema exports", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const schemaPath = join(dir, "schema.ts");
        yield* Effect.promise(() => writeFile(schemaPath, `export default { tables: {} };\n`));

        const result = yield* Effect.result(
          loadSchemaEffect(schemaPath, {
            dialect: "sqlite",
            out: "./migrations",
            tablePrefix: "",
            migrations: {
              table: "effect_sql_migrations",
              schema: "public",
            },
            breakpoints: true,
          }),
        );

        expect(Result.isFailure(result)).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("applies resolved table prefix to loaded schemas", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        yield* linkNodeModules(dir);
        const schemaPath = join(dir, "schema.ts");
        yield* Effect.promise(() =>
          writeFile(
            schemaPath,
            `import { schema, sqlite } from "effect-sql-schema";

class User extends sqlite.Class<User>("User")({
  table: "users",
  fields: {
    id: sqlite.text().primaryKey(),
  },
}) {}

export default schema({ users: User });
`,
          ),
        );

        const loaded = yield* loadSchemaEffect(schemaPath, {
          dialect: "sqlite",
          out: "./migrations",
          tablePrefix: "app",
          migrations: {
            table: "app_effect_sql_migrations",
            schema: "public",
          },
          breakpoints: true,
        });

        expect(loaded.tablePrefix).toBe("app");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
