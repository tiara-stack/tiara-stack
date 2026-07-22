// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
ALTER PUBLICATION "zero_data" DROP TABLE
  "public"."sheet_db_config_guild",
  "public"."sheet_db_config_guild_channel",
  "public"."sheet_db_config_guild_feature_flag",
  "public"."sheet_db_config_guild_manager_role",
  "public"."sheet_db_config_guild_update_announcement_delivery";
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
ALTER TABLE "sheet_db_config_guild"
  RENAME TO "sheet_db_config_workspace";
ALTER TABLE "sheet_db_config_workspace"
  RENAME COLUMN "guild_id" TO "workspace_id";
ALTER TABLE "sheet_db_config_workspace"
  RENAME CONSTRAINT "sheet_db_config_guild_pkey" TO "sheet_db_config_workspace_pkey";
ALTER INDEX "sheet_db_config_guild_sheet_id_idx"
  RENAME TO "sheet_db_config_workspace_sheet_id_idx";
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
ALTER TABLE "sheet_db_config_guild_manager_role"
  RENAME TO "sheet_db_config_workspace_monitor_role";
ALTER TABLE "sheet_db_config_workspace_monitor_role"
  RENAME COLUMN "guild_id" TO "workspace_id";
ALTER TABLE "sheet_db_config_workspace_monitor_role"
  RENAME CONSTRAINT "sheet_db_config_guild_manager_role_pkey" TO "sheet_db_config_workspace_monitor_role_pkey";
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
ALTER TABLE "sheet_db_config_guild_feature_flag"
  RENAME TO "sheet_db_config_workspace_feature_flag";
ALTER TABLE "sheet_db_config_workspace_feature_flag"
  RENAME COLUMN "guild_id" TO "workspace_id";
ALTER TABLE "sheet_db_config_workspace_feature_flag"
  RENAME CONSTRAINT "sheet_db_config_guild_feature_flag_pkey" TO "sheet_db_config_workspace_feature_flag_pkey";
ALTER TABLE "sheet_db_config_workspace_feature_flag"
  RENAME CONSTRAINT "sheet_db_config_guild_feature_flag_flag_name_non_empty_chk" TO "sheet_db_config_workspace_feature_flag_flag_name_non_empty_chk";
ALTER INDEX "sheet_db_config_guild_feature_flag_flag_name_idx"
  RENAME TO "sheet_db_config_workspace_feature_flag_flag_name_idx";
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
ALTER TABLE "sheet_db_config_guild_update_announcement_delivery"
  RENAME TO "sheet_db_config_workspace_update_announcement_delivery";
ALTER TABLE "sheet_db_config_workspace_update_announcement_delivery"
  RENAME COLUMN "guild_id" TO "workspace_id";
ALTER TABLE "sheet_db_config_workspace_update_announcement_delivery"
  RENAME COLUMN "channel_id" TO "conversation_id";
ALTER TABLE "sheet_db_config_workspace_update_announcement_delivery"
  RENAME CONSTRAINT "sheet_db_config_guild_update_announcement_delivery_pkey" TO "sheet_db_config_workspace_update_announcement_delivery_pkey";
ALTER INDEX "sheet_db_config_guild_update_announcement_delivery_announcement_id_idx"
  RENAME TO "sheet_db_config_workspace_update_ann_delivery_announcement_idx";
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
ALTER TABLE "sheet_db_config_guild_channel"
  RENAME TO "sheet_db_config_workspace_conversation";
ALTER TABLE "sheet_db_config_workspace_conversation"
  RENAME COLUMN "guild_id" TO "workspace_id";
ALTER TABLE "sheet_db_config_workspace_conversation"
  RENAME COLUMN "channel_id" TO "conversation_id";
ALTER TABLE "sheet_db_config_workspace_conversation"
  RENAME COLUMN "checkin_channel_id" TO "checkin_conversation_id";
ALTER TABLE "sheet_db_config_workspace_conversation"
  RENAME CONSTRAINT "sheet_db_config_guild_channel_pkey" TO "sheet_db_config_workspace_conversation_pkey";
ALTER INDEX "sheet_db_config_guild_channel_guild_id_name_idx"
  RENAME TO "sheet_db_config_workspace_conversation_workspace_id_name_idx";
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" SET TABLE
  "public"."sheet_db_config_workspace" ("auto_checkin", "created_at", "deleted_at", "sheet_id", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_conversation" ("checkin_conversation_id", "conversation_id", "created_at", "deleted_at", "name", "role_id", "running", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_feature_flag" ("created_at", "deleted_at", "flag_name", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_monitor_role" ("created_at", "deleted_at", "role_id", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_update_announcement_delivery" ("announcement_id", "conversation_id", "created_at", "deleted_at", "delivered_at", "message_id", "published_at", "updated_at", "workspace_id"),
  "public"."sheet_db_message_checkin" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "deleted_at", "hour", "initial_message", "message_id", "role_id", "running_conversation_id", "updated_at", "workspace_id"),
  "public"."sheet_db_message_checkin_member" ("checkin_at", "checkin_claim_id", "client_id", "client_platform", "created_at", "deleted_at", "member_id", "message_id", "updated_at"),
  "public"."sheet_db_message_room_order" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "deleted_at", "fills", "hour", "message_id", "monitor", "previous_fills", "rank", "send_claim_id", "send_claimed_at", "sent_at", "sent_conversation_id", "sent_message_id", "tentative", "tentative_pin_claim_id", "tentative_pin_claimed_at", "tentative_pinned_at", "tentative_update_claim_id", "tentative_update_claimed_at", "updated_at", "workspace_id"),
  "public"."sheet_db_message_room_order_entry" ("client_id", "client_platform", "created_at", "deleted_at", "effect_value", "hour", "message_id", "position", "rank", "tags", "team", "updated_at"),
  "public"."sheet_db_message_slot" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "day", "deleted_at", "message_id", "updated_at", "workspace_id"),
  "public"."sheet_db_sheet_apis_dispatch_jobs" ("created_at", "deleted_at", "dispatch_request_id", "entity_id", "entity_type", "error", "operation", "payload", "result", "run_id", "status", "updated_at");`)
    .withoutTransform;
});
