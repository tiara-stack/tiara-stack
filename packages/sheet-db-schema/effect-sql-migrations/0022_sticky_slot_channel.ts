// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/*
 * Apply this migration before deploying code that reads channel-owned slot state. Before production
 * execution, follow docs/operators/rollout-gate-control.md to audit rows removed by this migration.
 * The database server applies migrations before starting Zero sync; downstream Zero clients should
 * reconnect after deployment so their subscriptions use the new channel primary key.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
delete from "sheet_db_message_slot"
where "workspace_id" is null
   or "conversation_id" is null
   or "created_by_user_id" is null;

delete from "sheet_db_message_slot" older
using "sheet_db_message_slot" newer
where older."client_platform" = newer."client_platform"
  and older."client_id" = newer."client_id"
  and older."workspace_id" = newer."workspace_id"
  and older."conversation_id" = newer."conversation_id"
  and (
    (older."deleted_at" is not null and newer."deleted_at" is null)
    or (
      (older."deleted_at" is null) = (newer."deleted_at" is null)
      and (
        older."updated_at" < newer."updated_at"
        or (
          older."updated_at" = newer."updated_at"
          and older."message_id" < newer."message_id"
        )
      )
    )
  );

alter table "sheet_db_message_slot"
  drop constraint "sheet_db_message_slot_pkey",
  alter column "workspace_id" set not null,
  alter column "conversation_id" set not null,
  alter column "created_by_user_id" set not null,
  add primary key ("client_platform", "client_id", "workspace_id", "conversation_id")
`).withoutTransform;
});
