// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`create table "sheet_db_config_guild_feature_flag" (
  "guild_id" varchar not null,
  "flag_name" varchar not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone,
  constraint "sheet_db_config_guild_feature_flag_flag_name_non_empty_chk"
    check (char_length(btrim("flag_name")) > 0),
  primary key ("guild_id", "flag_name")
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_config_guild_feature_flag_flag_name_idx" on "sheet_db_config_guild_feature_flag" ("flag_name")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" ADD TABLE
  "public"."sheet_db_config_guild_feature_flag" ("created_at", "deleted_at", "flag_name", "guild_id", "updated_at");`)
    .withoutTransform;
});
