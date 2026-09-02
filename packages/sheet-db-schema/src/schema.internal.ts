import { pg } from "effect-sql-schema";
import type { EffectSqlTable } from "effect-sql-schema";
import {
  workflowCommand as effectZeroWorkflowCommand,
  workflowRun as effectZeroWorkflowRun,
} from "effect-zero-workflow";
import type { Model } from "effect/unstable/schema";
import {
  SheetConfigurationAuditOutcome,
  SheetConfigurationImportAttemptStatus,
  TeamSubmissionStatus,
} from "sheet-domain";
import { ReadonlyJSONValue } from "typhoon-zero/schema";
import {
  TeamSubmissionRemovedRowStrategy,
  TeamSubmissionWriteMode,
} from "./teamSubmissionChannelConfig";
type PgModel = Model.Any & Omit<EffectSqlTable<"postgresql">, "name">;
const asPgModel = <const T extends PgModel>(model: T) => model;

const createdAt = () =>
  pg.timestamp("created_at", { withTimezone: true }).notNull().generatedByApp();

const updatedAt = () =>
  pg.timestamp("updated_at", { withTimezone: true }).notNull().generatedByApp();

const deletedAt = () => pg.timestamp("deleted_at", { withTimezone: true });

class ConfigWorkspace extends pg.Class<ConfigWorkspace>("ConfigWorkspace")({
  table: "config_workspace",
  fields: {
    workspaceId: pg.varchar("workspace_id").primaryKey(),
    sheetId: pg.varchar("sheet_id"),
    autoCheckin: pg.boolean("auto_checkin"),
    monitorConversationId: pg.varchar("monitor_conversation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  indexes: [pg.index("config_workspace_sheet_id_idx").on("sheetId")],
}) {}

class ConfigWorkspaceSheet extends pg.Class<ConfigWorkspaceSheet>("ConfigWorkspaceSheet")({
  table: "config_workspace_sheet",
  fields: {
    workspaceId: pg.varchar("workspace_id").primaryKey(),
    source: pg.jsonb("source").notNull().decodeTo(ReadonlyJSONValue),
    legacyBinding: pg.jsonb("legacy_binding").decodeTo(ReadonlyJSONValue),
    draftVersion: pg.integer("draft_version").notNull(),
    baseRevisionId: pg.varchar("base_revision_id"),
    baselineDigest: pg.varchar("baseline_digest"),
    draft: pg.jsonb("draft").decodeTo(ReadonlyJSONValue),
    diagnostics: pg.jsonb("diagnostics").notNull().decodeTo(ReadonlyJSONValue),
    activeRevisionId: pg.varchar("active_revision_id"),
    updatedBy: pg.varchar("updated_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
}) {}

class ConfigWorkspaceSheetRevision extends pg.Class<ConfigWorkspaceSheetRevision>(
  "ConfigWorkspaceSheetRevision",
)({
  table: "config_workspace_sheet_revision",
  fields: {
    workspaceId: pg.varchar("workspace_id").notNull(),
    revisionId: pg.varchar("revision_id").notNull(),
    spreadsheetId: pg.varchar("spreadsheet_id").notNull(),
    configuration: pg.jsonb("configuration").notNull().decodeTo(ReadonlyJSONValue),
    createdBy: pg.varchar("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["workspaceId", "revisionId"],
  indexes: [pg.index("config_workspace_sheet_revision_spreadsheet_idx").on("spreadsheetId")],
}) {}

class ConfigWorkspaceSheetImportAttempt extends pg.Class<ConfigWorkspaceSheetImportAttempt>(
  "ConfigWorkspaceSheetImportAttempt",
)({
  table: "config_workspace_sheet_import_attempt",
  fields: {
    attemptId: pg.varchar("attempt_id").primaryKey(),
    workspaceId: pg.varchar("workspace_id").notNull(),
    status: pg.varchar("status").notNull().decodeTo(SheetConfigurationImportAttemptStatus),
    sourceBinding: pg.jsonb("source_binding").notNull().decodeTo(ReadonlyJSONValue),
    baselineDigest: pg.varchar("baseline_digest").notNull(),
    result: pg.jsonb("result").decodeTo(ReadonlyJSONValue),
    createdBy: pg.varchar("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  indexes: [pg.index("config_workspace_sheet_import_attempt_workspace_idx").on("workspaceId")],
}) {}

/**
 * Application-owned audit events are append-only and retained indefinitely. `deletedAt` remains
 * solely as the Zero tombstone column; no Sheet Configuration operation purges or edits events.
 */
class AuditSheetConfiguration extends pg.Class<AuditSheetConfiguration>("AuditSheetConfiguration")({
  table: "audit_sheet_configuration",
  fields: {
    eventId: pg.varchar("event_id").primaryKey(),
    workspaceId: pg.varchar("workspace_id").notNull(),
    operation: pg.varchar("operation").notNull(),
    outcome: pg.varchar("outcome").notNull().decodeTo(SheetConfigurationAuditOutcome),
    invocationId: pg.varchar("invocation_id"),
    effectivePrincipal: pg.jsonb("effective_principal").notNull().decodeTo(ReadonlyJSONValue),
    actorProvenance: pg.jsonb("actor_provenance").decodeTo(ReadonlyJSONValue),
    metadata: pg.jsonb("metadata").notNull().decodeTo(ReadonlyJSONValue),
    reason: pg.varchar("reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  indexes: [
    pg.index("audit_sheet_configuration_workspace_created_idx").on("workspaceId", "createdAt"),
  ],
}) {}

class ConfigWorkspaceMonitorRole extends pg.Class<ConfigWorkspaceMonitorRole>(
  "ConfigWorkspaceMonitorRole",
)({
  table: "config_workspace_monitor_role",
  fields: {
    workspaceId: pg.varchar("workspace_id").notNull(),
    roleId: pg.varchar("role_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["workspaceId", "roleId"],
}) {}

class ConfigWorkspaceFeatureFlag extends pg.Class<ConfigWorkspaceFeatureFlag>(
  "ConfigWorkspaceFeatureFlag",
)({
  table: "config_workspace_feature_flag",
  fields: {
    workspaceId: pg.varchar("workspace_id").notNull(),
    flagName: pg.varchar("flag_name").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["workspaceId", "flagName"],
  indexes: [pg.index("config_workspace_feature_flag_flag_name_idx").on("flagName")],
}) {}

class ConfigWorkspaceUpdateAnnouncementDelivery extends pg.Class<ConfigWorkspaceUpdateAnnouncementDelivery>(
  "ConfigWorkspaceUpdateAnnouncementDelivery",
)({
  table: "config_workspace_update_announcement_delivery",
  fields: {
    workspaceId: pg.varchar("workspace_id").notNull(),
    announcementId: pg.varchar("announcement_id").notNull(),
    publishedAt: pg.timestamp("published_at", { withTimezone: true }).notNull(),
    deliveredAt: pg.timestamp("delivered_at", { withTimezone: true }).notNull(),
    conversationId: pg.varchar("conversation_id").notNull(),
    messageId: pg.varchar("message_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["workspaceId", "announcementId"],
  indexes: [pg.index("config_workspace_update_ann_delivery_announcement_idx").on("announcementId")],
}) {}

class ConfigUserPlatform extends pg.Class<ConfigUserPlatform>("ConfigUserPlatform")({
  table: "config_user_platform",
  fields: {
    platform: pg.varchar("platform").notNull(),
    userId: pg.varchar("user_id").notNull(),
    defaultClientId: pg.varchar("default_client_id"),
    checkinDmEnabled: pg.boolean("checkin_dm_enabled").notNull(),
    monitorDmEnabled: pg.boolean("monitor_dm_enabled").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["platform", "userId"],
}) {}

class ConfigWorkspaceConversation extends pg.Class<ConfigWorkspaceConversation>(
  "ConfigWorkspaceConversation",
)({
  table: "config_workspace_conversation",
  fields: {
    workspaceId: pg.varchar("workspace_id").notNull(),
    conversationId: pg.varchar("conversation_id").notNull(),
    name: pg.varchar("name"),
    running: pg.boolean("running"),
    roleId: pg.varchar("role_id"),
    checkinConversationId: pg.varchar("checkin_conversation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["workspaceId", "conversationId"],
  indexes: [
    pg.uniqueIndex("config_workspace_conversation_workspace_id_name_idx").on("workspaceId", "name"),
  ],
}) {}

class ConfigWorkspaceTeamSubmissionChannel extends pg.Class<ConfigWorkspaceTeamSubmissionChannel>(
  "ConfigWorkspaceTeamSubmissionChannel",
)({
  table: "config_workspace_team_submission_channel",
  fields: {
    workspaceId: pg.varchar("workspace_id").notNull(),
    conversationId: pg.varchar("conversation_id").notNull(),
    destinationTeamConfigName: pg.varchar("destination_team_config_name"),
    writeMode: pg.varchar("write_mode").notNull().decodeTo(TeamSubmissionWriteMode),
    removedRowStrategy: pg
      .varchar("removed_row_strategy")
      .notNull()
      .decodeTo(TeamSubmissionRemovedRowStrategy),
    requireValidOshi: pg.boolean("require_valid_oshi").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["workspaceId", "conversationId"],
  indexes: [pg.index("config_workspace_team_sub_channel_conv_idx").on("conversationId")],
}) {}

class MessageSlot extends pg.Class<MessageSlot>("MessageSlot")({
  table: "message_slot",
  fields: {
    clientPlatform: pg.varchar("client_platform").notNull(),
    clientId: pg.varchar("client_id").notNull(),
    messageId: pg.varchar("message_id").notNull(),
    day: pg.integer("day").notNull(),
    workspaceId: pg.varchar("workspace_id"),
    conversationId: pg.varchar("conversation_id"),
    createdByUserId: pg.varchar("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["clientPlatform", "clientId", "messageId"],
}) {}

class MessageCheckin extends pg.Class<MessageCheckin>("MessageCheckin")({
  table: "message_checkin",
  fields: {
    clientPlatform: pg.varchar("client_platform").notNull(),
    clientId: pg.varchar("client_id").notNull(),
    messageId: pg.varchar("message_id").notNull(),
    initialMessage: pg.jsonb("initial_message").notNull().decodeTo(ReadonlyJSONValue),
    hour: pg.integer("hour").notNull(),
    runningConversationId: pg.varchar("running_conversation_id").notNull(),
    roleId: pg.varchar("role_id"),
    workspaceId: pg.varchar("workspace_id"),
    conversationId: pg.varchar("conversation_id"),
    createdByUserId: pg.varchar("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["clientPlatform", "clientId", "messageId"],
}) {}

class MessageCheckinMember extends pg.Class<MessageCheckinMember>("MessageCheckinMember")({
  table: "message_checkin_member",
  fields: {
    clientPlatform: pg.varchar("client_platform").notNull(),
    clientId: pg.varchar("client_id").notNull(),
    messageId: pg.varchar("message_id").notNull(),
    memberId: pg.varchar("member_id").notNull(),
    checkinAt: pg.timestamp("checkin_at", { withTimezone: true }),
    checkinClaimId: pg.varchar("checkin_claim_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["clientPlatform", "clientId", "messageId", "memberId"],
}) {}

class MessageRoomOrder extends pg.Class<MessageRoomOrder>("MessageRoomOrder")({
  table: "message_room_order",
  fields: {
    clientPlatform: pg.varchar("client_platform").notNull(),
    clientId: pg.varchar("client_id").notNull(),
    messageId: pg.varchar("message_id").notNull(),
    previousFills: pg.varchar("previous_fills").array().notNull(),
    fills: pg.varchar("fills").array().notNull(),
    hour: pg.integer("hour").notNull(),
    rank: pg.integer("rank").notNull(),
    tentative: pg.boolean("tentative").notNull(),
    monitor: pg.varchar("monitor"),
    workspaceId: pg.varchar("workspace_id"),
    conversationId: pg.varchar("conversation_id"),
    createdByUserId: pg.varchar("created_by_user_id"),
    sendClaimId: pg.varchar("send_claim_id"),
    sendClaimedAt: pg.timestamp("send_claimed_at", { withTimezone: true }),
    sentMessageId: pg.varchar("sent_message_id"),
    sentConversationId: pg.varchar("sent_conversation_id"),
    sentAt: pg.timestamp("sent_at", { withTimezone: true }),
    tentativeUpdateClaimId: pg.varchar("tentative_update_claim_id"),
    tentativeUpdateClaimedAt: pg.timestamp("tentative_update_claimed_at", { withTimezone: true }),
    tentativePinClaimId: pg.varchar("tentative_pin_claim_id"),
    tentativePinClaimedAt: pg.timestamp("tentative_pin_claimed_at", { withTimezone: true }),
    tentativePinnedAt: pg.timestamp("tentative_pinned_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["clientPlatform", "clientId", "messageId"],
}) {}

class MessageRoomOrderEntry extends pg.Class<MessageRoomOrderEntry>("MessageRoomOrderEntry")({
  table: "message_room_order_entry",
  fields: {
    clientPlatform: pg.varchar("client_platform").notNull(),
    clientId: pg.varchar("client_id").notNull(),
    messageId: pg.varchar("message_id").notNull(),
    rank: pg.integer("rank").notNull(),
    position: pg.integer("position").notNull(),
    hour: pg.integer("hour").notNull(),
    team: pg.varchar("team").notNull(),
    tags: pg.varchar("tags").array().notNull(),
    effectValue: pg.real("effect_value").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["clientPlatform", "clientId", "messageId", "rank", "position"],
  indexes: [
    pg
      .index("message_room_order_entry_client_message_rank_idx")
      .on("clientPlatform", "clientId", "messageId", "rank"),
  ],
}) {}

class MessageTeamSubmission extends pg.Class<MessageTeamSubmission>("MessageTeamSubmission")({
  table: "message_team_submission",
  fields: {
    workspaceId: pg.varchar("workspace_id").notNull(),
    conversationId: pg.varchar("conversation_id").notNull(),
    messageId: pg.varchar("message_id").notNull(),
    clientPlatform: pg.varchar("client_platform").notNull(),
    clientId: pg.varchar("client_id").notNull(),
    discordGuildId: pg.varchar("discord_guild_id").notNull(),
    discordChannelId: pg.varchar("discord_channel_id").notNull(),
    discordAuthorId: pg.varchar("discord_author_id").notNull(),
    sheetId: pg.varchar("sheet_id").notNull(),
    sheetConfigurationBinding: pg.jsonb("sheet_configuration_binding").decodeTo(ReadonlyJSONValue),
    confirmationMessageId: pg.varchar("confirmation_message_id"),
    parsedSubmission: pg.jsonb("parsed_submission").notNull().decodeTo(ReadonlyJSONValue),
    rowMappings: pg.jsonb("row_mappings").notNull().decodeTo(ReadonlyJSONValue),
    rollbackSnapshot: pg.jsonb("rollback_snapshot").decodeTo(ReadonlyJSONValue),
    version: pg.integer("version").notNull(),
    status: pg.varchar("status").notNull().decodeTo(TeamSubmissionStatus),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["workspaceId", "conversationId", "messageId"],
  indexes: [
    pg
      .uniqueIndex("message_team_submission_discord_message_idx")
      .on("discordGuildId", "discordChannelId", "messageId"),
    pg
      .index("message_team_submission_client_message_idx")
      .on("clientPlatform", "clientId", "messageId"),
  ],
}) {}

class SheetApisDispatchJobs extends pg.Class<SheetApisDispatchJobs>("SheetApisDispatchJobs")({
  table: "sheet_apis_dispatch_jobs",
  fields: {
    dispatchRequestId: pg.text("dispatch_request_id").primaryKey(),
    entityType: pg.text("entity_type").notNull(),
    entityId: pg.text("entity_id").notNull(),
    operation: pg.text("operation").notNull(),
    status: pg.text("status").notNull(),
    runId: pg.text("run_id"),
    payload: pg.jsonb("payload").notNull().decodeTo(ReadonlyJSONValue),
    result: pg.jsonb("result").decodeTo(ReadonlyJSONValue),
    error: pg.jsonb("error").decodeTo(ReadonlyJSONValue),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  indexes: [pg.index("sheet_apis_dispatch_jobs_status_updated_at_idx").on("status", "updatedAt")],
}) {}

export const configWorkspace = asPgModel(ConfigWorkspace);
export const configWorkspaceSheet = asPgModel(ConfigWorkspaceSheet);
export const configWorkspaceSheetRevision = asPgModel(ConfigWorkspaceSheetRevision);
export const configWorkspaceSheetImportAttempt = asPgModel(ConfigWorkspaceSheetImportAttempt);
export const auditSheetConfiguration = asPgModel(AuditSheetConfiguration);
export const configWorkspaceMonitorRole = asPgModel(ConfigWorkspaceMonitorRole);
export const configWorkspaceFeatureFlag = asPgModel(ConfigWorkspaceFeatureFlag);
export const configWorkspaceUpdateAnnouncementDelivery = asPgModel(
  ConfigWorkspaceUpdateAnnouncementDelivery,
);
export const configUserPlatform = asPgModel(ConfigUserPlatform);
export const configWorkspaceConversation = asPgModel(ConfigWorkspaceConversation);
export const configWorkspaceTeamSubmissionChannel = asPgModel(ConfigWorkspaceTeamSubmissionChannel);
export const messageSlot = asPgModel(MessageSlot);
export const messageCheckin = asPgModel(MessageCheckin);
export const messageCheckinMember = asPgModel(MessageCheckinMember);
export const messageRoomOrder = asPgModel(MessageRoomOrder);
export const messageRoomOrderEntry = asPgModel(MessageRoomOrderEntry);
export const messageTeamSubmission = asPgModel(MessageTeamSubmission);
export const sheetApisDispatchJobs = asPgModel(SheetApisDispatchJobs);
export const workflowRun = asPgModel(effectZeroWorkflowRun);
export const workflowCommand = asPgModel(effectZeroWorkflowCommand);
