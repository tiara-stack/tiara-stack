import { Effect } from "effect";
import type { Loader } from "effect/unstable/sql/Migrator";
import migration0001 from "../effect-sql-migrations/0001_migration";
import migration0002 from "../effect-sql-migrations/0002_migration";
import migration0003 from "../effect-sql-migrations/0003_migration";
import migration0004 from "../effect-sql-migrations/0004_migration";
import migration0005 from "../effect-sql-migrations/0005_client_message_keys";
import migration0006 from "../effect-sql-migrations/0006_workspace_config_names";
import migration0007 from "../effect-sql-migrations/0007_checkin_initial_message_json";
import migration0008 from "../effect-sql-migrations/0008_user_platform_config";
import migration0009 from "../effect-sql-migrations/0009_user_platform_monitor_dm";
import migration0010 from "../effect-sql-migrations/0010_migration";

export const sheetDbMigrationTable = "sheet_db_effect_sql_migrations";

export const sheetDbMigrations: Loader = Effect.succeed([
  [1, "migration", Effect.succeed(migration0001)],
  [2, "migration", Effect.succeed(migration0002)],
  [3, "migration", Effect.succeed(migration0003)],
  [4, "migration", Effect.succeed(migration0004)],
  [5, "client_message_keys", Effect.succeed(migration0005)],
  [6, "workspace_config_names", Effect.succeed(migration0006)],
  [7, "checkin_initial_message_json", Effect.succeed(migration0007)],
  [8, "user_platform_config", Effect.succeed(migration0008)],
  [9, "user_platform_monitor_dm", Effect.succeed(migration0009)],
  [10, "team_submission_monitoring", Effect.succeed(migration0010)],
]);
