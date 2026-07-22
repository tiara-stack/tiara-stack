// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`create table "sheet_db_config_guild" (
  "guild_id" varchar not null primary key,
  "sheet_id" varchar,
  "auto_checkin" boolean,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_config_guild_sheet_id_idx" on "sheet_db_config_guild" ("sheet_id")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_config_guild_manager_role" (
  "guild_id" varchar not null,
  "role_id" varchar not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone,
  primary key ("guild_id", "role_id")
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_config_guild_channel" (
  "guild_id" varchar not null,
  "channel_id" varchar not null,
  "name" varchar,
  "running" boolean,
  "role_id" varchar,
  "checkin_channel_id" varchar,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone,
  primary key ("guild_id", "channel_id")
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create unique index "sheet_db_config_guild_channel_guild_id_name_idx" on "sheet_db_config_guild_channel" ("guild_id", "name")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_message_slot" (
  "message_id" varchar not null primary key,
  "day" integer not null,
  "guild_id" varchar,
  "message_channel_id" varchar,
  "created_by_user_id" varchar,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_message_checkin" (
  "message_id" varchar not null primary key,
  "initial_message" varchar not null,
  "hour" integer not null,
  "channel_id" varchar not null,
  "role_id" varchar,
  "guild_id" varchar,
  "message_channel_id" varchar,
  "created_by_user_id" varchar,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_message_checkin_member" (
  "message_id" varchar not null,
  "member_id" varchar not null,
  "checkin_at" timestamp with time zone,
  "checkin_claim_id" varchar,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone,
  primary key ("message_id", "member_id")
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_message_room_order" (
  "message_id" varchar not null primary key,
  "previous_fills" varchar[] not null,
  "fills" varchar[] not null,
  "hour" integer not null,
  "rank" integer not null,
  "tentative" boolean not null default false,
  "monitor" varchar,
  "guild_id" varchar,
  "message_channel_id" varchar,
  "created_by_user_id" varchar,
  "send_claim_id" varchar,
  "send_claimed_at" timestamp with time zone,
  "sent_message_id" varchar,
  "sent_message_channel_id" varchar,
  "sent_at" timestamp with time zone,
  "tentative_update_claim_id" varchar,
  "tentative_update_claimed_at" timestamp with time zone,
  "tentative_pin_claim_id" varchar,
  "tentative_pin_claimed_at" timestamp with time zone,
  "tentative_pinned_at" timestamp with time zone,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_message_room_order_entry" (
  "message_id" varchar not null,
  "rank" integer not null,
  "position" integer not null,
  "hour" integer not null,
  "team" varchar not null,
  "tags" varchar[] not null,
  "effect_value" real not null,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone,
  primary key ("message_id", "rank", "position")
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_message_room_order_entry_message_id_rank_idx" on "sheet_db_message_room_order_entry" ("message_id", "rank")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`create table "sheet_db_sheet_apis_dispatch_jobs" (
  "dispatch_request_id" text not null primary key,
  "entity_type" text not null,
  "entity_id" text not null,
  "operation" text not null,
  "status" text not null,
  "run_id" text,
  "payload" jsonb not null,
  "result" jsonb,
  "error" jsonb,
  "created_at" timestamp with time zone not null default now(),
  "updated_at" timestamp with time zone not null default now(),
  "deleted_at" timestamp with time zone
)`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `create index "sheet_db_sheet_apis_dispatch_jobs_status_updated_at_idx" on "sheet_db_sheet_apis_dispatch_jobs" ("status", "updated_at")`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`CREATE PUBLICATION "zero_data" FOR TABLE
  "public"."sheet_db_config_guild" ("auto_checkin", "created_at", "deleted_at", "guild_id", "sheet_id", "updated_at"),
  "public"."sheet_db_config_guild_channel" ("channel_id", "checkin_channel_id", "created_at", "deleted_at", "guild_id", "name", "role_id", "running", "updated_at"),
  "public"."sheet_db_config_guild_manager_role" ("created_at", "deleted_at", "guild_id", "role_id", "updated_at"),
  "public"."sheet_db_message_checkin" ("channel_id", "created_at", "created_by_user_id", "deleted_at", "guild_id", "hour", "initial_message", "message_channel_id", "message_id", "role_id", "updated_at"),
  "public"."sheet_db_message_checkin_member" ("checkin_at", "checkin_claim_id", "created_at", "deleted_at", "member_id", "message_id", "updated_at"),
  "public"."sheet_db_message_room_order" ("created_at", "created_by_user_id", "deleted_at", "fills", "guild_id", "hour", "message_channel_id", "message_id", "monitor", "previous_fills", "rank", "send_claim_id", "send_claimed_at", "sent_at", "sent_message_channel_id", "sent_message_id", "tentative", "tentative_pin_claim_id", "tentative_pin_claimed_at", "tentative_pinned_at", "tentative_update_claim_id", "tentative_update_claimed_at", "updated_at"),
  "public"."sheet_db_message_room_order_entry" ("created_at", "deleted_at", "effect_value", "hour", "message_id", "position", "rank", "tags", "team", "updated_at"),
  "public"."sheet_db_message_slot" ("created_at", "created_by_user_id", "day", "deleted_at", "guild_id", "message_channel_id", "message_id", "updated_at"),
  "public"."sheet_db_sheet_apis_dispatch_jobs" ("created_at", "deleted_at", "dispatch_request_id", "entity_id", "entity_type", "error", "operation", "payload", "result", "run_id", "status", "updated_at");`)
    .withoutTransform;
});
