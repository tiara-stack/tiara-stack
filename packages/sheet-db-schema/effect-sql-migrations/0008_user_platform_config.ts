// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(`
CREATE TABLE "sheet_db_config_user_platform" (
  "platform" varchar NOT NULL,
  "user_id" varchar NOT NULL,
  "default_client_id" varchar,
  "checkin_dm_enabled" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "sheet_db_config_user_platform_pkey" PRIMARY KEY("platform","user_id")
);
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`
CREATE INDEX "sheet_db_config_user_platform_checkin_dm_recipient_idx"
ON "sheet_db_config_user_platform" ("platform", "user_id")
WHERE "checkin_dm_enabled" = true
  AND "default_client_id" IS NOT NULL
  AND "deleted_at" IS NULL;
`).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" SET TABLE
  "public"."sheet_db_config_user_platform" ("checkin_dm_enabled", "created_at", "default_client_id", "deleted_at", "platform", "updated_at", "user_id"),
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
