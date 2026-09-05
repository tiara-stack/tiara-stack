// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`create table "sheet_db_config_workspace_checkin_message_set" (
  "workspace_id" varchar not null primary key,
  "event_start" timestamp with time zone not null,
  "message_set_generation" integer not null,
  "updated_by" varchar not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  yield* sql.unsafe(`alter table "sheet_db_config_workspace_checkin_message_set"
  add constraint "sheet_db_checkin_message_set_generation_positive"
  check ("message_set_generation" > 0)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_config_workspace_checkin_message" (
  "workspace_id" varchar not null,
  "message_set_generation" integer not null,
  "conversation_id" varchar not null,
  "hour" integer not null,
  "template" text,
  "version" integer not null,
  "created_by" varchar not null,
  "updated_by" varchar not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone,
  primary key ("workspace_id", "message_set_generation", "conversation_id", "hour")
)`).withoutTransform;

  yield* sql.unsafe(`alter table "sheet_db_config_workspace_checkin_message"
  add constraint "sheet_db_checkin_message_generation_positive"
  check ("message_set_generation" > 0),
  add constraint "sheet_db_checkin_message_hour_nonnegative"
  check ("hour" >= 0),
  add constraint "sheet_db_checkin_message_version_positive"
  check ("version" > 0)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_config_workspace_checkin_message_active_set_idx" on "sheet_db_config_workspace_checkin_message" ("workspace_id", "message_set_generation", "conversation_id")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_config_workspace_checkin_message_mutation_receipt" (
  "invocation_id" varchar not null,
  "action_key" varchar not null,
  "workspace_id" varchar not null,
  "input_digest" varchar not null,
  "result" jsonb not null,
  "created_by" varchar not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone,
  primary key ("invocation_id", "action_key")
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_config_workspace_checkin_message_receipt_workspace_idx" on "sheet_db_config_workspace_checkin_message_mutation_receipt" ("workspace_id", "created_at")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" ADD TABLE
  "public"."sheet_db_config_workspace_checkin_message" ("conversation_id", "created_at", "created_by", "deleted_at", "hour", "message_set_generation", "template", "updated_at", "updated_by", "version", "workspace_id"),
  "public"."sheet_db_config_workspace_checkin_message_mutation_receipt" ("action_key", "created_at", "created_by", "deleted_at", "input_digest", "invocation_id", "result", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_checkin_message_set" ("created_at", "deleted_at", "event_start", "message_set_generation", "updated_at", "updated_by", "workspace_id");`)
    .withoutTransform;

  yield* sql.unsafe(`COMMENT ON PUBLICATION "zero_data" IS 'sheet-db-schema publication update'`)
    .withoutTransform;
});
