// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`alter table "sheet_db_config_guild" alter column "created_at" drop default`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`alter table "sheet_db_config_guild" alter column "updated_at" drop default`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_config_guild_manager_role" alter column "created_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_config_guild_manager_role" alter column "updated_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_config_guild_channel" alter column "created_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_config_guild_channel" alter column "updated_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`alter table "sheet_db_message_slot" alter column "created_at" drop default`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`alter table "sheet_db_message_slot" alter column "updated_at" drop default`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`alter table "sheet_db_message_checkin" alter column "created_at" drop default`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`alter table "sheet_db_message_checkin" alter column "updated_at" drop default`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_message_checkin_member" alter column "created_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_message_checkin_member" alter column "updated_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_message_room_order" alter column "tentative" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_message_room_order" alter column "created_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_message_room_order" alter column "updated_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_message_room_order_entry" alter column "created_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_message_room_order_entry" alter column "updated_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_sheet_apis_dispatch_jobs" alter column "created_at" drop default`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `alter table "sheet_db_sheet_apis_dispatch_jobs" alter column "updated_at" drop default`,
  ).withoutTransform;
});
