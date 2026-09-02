// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`create table "sheet_db_config_workspace_sheet_import_attempt" (
  "attempt_id" varchar not null primary key,
  "workspace_id" varchar not null,
  "status" varchar not null,
  "source_binding" jsonb not null,
  "baseline_digest" varchar not null,
  "result" jsonb,
  "created_by" varchar not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_config_workspace_sheet_import_attempt_workspace_idx" on "sheet_db_config_workspace_sheet_import_attempt" ("workspace_id")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" ADD TABLE
  "public"."sheet_db_config_workspace_sheet_import_attempt" ("attempt_id", "baseline_digest", "created_at", "created_by", "deleted_at", "result", "source_binding", "status", "updated_at", "workspace_id");`)
    .withoutTransform;

  // Notify Zero after changing the custom publication's column set.
  yield* sql.unsafe(`COMMENT ON PUBLICATION "zero_data" IS 'sheet-db-schema publication update'`)
    .withoutTransform;
});
