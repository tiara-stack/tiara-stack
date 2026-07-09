// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const statements = [
  `create table "sheet_db_config_workspace_team_submission_channel" (
  "workspace_id" varchar not null,
  "conversation_id" varchar not null,
  "destination_team_config_name" varchar,
  "write_mode" varchar not null,
  "removed_row_strategy" varchar not null,
  "require_valid_oshi" boolean not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone,
  primary key ("workspace_id", "conversation_id")
)`,
  `create index "sheet_db_config_workspace_team_sub_channel_conv_idx" on "sheet_db_config_workspace_team_submission_channel" ("conversation_id")`,
  `create table "sheet_db_message_team_submission" (
  "workspace_id" varchar not null,
  "conversation_id" varchar not null,
  "message_id" varchar not null,
  "client_platform" varchar not null,
  "client_id" varchar not null,
  "discord_guild_id" varchar not null,
  "discord_channel_id" varchar not null,
  "discord_author_id" varchar not null,
  "sheet_id" varchar not null,
  "confirmation_message_id" varchar,
  "parsed_submission" jsonb not null,
  "row_mappings" jsonb not null,
  "rollback_snapshot" jsonb,
  "version" integer not null,
  "status" varchar not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone,
  primary key ("workspace_id", "conversation_id", "message_id")
)`,
  `create unique index "sheet_db_message_team_submission_discord_message_idx" on "sheet_db_message_team_submission" ("discord_guild_id", "discord_channel_id", "message_id") where "deleted_at" is null`,
  `create index "sheet_db_message_team_submission_client_message_idx" on "sheet_db_message_team_submission" ("client_platform", "client_id", "message_id")`,
  `ALTER PUBLICATION "zero_data" ADD TABLE
  "public"."sheet_db_config_workspace_team_submission_channel" ("conversation_id", "created_at", "deleted_at", "destination_team_config_name", "removed_row_strategy", "require_valid_oshi", "updated_at", "workspace_id", "write_mode"),
  "public"."sheet_db_message_team_submission" ("client_id", "client_platform", "confirmation_message_id", "conversation_id", "created_at", "deleted_at", "discord_author_id", "discord_channel_id", "discord_guild_id", "message_id", "parsed_submission", "rollback_snapshot", "row_mappings", "sheet_id", "status", "updated_at", "version", "workspace_id");`,
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* Effect.forEach(statements, (statement) => sql.unsafe(statement).withoutTransform, {
    discard: true,
  });
});
