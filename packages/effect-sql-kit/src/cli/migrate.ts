import { NodeFileSystem, NodePath } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Command } from "effect/unstable/cli";
import type { PgPoolConfig } from "@effect/sql-pg/PgClient";
import { fromDirectory } from "../migration/load";
import { loadConfig, loadConfigEffect } from "./config";
import { configFlags, configInputToOverrides, optionalValue, tryPromise } from "./options";

const runPostgres = async (config: Awaited<ReturnType<typeof loadConfig>>["config"]) => {
  const [{ PgClient }, PgMigrator, { NodeServices }] = await Promise.all([
    import("@effect/sql-pg"),
    import("@effect/sql-pg/PgMigrator"),
    import("@effect/platform-node"),
  ]);
  const url = config.dbCredentials?.url;
  if (!url) {
    throw new Error("effect-sql-kit: --url or dbCredentials.url is required for migrate");
  }
  const pgConfig = { url: Redacted.make(url) } satisfies PgPoolConfig;
  const program = PgMigrator.run({
    loader: fromDirectory(config.out),
    table: config.migrations.table,
    schemaDirectory: undefined,
  }).pipe(Effect.provide(PgClient.layer(pgConfig)), Effect.provide(NodeServices.layer));
  return await Effect.runPromise(program);
};

export const runPostgresEffect = (config: Awaited<ReturnType<typeof loadConfig>>["config"]) =>
  tryPromise(() => runPostgres(config));

const runSqlite = async (config: Awaited<ReturnType<typeof loadConfig>>["config"]) => {
  const [{ SqliteClient }, SqliteMigrator, { NodeServices }] = await Promise.all([
    import("@effect/sql-sqlite-node"),
    import("@effect/sql-sqlite-node/SqliteMigrator"),
    import("@effect/platform-node"),
  ]);
  const filename = config.dbCredentials?.url;
  if (!filename) {
    throw new Error("effect-sql-kit: --url or dbCredentials.url is required for migrate");
  }
  const program = SqliteMigrator.run({
    loader: fromDirectory(config.out),
    table: config.migrations.table,
  }).pipe(
    Effect.provide(SqliteClient.layer({ filename })),
    Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeServices.layer)),
  );
  return await Effect.runPromise(program);
};

export const runSqliteEffect = (config: Awaited<ReturnType<typeof loadConfig>>["config"]) =>
  tryPromise(() => runSqlite(config));

export const migrateCommand = Command.make("migrate", configFlags, (options) =>
  Effect.gen(function* () {
    const { config } = yield* loadConfigEffect(
      optionalValue(options.config),
      configInputToOverrides(options),
    );

    const completed = yield* config.dialect === "postgresql"
      ? runPostgresEffect(config)
      : runSqliteEffect(config);

    yield* Console.log(
      completed.length === 0
        ? "effect-sql-kit: no pending migrations"
        : `effect-sql-kit: applied ${completed.length} migration(s)`,
    );
  }),
).pipe(Command.withDescription("Run pending Effect SQL migrations"));
