// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(
    `create unique index "sheet_db_message_slot_client_message_idx" on "sheet_db_message_slot" ("client_platform", "client_id", "message_id")`,
  ).withoutTransform;
});
