import { PgClient } from "@effect/sql-pg";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { admitSheetDbMigrationHistory } from "sheet-zero-server/state-plane-admission";
import { zeroDrizzle, type DrizzleDatabase } from "@rocicorp/zero/server/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  Cause,
  Config,
  ConfigProvider,
  Data,
  Effect,
  Layer,
  pipe,
  Context,
  Option,
  Redacted,
} from "effect";
import postgres from "postgres";
import { sheetDbMigrations, sheetDbMigrationTable } from "sheet-db-schema/migrations";
import { schema as zeroSchema } from "sheet-zero-api";
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

class DBBootstrapPolicyError extends Data.TaggedError("DBBootstrapPolicyError")<{
  readonly message: string;
}> {}

const requireOwnedMigrationOwner = (
  bootstrapPolicy: "deployment-migrate" | "shared-admission" | "owned-initialize",
  migrationOwner: Option.Option<string>,
) =>
  bootstrapPolicy === "owned-initialize" && Option.isNone(migrationOwner)
    ? Effect.fail(
        new DBBootstrapPolicyError({
          message: "DB_MIGRATION_OWNER is required for owned initialization",
        }),
      )
    : Effect.void;

const bootstrapStatePlane = Effect.gen(function* () {
  const bootstrapPolicy = yield* config.dbBootstrapPolicy;
  if (bootstrapPolicy === "shared-admission") {
    yield* admitSheetDbMigrationHistory;
    yield* Effect.logInfo("State Plane migration history admitted without initialization");
  } else {
    const migrationOwner = yield* config.dbMigrationOwner;
    yield* requireOwnedMigrationOwner(bootstrapPolicy, migrationOwner);
    const completed = yield* PgMigrator.run({
      loader: sheetDbMigrations,
      table: sheetDbMigrationTable,
    });
    yield* Effect.logInfo(
      completed.length === 0
        ? "sheet-db-server migrations are up to date"
        : `Applied ${completed.length} sheet-db-server migration(s)`,
      { completed, bootstrapPolicy, migrationOwner },
    );
  }
}).pipe(Effect.provide(migrationPgClientLayer));

export class DBService extends Context.Service<DBService>()("DBService", {
  make: Effect.gen(function* () {
    yield* bootstrapStatePlane.pipe(
      Effect.catchTag("DBBootstrapPolicyError", (error) =>
        Effect.fail(
          new Config.ConfigError(new ConfigProvider.SourceError({ message: error.message })),
        ),
      ),
    );
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
  static layer = Layer.effect(DBService, this.make);
}
