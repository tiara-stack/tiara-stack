// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`create table "sheet_db_config_workspace_sheet" (
  "workspace_id" varchar not null primary key,
  "source" jsonb not null,
  "draft_version" integer not null,
  "base_revision_id" varchar,
  "draft" jsonb,
  "diagnostics" jsonb not null,
  "active_revision_id" varchar,
  "updated_by" varchar,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_config_workspace_sheet_revision" (
  "workspace_id" varchar not null,
  "revision_id" varchar not null,
  "spreadsheet_id" varchar not null,
  "configuration" jsonb not null,
  "created_by" varchar not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone,
  primary key ("workspace_id", "revision_id")
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_config_workspace_sheet_revision_spreadsheet_idx" on "sheet_db_config_workspace_sheet_revision" ("spreadsheet_id")`,
  ).withoutTransform;

  // Keep revision pointers scoped to the same workspace as their configuration row.
  yield* sql.unsafe(`alter table "sheet_db_config_workspace_sheet"
  add constraint "sheet_db_config_workspace_sheet_base_revision_fk"
  foreign key ("workspace_id", "base_revision_id")
  references "sheet_db_config_workspace_sheet_revision" ("workspace_id", "revision_id")
  on delete restrict,
  add constraint "sheet_db_config_workspace_sheet_active_revision_fk"
  foreign key ("workspace_id", "active_revision_id")
  references "sheet_db_config_workspace_sheet_revision" ("workspace_id", "revision_id")
  on delete restrict`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_audit_sheet_configuration" (
  "event_id" varchar not null primary key,
  "workspace_id" varchar not null,
  "operation" varchar not null,
  "outcome" varchar not null,
  "invocation_id" varchar,
  "effective_principal" jsonb not null,
  "actor_provenance" jsonb,
  "metadata" jsonb not null,
  "reason" varchar,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_audit_sheet_configuration_workspace_created_idx" on "sheet_db_audit_sheet_configuration" ("workspace_id", "created_at")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" ADD TABLE
  "public"."sheet_db_audit_sheet_configuration" ("actor_provenance", "created_at", "deleted_at", "effective_principal", "event_id", "invocation_id", "metadata", "operation", "outcome", "reason", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_sheet" ("active_revision_id", "base_revision_id", "created_at", "deleted_at", "diagnostics", "draft", "draft_version", "source", "updated_at", "updated_by", "workspace_id"),
  "public"."sheet_db_config_workspace_sheet_revision" ("configuration", "created_at", "created_by", "deleted_at", "revision_id", "spreadsheet_id", "updated_at", "workspace_id");`)
    .withoutTransform;

  // Notify Zero after changing the custom publication's column set.
  yield* sql.unsafe(`COMMENT ON PUBLICATION "zero_data" IS 'sheet-db-schema publication update'`)
    .withoutTransform;
});
