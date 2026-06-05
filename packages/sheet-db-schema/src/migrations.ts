import { Effect } from "effect";
import type { Loader } from "effect/unstable/sql/Migrator";
import migration0001 from "../effect-sql-migrations/0001_migration";
import migration0002 from "../effect-sql-migrations/0002_migration";
import migration0003 from "../effect-sql-migrations/0003_migration";

export const sheetDbMigrationTable = "sheet_db_effect_sql_migrations";

export const sheetDbMigrations: Loader = Effect.succeed([
  [1, "migration", Effect.succeed(migration0001)],
  [2, "migration", Effect.succeed(migration0002)],
  [3, "migration", Effect.succeed(migration0003)],
]);
