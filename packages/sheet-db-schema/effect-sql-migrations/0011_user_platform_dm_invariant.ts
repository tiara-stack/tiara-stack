// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

const invariantStatements = [
  // NOT VALID enforces the invariant for concurrent writes without rejecting existing bad rows.
  `
alter table "sheet_db_config_user_platform"
add constraint "sheet_db_config_user_platform_dm_default_client_check"
check (
  "default_client_id" is not null
  or (not "checkin_dm_enabled" and not "monitor_dm_enabled")
) not valid;
`,
  // This cleanup is irreversible; the constraint above prevents new invalid rows during repair.
  `
update "sheet_db_config_user_platform"
set
  "checkin_dm_enabled" = false,
  "monitor_dm_enabled" = false,
  "updated_at" = current_timestamp
where "default_client_id" is null
  and ("checkin_dm_enabled" = true or "monitor_dm_enabled" = true);
`,
] as const;

export default Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.forEach(invariantStatements, (statement) => sql.unsafe(statement).withoutTransform, {
    discard: true,
  }),
);
