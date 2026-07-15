// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) =>
      sql.unsafe(`
alter table "sheet_db_config_user_platform"
validate constraint "sheet_db_config_user_platform_dm_default_client_check";
`).withoutTransform,
  ),
  Effect.asVoid,
);
