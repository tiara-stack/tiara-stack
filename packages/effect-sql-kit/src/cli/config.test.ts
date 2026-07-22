import { NodeServices } from "@effect/platform-node";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Result } from "effect";
import { loadConfigEffect, loadSchemaEffect } from "./config";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const sqliteConfig = {
  dialect: "sqlite" as const,
  out: "./migrations",
  prefix: "",
  migrations: { table: "effect_sql_migrations", schema: "public" },
  breakpoints: true,
  extensions: [],
};

const withTempDir = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "effect-sql-kit-cli-"))),
    f,
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

const loadConfigSource = (
  source: string,
  flags?: Parameters<typeof loadConfigEffect>[1],
  options: { readonly extension?: "ts" | "mjs"; readonly linkModules?: boolean } = {},
) =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      if (options.linkModules) {
        yield* Effect.promise(() =>
          symlink(join(packageRoot, "node_modules"), join(dir, "node_modules"), "dir"),
        );
      }
      const configPath = join(dir, `effect-sql.config.${options.extension ?? "ts"}`);
      yield* Effect.promise(() => writeFile(configPath, source));
      return yield* loadConfigEffect(configPath, flags);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const loadSchemaSource = (
  source: string,
  config: Parameters<typeof loadSchemaEffect>[1] = sqliteConfig,
) =>
  withTempDir((dir) =>
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        symlink(join(packageRoot, "node_modules"), join(dir, "node_modules"), "dir"),
      );
      const schemaPath = join(dir, "schema.ts");
      yield* Effect.promise(() => writeFile(schemaPath, source));
      return yield* loadSchemaEffect(schemaPath, config);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const schemaModule = (
  exportStatement: string,
  options: {
    readonly displayName?: boolean;
    readonly schemaImport?: "schema" | "makeSchema";
  } = {},
) => `
import { schema${options.schemaImport === "makeSchema" ? " as makeSchema" : ""}, sqlite } from "effect-sql-schema";

class User extends sqlite.Class<User>("User")({
  table: "users",
  fields: {
    id: sqlite.text().primaryKey(),
    ${options.displayName ? 'displayName: sqlite.text("display_name").notNull(),' : ""}
  },
}) {}

${exportStatement}
`;

describe("CLI config effects", () => {
  it.live("loads default exported config and applies flags", () =>
    Effect.gen(function* () {
      const loaded = yield* loadConfigSource(
        `export default { dialect: "sqlite", out: "./old", dbCredentials: { url: "old.db" } };`,
        { out: "./new" },
      );
      expect(loaded.config.out).toBe("./new");
      expect(loaded.config.dialect).toBe("sqlite");
      expect(loaded.config.extensions).toEqual([]);
    }),
  );

  it.live("preserves configured migration extensions", () =>
    Effect.gen(function* () {
      const loaded = yield* loadConfigSource(
        `const extension = {
  _tag: "EffectSqlKitMigrationExtension",
  name: "test-extension",
  generate: () => ({ statements: [], snapshot: null }),
};
export default { dialect: "sqlite", extensions: [extension] };`,
        undefined,
        { linkModules: true },
      );
      expect(loaded.config.extensions).toHaveLength(1);
      expect(loaded.config.extensions[0]?.name).toBe("test-extension");
    }),
  );

  it.live("rejects malformed migration extensions", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        loadConfigSource(
          `export default { dialect: "sqlite", extensions: [{ name: "missing-generate" }] };`,
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.live("derives migration table from prefix", () =>
    Effect.gen(function* () {
      const loaded = yield* loadConfigSource(
        `export default { dialect: "sqlite", prefix: "app" };`,
      );
      expect(loaded.config.prefix).toBe("app");
      expect(loaded.config.migrations.table).toBe("app_effect_sql_migrations");
    }),
  );

  it.live("keeps explicit migration table when prefix is configured", () =>
    Effect.gen(function* () {
      const loaded = yield* loadConfigSource(
        `export default { dialect: "sqlite", prefix: "app", migrations: { table: "custom_migrations" } };`,
      );
      expect(loaded.config.prefix).toBe("app");
      expect(loaded.config.migrations.table).toBe("custom_migrations");
    }),
  );

  it.live("does not double underscore migration tables for trailing underscore prefixes", () =>
    Effect.gen(function* () {
      const loaded = yield* loadConfigSource(
        `export default { dialect: "sqlite", prefix: "app_" };`,
      );
      expect(loaded.config.migrations.table).toBe("app_effect_sql_migrations");
    }),
  );

  it.live("fails invalid config through the schema parser", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(loadConfigSource(`export default { dialect: "mysql" };`));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("loads mjs default exported config", () =>
    Effect.gen(function* () {
      const loaded = yield* loadConfigSource(
        `export default { dialect: "sqlite", out: "./migrations" };`,
        undefined,
        { extension: "mjs" },
      );
      expect(loaded.config.out).toBe("./migrations");
      expect(loaded.config.dialect).toBe("sqlite");
    }),
  );

  it.live("loads TypeScript default schema exports", () =>
    Effect.gen(function* () {
      const loaded = yield* loadSchemaSource(
        schemaModule("export default schema({ users: User });", { displayName: true }),
      );
      expect(loaded.tables.users?._tag).toBe("EffectSqlTable");
    }),
  );

  it.live("loads TypeScript named schema exports", () =>
    Effect.gen(function* () {
      const loaded = yield* loadSchemaSource(
        schemaModule("export const schema = makeSchema({ users: User });", {
          schemaImport: "makeSchema",
        }),
      );
      expect(loaded.tables.users?._tag).toBe("EffectSqlTable");
    }),
  );

  it.live("rejects invalid schema exports", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(loadSchemaSource(`export default { tables: {} };`));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.live("applies resolved prefix to loaded schemas", () =>
    Effect.gen(function* () {
      const loaded = yield* loadSchemaSource(
        schemaModule("export default schema({ users: User });"),
        {
          ...sqliteConfig,
          prefix: "app",
          migrations: { ...sqliteConfig.migrations, table: "app_effect_sql_migrations" },
        },
      );
      expect(loaded.prefix).toBe("app");
    }),
  );

  it.live("preserves a canonical schema prefix when config does not override it", () =>
    Effect.gen(function* () {
      const loaded = yield* loadSchemaSource(
        schemaModule(`export default schema({ users: User }, { prefix: "canonical" });`),
      );
      expect(loaded.prefix).toBe("canonical");
    }),
  );
});
