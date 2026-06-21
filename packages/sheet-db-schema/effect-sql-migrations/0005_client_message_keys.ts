// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
// fallow-ignore-file code-duplication
// fallow-ignore-next-line code-duplication
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
alter table "sheet_db_message_slot"
  add column "client_platform" varchar,
  add column "client_id" varchar;
update "sheet_db_message_slot"
  set "client_platform" = 'discord',
      "client_id" = 'discord-main';
alter table "sheet_db_message_slot"
  alter column "client_platform" set not null,
  alter column "client_id" set not null;
alter table "sheet_db_message_slot"
  rename column "guild_id" to "workspace_id";
alter table "sheet_db_message_slot"
  rename column "message_channel_id" to "conversation_id";
alter table "sheet_db_message_slot"
  drop constraint "sheet_db_message_slot_pkey",
  add primary key ("client_platform", "client_id", "message_id");
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
alter table "sheet_db_message_checkin"
  add column "client_platform" varchar,
  add column "client_id" varchar;
update "sheet_db_message_checkin"
  set "client_platform" = 'discord',
      "client_id" = 'discord-main';
alter table "sheet_db_message_checkin"
  alter column "client_platform" set not null,
  alter column "client_id" set not null;
alter table "sheet_db_message_checkin"
  rename column "channel_id" to "running_conversation_id";
alter table "sheet_db_message_checkin"
  rename column "guild_id" to "workspace_id";
alter table "sheet_db_message_checkin"
  rename column "message_channel_id" to "conversation_id";
alter table "sheet_db_message_checkin"
  drop constraint "sheet_db_message_checkin_pkey",
  add primary key ("client_platform", "client_id", "message_id");
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
alter table "sheet_db_message_checkin_member"
  add column "client_platform" varchar,
  add column "client_id" varchar;
update "sheet_db_message_checkin_member"
  set "client_platform" = 'discord',
      "client_id" = 'discord-main';
alter table "sheet_db_message_checkin_member"
  alter column "client_platform" set not null,
  alter column "client_id" set not null;
alter table "sheet_db_message_checkin_member"
  drop constraint "sheet_db_message_checkin_member_pkey",
  add primary key ("client_platform", "client_id", "message_id", "member_id");
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
alter table "sheet_db_message_room_order"
  add column "client_platform" varchar,
  add column "client_id" varchar;
update "sheet_db_message_room_order"
  set "client_platform" = 'discord',
      "client_id" = 'discord-main';
alter table "sheet_db_message_room_order"
  alter column "client_platform" set not null,
  alter column "client_id" set not null;
alter table "sheet_db_message_room_order"
  rename column "guild_id" to "workspace_id";
alter table "sheet_db_message_room_order"
  rename column "message_channel_id" to "conversation_id";
alter table "sheet_db_message_room_order"
  rename column "sent_message_channel_id" to "sent_conversation_id";
alter table "sheet_db_message_room_order"
  drop constraint "sheet_db_message_room_order_pkey",
  add primary key ("client_platform", "client_id", "message_id");
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
alter table "sheet_db_message_room_order_entry"
  add column "client_platform" varchar,
  add column "client_id" varchar;
update "sheet_db_message_room_order_entry"
  set "client_platform" = 'discord',
      "client_id" = 'discord-main';
alter table "sheet_db_message_room_order_entry"
  alter column "client_platform" set not null,
  alter column "client_id" set not null;
drop index "sheet_db_message_room_order_entry_message_id_rank_idx";
alter table "sheet_db_message_room_order_entry"
  drop constraint "sheet_db_message_room_order_entry_pkey",
  add primary key ("client_platform", "client_id", "message_id", "rank", "position");
create index "sheet_db_message_room_order_entry_client_message_rank_idx"
  on "sheet_db_message_room_order_entry" ("client_platform", "client_id", "message_id", "rank");
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
ALTER PUBLICATION "zero_data" DROP TABLE
  "public"."sheet_db_message_slot",
  "public"."sheet_db_message_checkin",
  "public"."sheet_db_message_checkin_member",
  "public"."sheet_db_message_room_order",
  "public"."sheet_db_message_room_order_entry";
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" ADD TABLE
  "public"."sheet_db_message_checkin" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "deleted_at", "hour", "initial_message", "message_id", "role_id", "running_conversation_id", "updated_at", "workspace_id"),
  "public"."sheet_db_message_checkin_member" ("checkin_at", "checkin_claim_id", "client_id", "client_platform", "created_at", "deleted_at", "member_id", "message_id", "updated_at"),
  "public"."sheet_db_message_room_order" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "deleted_at", "fills", "hour", "message_id", "monitor", "previous_fills", "rank", "send_claim_id", "send_claimed_at", "sent_at", "sent_conversation_id", "sent_message_id", "tentative", "tentative_pin_claim_id", "tentative_pin_claimed_at", "tentative_pinned_at", "tentative_update_claim_id", "tentative_update_claimed_at", "updated_at", "workspace_id"),
  "public"."sheet_db_message_room_order_entry" ("client_id", "client_platform", "created_at", "deleted_at", "effect_value", "hour", "message_id", "position", "rank", "tags", "team", "updated_at"),
  "public"."sheet_db_message_slot" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "day", "deleted_at", "message_id", "updated_at", "workspace_id");`)
    .withoutTransform;
});
