// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`alter table "sheet_db_workflow_run" add column "contract_identity" text`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`alter table "sheet_db_workflow_run" add column "contract_wire_version" text`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`alter table "sheet_db_workflow_run" add column "canonical_input_hash" text`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`alter table "sheet_db_workflow_run" add column "actor_provenance" jsonb`)
    .withoutTransform;

  // --> statement-breakpoint
  // Effect SQL runs migrations in a transaction, so write-sensitive deployments should create
  // this index concurrently out of band before applying the migration. The guard then makes this
  // step a no-op while preserving the canonical index definition for ordinary deployments.
  yield* sql.unsafe(
    `create index if not exists "sheet_db_workflow_run_workflow_owner_submitted_idx" on "sheet_db_workflow_run" ("workflow_name", "visibility_key", "created_at", "run_id")`,
  ).withoutTransform;
});
