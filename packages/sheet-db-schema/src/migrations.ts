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
import migration0011 from "../effect-sql-migrations/0011_user_platform_dm_invariant";
import migration0012 from "../effect-sql-migrations/0012_user_platform_dm_invariant_validation";
import migration0013 from "../effect-sql-migrations/0013_monitor_conversation";
import migration0014 from "../effect-sql-migrations/0014_migration";
import migration0015 from "../effect-sql-migrations/0015_migration";
import migration0016 from "../effect-sql-migrations/0016_rollout_gate";
import migration0017 from "../effect-sql-migrations/0017_sheet_configuration";
import migration0018 from "../effect-sql-migrations/0018_migration";
import migration0019 from "../effect-sql-migrations/0019_migration";
import migration0020 from "../effect-sql-migrations/0020_migration";
import migration0021 from "../effect-sql-migrations/0021_migration";
import migration0022 from "../effect-sql-migrations/0022_sticky_slot_channel";
import migration0023 from "../effect-sql-migrations/0023_sticky_slot_message_index";
import migration0024 from "../effect-sql-migrations/0024_migration";
import migration0025 from "../effect-sql-migrations/0025_migration";
export {
  SheetDbMigrationArtifactManifestSchema,
  sheetDbMigrationArtifactDigestFromSources,
  sheetDbMigrationArtifactDigest,
  sheetDbMigrationArtifactSources,
} from "./migration-artifact-identity";

export const sheetDbMigrationTable = "sheet_db_effect_sql_migrations";

export const sheetDbMigrationArtifacts = [
  [
    1,
    "migration",
    Effect.succeed(migration0001),
    "packages/sheet-db-schema/effect-sql-migrations/0001_migration.ts",
  ],
  [
    2,
    "migration",
    Effect.succeed(migration0002),
    "packages/sheet-db-schema/effect-sql-migrations/0002_migration.ts",
  ],
  [
    3,
    "migration",
    Effect.succeed(migration0003),
    "packages/sheet-db-schema/effect-sql-migrations/0003_migration.ts",
  ],
  [
    4,
    "migration",
    Effect.succeed(migration0004),
    "packages/sheet-db-schema/effect-sql-migrations/0004_migration.ts",
  ],
  [
    5,
    "client_message_keys",
    Effect.succeed(migration0005),
    "packages/sheet-db-schema/effect-sql-migrations/0005_client_message_keys.ts",
  ],
  [
    6,
    "workspace_config_names",
    Effect.succeed(migration0006),
    "packages/sheet-db-schema/effect-sql-migrations/0006_workspace_config_names.ts",
  ],
  [
    7,
    "checkin_initial_message_json",
    Effect.succeed(migration0007),
    "packages/sheet-db-schema/effect-sql-migrations/0007_checkin_initial_message_json.ts",
  ],
  [
    8,
    "user_platform_config",
    Effect.succeed(migration0008),
    "packages/sheet-db-schema/effect-sql-migrations/0008_user_platform_config.ts",
  ],
  [
    9,
    "user_platform_monitor_dm",
    Effect.succeed(migration0009),
    "packages/sheet-db-schema/effect-sql-migrations/0009_user_platform_monitor_dm.ts",
  ],
  [
    10,
    "team_submission_monitoring",
    Effect.succeed(migration0010),
    "packages/sheet-db-schema/effect-sql-migrations/0010_migration.ts",
  ],
  [
    11,
    "user_platform_dm_invariant",
    Effect.succeed(migration0011),
    "packages/sheet-db-schema/effect-sql-migrations/0011_user_platform_dm_invariant.ts",
  ],
  [
    12,
    "user_platform_dm_invariant_validation",
    Effect.succeed(migration0012),
    "packages/sheet-db-schema/effect-sql-migrations/0012_user_platform_dm_invariant_validation.ts",
  ],
  [
    13,
    "monitor_conversation",
    Effect.succeed(migration0013),
    "packages/sheet-db-schema/effect-sql-migrations/0013_monitor_conversation.ts",
  ],
  [
    14,
    "workflow_runtime",
    Effect.succeed(migration0014),
    "packages/sheet-db-schema/effect-sql-migrations/0014_migration.ts",
  ],
  [
    15,
    "workflow_contract_invocation",
    Effect.succeed(migration0015),
    "packages/sheet-db-schema/effect-sql-migrations/0015_migration.ts",
  ],
  [
    16,
    "rollout_gate",
    Effect.succeed(migration0016),
    "packages/sheet-db-schema/effect-sql-migrations/0016_rollout_gate.ts",
  ],
  [
    17,
    "sheet_configuration",
    Effect.succeed(migration0017),
    "packages/sheet-db-schema/effect-sql-migrations/0017_sheet_configuration.ts",
  ],
  [
    18,
    "migration",
    Effect.succeed(migration0018),
    "packages/sheet-db-schema/effect-sql-migrations/0018_migration.ts",
  ],
  [
    19,
    "migration",
    Effect.succeed(migration0019),
    "packages/sheet-db-schema/effect-sql-migrations/0019_migration.ts",
  ],
  [
    20,
    "migration",
    Effect.succeed(migration0020),
    "packages/sheet-db-schema/effect-sql-migrations/0020_migration.ts",
  ],
  [
    21,
    "migration",
    Effect.succeed(migration0021),
    "packages/sheet-db-schema/effect-sql-migrations/0021_migration.ts",
  ],
  [
    22,
    "sticky_slot_channel",
    Effect.succeed(migration0022),
    "packages/sheet-db-schema/effect-sql-migrations/0022_sticky_slot_channel.ts",
  ],
  [
    23,
    "sticky_slot_message_index",
    Effect.succeed(migration0023),
    "packages/sheet-db-schema/effect-sql-migrations/0023_sticky_slot_message_index.ts",
  ],
  [
    24,
    "hourly_checkin_messages",
    Effect.succeed(migration0024),
    "packages/sheet-db-schema/effect-sql-migrations/0024_migration.ts",
  ],
  [
    25,
    "announcement_channel",
    Effect.succeed(migration0025),
    "packages/sheet-db-schema/effect-sql-migrations/0025_migration.ts",
  ],
] as const satisfies ReadonlyArray<readonly [number, string, Effect.Effect<unknown>, string]>;

export const sheetDbMigrations: Loader = Effect.succeed(
  sheetDbMigrationArtifacts.map(([id, name, migration]) => [id, name, migration] as const),
);
