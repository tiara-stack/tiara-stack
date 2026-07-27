// This migration uses SqlClient from "effect/unstable/sql".
// That module is unstable and may change across minor Effect releases; pin Effect versions or update this import when the API stabilizes.
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql.unsafe(
    `alter table "sheet_db_config_workspace" add column "monitor_conversation_id" varchar`,
  ).withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(`ALTER PUBLICATION "zero_data" DROP TABLE "public"."sheet_db_config_workspace"`)
    .withoutTransform;

  // --> statement-breakpoint
  yield* sql.unsafe(
    `ALTER PUBLICATION "zero_data" ADD TABLE "public"."sheet_db_config_workspace" ("auto_checkin", "created_at", "deleted_at", "monitor_conversation_id", "sheet_id", "updated_at", "workspace_id")`,
  ).withoutTransform;

  yield* sql.unsafe(`
CREATE FUNCTION "sheet_db_enforce_monitor_conversation_separation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id, 0));

  IF TG_ARGV[0] = 'workspace' THEN
    IF NEW.deleted_at IS NULL
      AND NEW.monitor_conversation_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM "sheet_db_config_workspace_conversation" AS conversation
        WHERE conversation.workspace_id = NEW.workspace_id
          AND conversation.conversation_id = NEW.monitor_conversation_id
          AND conversation.running IS TRUE
          AND conversation.deleted_at IS NULL
      )
    THEN
      RAISE EXCEPTION 'The monitor channel cannot be a registered running channel'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_ARGV[0] = 'conversation'
    AND NEW.deleted_at IS NULL
    AND NEW.running IS TRUE
    AND EXISTS (
      SELECT 1
      FROM "sheet_db_config_workspace" AS workspace
      WHERE workspace.workspace_id = NEW.workspace_id
        AND workspace.monitor_conversation_id = NEW.conversation_id
        AND workspace.deleted_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'The monitor channel cannot be a registered running channel'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;`).withoutTransform;

  yield* sql.unsafe(`
CREATE TRIGGER "sheet_db_config_workspace_monitor_conversation_separation"
BEFORE INSERT OR UPDATE
ON "sheet_db_config_workspace"
FOR EACH ROW
EXECUTE FUNCTION "sheet_db_enforce_monitor_conversation_separation"('workspace');`)
    .withoutTransform;

  yield* sql.unsafe(`
CREATE TRIGGER "sheet_db_config_workspace_conversation_monitor_separation"
BEFORE INSERT OR UPDATE
ON "sheet_db_config_workspace_conversation"
FOR EACH ROW
EXECUTE FUNCTION "sheet_db_enforce_monitor_conversation_separation"('conversation');`)
    .withoutTransform;
});
