// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`create table "sheet_db_workflow_run" (
  "run_id" text not null primary key,
  "workflow_name" text not null,
  "definition_version" text not null,
  "execution_id" text not null,
  "idempotency_key" text not null,
  "visibility_key" text not null,
  "principal" jsonb,
  "input" jsonb not null,
  "status" text not null,
  "result" jsonb,
  "error" jsonb,
  "max_attempts" integer not null,
  "run_after" timestamp with time zone not null,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create unique index "sheet_db_workflow_run_workflow_idempotency_idx" on "sheet_db_workflow_run" ("workflow_name", "idempotency_key")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_workflow_run_visibility_updated_idx" on "sheet_db_workflow_run" ("visibility_key", "updated_at")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_workflow_run_status_updated_idx" on "sheet_db_workflow_run" ("status", "updated_at")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_workflow_command" (
  "command_id" text not null primary key,
  "run_id" text not null,
  "kind" text not null,
  "payload" jsonb not null,
  "status" text not null,
  "attempts" integer not null,
  "available_at" timestamp with time zone not null,
  "lease_owner" text,
  "lease_token" integer not null,
  "lease_until" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "last_error" jsonb,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_workflow_command_delivery_idx" on "sheet_db_workflow_command" ("status", "available_at", "created_at")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_workflow_command_run_idx" on "sheet_db_workflow_command" ("run_id", "created_at")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" ADD TABLE
  "public"."sheet_db_workflow_run" ("completed_at", "created_at", "definition_version", "error", "result", "run_after", "run_id", "started_at", "status", "updated_at", "visibility_key", "workflow_name");`)
    .withoutTransform;
});
