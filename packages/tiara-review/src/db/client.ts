import { SqliteClient } from "@effect/sql-sqlite-node";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { SqlClient } from "effect/unstable/sql";
import { ensureDbDirectory } from "../config";
import { DatabaseMigrationFailed } from "../review/types";
import { migrations } from "./schema";

export const sqliteLayer = (dbPath: string) =>
  Layer.unwrap(ensureDbDirectory(dbPath).pipe(Effect.as(SqliteClient.layer({ filename: dbPath }))));

// Early builds stored checkpoint_created_at in seconds close to created_at; new rows use millis.
const legacyCheckpointSecondsPredicate =
  "checkpoint_created_at BETWEEN created_at - 86400 AND created_at + 86400";
const legacyCheckpointTimestampMigrationId = "normalize-checkpoint-created-at-v1";

export const withImmediateTransaction = <A, E, R>(
  sql: SqlClient.SqlClient,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    yield* sql.unsafe(`BEGIN IMMEDIATE`);
    const transactionExit = yield* Effect.exit(effect);
    if (Exit.isFailure(transactionExit)) {
      yield* sql.unsafe(`ROLLBACK`);
      return yield* Effect.failCause(transactionExit.cause);
    }
    const commitExit = yield* Effect.exit(sql.unsafe(`COMMIT`));
    if (Exit.isFailure(commitExit)) {
      yield* sql.unsafe(`ROLLBACK`).pipe(Effect.ignore);
      return yield* Effect.failCause(commitExit.cause);
    }
    return transactionExit.value;
  });

export const migrate = (dbPath: string) =>
  Effect.gen(function* () {
    yield* ensureDbDirectory(dbPath);
    const sql = yield* SqlClient.SqlClient;
    for (const migration of migrations) {
      yield* sql.unsafe(migration);
    }
    yield* withImmediateTransaction(
      sql,
      Effect.gen(function* () {
        const columns = yield* sql.unsafe<{ readonly name: string }>(
          `PRAGMA table_info(review_runs)`,
        );
        if (!columns.some((column) => column.name === "checkpoint_created_at")) {
          yield* sql.unsafe(`ALTER TABLE review_runs ADD COLUMN checkpoint_created_at integer`);
        }
        const graphVersionColumns = yield* sql.unsafe<{ readonly name: string }>(
          `PRAGMA table_info(dependency_graph_versions)`,
        );
        if (!graphVersionColumns.some((column) => column.name === "lease_expires_at")) {
          yield* sql.unsafe(
            `ALTER TABLE dependency_graph_versions ADD COLUMN lease_expires_at integer`,
          );
        }
        const applied = yield* sql.unsafe<{ readonly id: string }>(
          `select id from schema_migrations where id = ? limit 1`,
          [legacyCheckpointTimestampMigrationId],
        );
        if (applied.length === 0) {
          yield* sql.unsafe(
            `UPDATE review_runs
             SET checkpoint_created_at = CASE
               WHEN checkpoint_created_at IS NULL THEN created_at * 1000
               WHEN ${legacyCheckpointSecondsPredicate}
                 THEN checkpoint_created_at * 1000
               ELSE checkpoint_created_at
             END
             WHERE checkpoint_created_at IS NULL
                OR ${legacyCheckpointSecondsPredicate}`,
          );
          yield* sql`
            insert into schema_migrations (id, applied_at)
            values (${legacyCheckpointTimestampMigrationId}, ${Math.floor(Date.now() / 1000)})
          `;
        }
      }),
    );
  }).pipe(Effect.mapError((cause) => new DatabaseMigrationFailed({ dbPath, cause })));

export const withSqlite = <A, E, R>(
  dbPath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* migrate(dbPath);
      return yield* effect;
    }).pipe(Effect.provide(sqliteLayer(dbPath) as Layer.Layer<SqlClient.SqlClient>)),
  );
