import { PgClient } from "@effect/sql-pg";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { zeroDrizzle, type DrizzleDatabase } from "@rocicorp/zero/server/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import { Cause, Effect, Layer, pipe, Context, Redacted } from "effect";
import postgres from "postgres";
import { sheetDbMigrations, sheetDbMigrationTable } from "sheet-db-schema/migrations";
import { schema as zeroSchema } from "sheet-db-schema/zero";
import { config } from "@/config";

const migrationPgClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    const postgresUrl = yield* config.postgresUrl;
    return PgClient.layer({
      url: Redacted.make(postgresUrl),
      applicationName: "sheet-db-server-migrations",
      maxConnections: 1,
      transformJson: true,
    });
  }),
);

class DBMigrations extends Context.Service<DBMigrations>()("DBMigrations", {
  make: Effect.gen(function* () {
    const completed = yield* PgMigrator.run({
      loader: sheetDbMigrations,
      table: sheetDbMigrationTable,
    });
    yield* Effect.logInfo(
      completed.length === 0
        ? "sheet-db-server migrations are up to date"
        : `Applied ${completed.length} sheet-db-server migration(s)`,
      { completed },
    );
    return {};
  }).pipe(Effect.provide(migrationPgClientLayer)),
}) {
  static layer = Layer.effect(DBMigrations, this.make);
}

export class DBService extends Context.Service<DBService>()("DBService", {
  make: Effect.gen(function* () {
    yield* DBMigrations;
    yield* Effect.log("creating db client");
    const postgresUrl = yield* config.postgresUrl;
    const client = yield* Effect.try({
      try: () => postgres(postgresUrl),
      catch: (error) => new Cause.UnknownError(error),
    });
    const db = yield* Effect.try({
      try: () => drizzle(client),
      catch: (error) => new Cause.UnknownError(error),
    });
    const zql = yield* Effect.try({
      try: () => zeroDrizzle(zeroSchema, db as unknown as DrizzleDatabase),
      catch: (error) => new Cause.UnknownError(error),
    });
    yield* Effect.addFinalizer(() =>
      pipe(
        Effect.promise(() => client.end()),
        Effect.andThen(() => Effect.log("DB client closed")),
      ),
    );
    return { db, zql };
  }),
}) {
  static layer = Layer.effect(DBService, this.make).pipe(Layer.provide(DBMigrations.layer));
}
