// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(
    `alter table "sheet_db_config_workspace_sheet" add column "legacy_binding" jsonb`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" SET TABLE
  "public"."sheet_db_audit_sheet_configuration" ("actor_provenance", "created_at", "deleted_at", "effective_principal", "event_id", "invocation_id", "metadata", "operation", "outcome", "reason", "updated_at", "workspace_id"),
  "public"."sheet_db_config_user_platform" ("checkin_dm_enabled", "created_at", "default_client_id", "deleted_at", "monitor_dm_enabled", "platform", "updated_at", "user_id"),
  "public"."sheet_db_config_workspace" ("auto_checkin", "created_at", "deleted_at", "monitor_conversation_id", "sheet_id", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_conversation" ("checkin_conversation_id", "conversation_id", "created_at", "deleted_at", "name", "role_id", "running", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_feature_flag" ("created_at", "deleted_at", "flag_name", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_monitor_role" ("created_at", "deleted_at", "role_id", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_sheet" ("active_revision_id", "base_revision_id", "baseline_digest", "created_at", "deleted_at", "diagnostics", "draft", "draft_version", "legacy_binding", "source", "updated_at", "updated_by", "workspace_id"),
  "public"."sheet_db_config_workspace_sheet_import_attempt" ("attempt_id", "baseline_digest", "created_at", "created_by", "deleted_at", "result", "source_binding", "status", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_sheet_revision" ("configuration", "created_at", "created_by", "deleted_at", "revision_id", "spreadsheet_id", "updated_at", "workspace_id"),
  "public"."sheet_db_config_workspace_team_submission_channel" ("conversation_id", "created_at", "deleted_at", "destination_team_config_name", "removed_row_strategy", "require_valid_oshi", "updated_at", "workspace_id", "write_mode"),
  "public"."sheet_db_config_workspace_update_announcement_delivery" ("announcement_id", "conversation_id", "created_at", "deleted_at", "delivered_at", "message_id", "published_at", "updated_at", "workspace_id"),
  "public"."sheet_db_message_checkin" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "deleted_at", "hour", "initial_message", "message_id", "role_id", "running_conversation_id", "updated_at", "workspace_id"),
  "public"."sheet_db_message_checkin_member" ("checkin_at", "checkin_claim_id", "client_id", "client_platform", "created_at", "deleted_at", "member_id", "message_id", "updated_at"),
  "public"."sheet_db_message_room_order" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "deleted_at", "fills", "hour", "message_id", "monitor", "previous_fills", "rank", "send_claim_id", "send_claimed_at", "sent_at", "sent_conversation_id", "sent_message_id", "tentative", "tentative_pin_claim_id", "tentative_pin_claimed_at", "tentative_pinned_at", "tentative_update_claim_id", "tentative_update_claimed_at", "updated_at", "workspace_id"),
  "public"."sheet_db_message_room_order_entry" ("client_id", "client_platform", "created_at", "deleted_at", "effect_value", "hour", "message_id", "position", "rank", "tags", "team", "updated_at"),
  "public"."sheet_db_message_slot" ("client_id", "client_platform", "conversation_id", "created_at", "created_by_user_id", "day", "deleted_at", "message_id", "updated_at", "workspace_id"),
  "public"."sheet_db_message_team_submission" ("client_id", "client_platform", "confirmation_message_id", "conversation_id", "created_at", "deleted_at", "discord_author_id", "discord_channel_id", "discord_guild_id", "message_id", "parsed_submission", "rollback_snapshot", "row_mappings", "sheet_id", "status", "updated_at", "version", "workspace_id"),
  "public"."sheet_db_sheet_apis_dispatch_jobs" ("created_at", "deleted_at", "dispatch_request_id", "entity_id", "entity_type", "error", "operation", "payload", "result", "run_id", "status", "updated_at"),
  "public"."sheet_db_workflow_run" ("completed_at", "created_at", "definition_version", "error", "result", "run_after", "run_id", "started_at", "status", "updated_at", "visibility_key", "workflow_name");`)
    .withoutTransform;

  // Notify Zero after changing the custom publication's column set.
  yield* sql.unsafe(`COMMENT ON PUBLICATION "zero_data" IS 'sheet-db-schema publication update'`)
    .withoutTransform;
});
