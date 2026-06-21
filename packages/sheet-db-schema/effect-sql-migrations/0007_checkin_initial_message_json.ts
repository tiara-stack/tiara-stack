// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
ALTER TABLE "sheet_db_message_checkin"
  ALTER COLUMN "initial_message" TYPE jsonb
  USING jsonb_build_array(
    jsonb_build_object('type', 'text', 'text', "initial_message")
  );
`).withoutTransform;
});
