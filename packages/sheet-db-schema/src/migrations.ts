import { Effect } from "effect";
import type { Loader } from "effect/unstable/sql/Migrator";
import migration0001 from "../effect-sql-migrations/0001_migration";
import migration0002 from "../effect-sql-migrations/0002_migration";
import migration0003 from "../effect-sql-migrations/0003_migration";
import migration0004 from "../effect-sql-migrations/0004_migration";
import migration0005 from "../effect-sql-migrations/0005_client_message_keys";
import migration0006 from "../effect-sql-migrations/0006_workspace_config_names";
import migration0007 from "../effect-sql-migrations/0007_checkin_initial_message_json";

export const sheetDbMigrationTable = "sheet_db_effect_sql_migrations";

export const sheetDbMigrations: Loader = Effect.succeed([
  [1, "migration", Effect.succeed(migration0001)],
  [2, "migration", Effect.succeed(migration0002)],
  [3, "migration", Effect.succeed(migration0003)],
  [4, "migration", Effect.succeed(migration0004)],
  [5, "client_message_keys", Effect.succeed(migration0005)],
  [6, "workspace_config_names", Effect.succeed(migration0006)],
  [7, "checkin_initial_message_json", Effect.succeed(migration0007)],
]);
