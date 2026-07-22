// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`create table "sheet_db_config_guild_update_announcement_delivery" (
  "guild_id" varchar not null,
  "announcement_id" varchar not null,
  "published_at" timestamp with time zone not null,
  "delivered_at" timestamp with time zone not null,
  "channel_id" varchar not null,
  "message_id" varchar not null,
  "created_at" timestamp with time zone not null,
  "updated_at" timestamp with time zone not null,
  "deleted_at" timestamp with time zone,
  primary key ("guild_id", "announcement_id")
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_config_guild_update_announcement_delivery_announcement_id_idx" on "sheet_db_config_guild_update_announcement_delivery" ("announcement_id")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" ADD TABLE
  "public"."sheet_db_config_guild_update_announcement_delivery" ("announcement_id", "channel_id", "created_at", "deleted_at", "delivered_at", "guild_id", "message_id", "published_at", "updated_at");`)
    .withoutTransform;
});
