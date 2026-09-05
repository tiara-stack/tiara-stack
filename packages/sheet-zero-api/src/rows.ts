import { Schema } from "effect";
import {
  SheetConfigurationAuditOutcome,
  SheetConfigurationImportAttemptStatus,
  TeamSubmissionStatus,
} from "sheet-domain";
import { ReadonlyJSONValue } from "typhoon-zero/schema";

const auditFields = {
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  deletedAt: Schema.NullOr(Schema.Number),
} as const;

const messageKeyFields = {
  clientPlatform: Schema.String,
  clientId: Schema.String,
  messageId: Schema.String,
} as const;

export const TeamSubmissionWriteMode = Schema.Literals(["upsert"]);
export type TeamSubmissionWriteMode = Schema.Schema.Type<typeof TeamSubmissionWriteMode>;

export const TeamSubmissionRemovedRowStrategy = Schema.Literals(["blank"]);
export type TeamSubmissionRemovedRowStrategy = Schema.Schema.Type<
  typeof TeamSubmissionRemovedRowStrategy
>;

export const ConfigWorkspaceRow = Schema.Struct({
  workspaceId: Schema.String,
  sheetId: Schema.NullOr(Schema.String),
  autoCheckin: Schema.NullOr(Schema.Boolean),
  monitorConversationId: Schema.NullOr(Schema.String),
  ...auditFields,
});
export type ConfigWorkspaceRow = typeof ConfigWorkspaceRow.Type;

export const ConfigWorkspaceSheetRow = Schema.Struct({
  workspaceId: Schema.String,
  source: ReadonlyJSONValue,
  legacyBinding: Schema.NullOr(ReadonlyJSONValue),
  draftVersion: Schema.Number,
  baseRevisionId: Schema.NullOr(Schema.String),
  baselineDigest: Schema.NullOr(Schema.String),
  draft: Schema.NullOr(ReadonlyJSONValue),
  diagnostics: ReadonlyJSONValue,
  activeRevisionId: Schema.NullOr(Schema.String),
  updatedBy: Schema.NullOr(Schema.String),
  ...auditFields,
});
export type ConfigWorkspaceSheetRow = typeof ConfigWorkspaceSheetRow.Type;

export const ConfigWorkspaceSheetRevisionRow = Schema.Struct({
  workspaceId: Schema.String,
  revisionId: Schema.String,
  spreadsheetId: Schema.String,
  configuration: ReadonlyJSONValue,
  createdBy: Schema.String,
  ...auditFields,
});
export type ConfigWorkspaceSheetRevisionRow = typeof ConfigWorkspaceSheetRevisionRow.Type;

export const ConfigWorkspaceSheetImportAttemptRow = Schema.Struct({
  attemptId: Schema.String,
  workspaceId: Schema.String,
  status: SheetConfigurationImportAttemptStatus,
  sourceBinding: ReadonlyJSONValue,
  baselineDigest: Schema.String,
  result: Schema.NullOr(ReadonlyJSONValue),
  createdBy: Schema.String,
  ...auditFields,
});
export type ConfigWorkspaceSheetImportAttemptRow = typeof ConfigWorkspaceSheetImportAttemptRow.Type;

export const AuditSheetConfigurationRow = Schema.Struct({
  eventId: Schema.String,
  workspaceId: Schema.String,
  operation: Schema.String,
  outcome: SheetConfigurationAuditOutcome,
  invocationId: Schema.NullOr(Schema.String),
  effectivePrincipal: ReadonlyJSONValue,
  actorProvenance: Schema.NullOr(ReadonlyJSONValue),
  metadata: ReadonlyJSONValue,
  reason: Schema.NullOr(Schema.String),
  ...auditFields,
});
export type AuditSheetConfigurationRow = typeof AuditSheetConfigurationRow.Type;

export const ConfigWorkspaceCheckinMessageSetRow = Schema.Struct({
  workspaceId: Schema.String,
  eventStartEpochMs: Schema.Number,
  messageSetGeneration: Schema.Number,
  updatedBy: Schema.String,
  ...auditFields,
});
export type ConfigWorkspaceCheckinMessageSetRow = typeof ConfigWorkspaceCheckinMessageSetRow.Type;

export const ConfigWorkspaceCheckinMessageRow = Schema.Struct({
  workspaceId: Schema.String,
  messageSetGeneration: Schema.Number,
  conversationId: Schema.String,
  hour: Schema.Number,
  template: Schema.NullOr(Schema.String),
  version: Schema.Number,
  createdBy: Schema.String,
  updatedBy: Schema.String,
  ...auditFields,
});
export type ConfigWorkspaceCheckinMessageRow = typeof ConfigWorkspaceCheckinMessageRow.Type;

export const ConfigWorkspaceCheckinMessageMutationReceiptRow = Schema.Struct({
  invocationId: Schema.String,
  actionKey: Schema.String,
  workspaceId: Schema.String,
  inputDigest: Schema.String,
  result: ReadonlyJSONValue,
  createdBy: Schema.String,
  ...auditFields,
});
export type ConfigWorkspaceCheckinMessageMutationReceiptRow =
  typeof ConfigWorkspaceCheckinMessageMutationReceiptRow.Type;

export const ConfigWorkspaceMonitorRoleRow = Schema.Struct({
  workspaceId: Schema.String,
  roleId: Schema.String,
  ...auditFields,
});
export type ConfigWorkspaceMonitorRoleRow = typeof ConfigWorkspaceMonitorRoleRow.Type;

export const ConfigWorkspaceFeatureFlagRow = Schema.Struct({
  workspaceId: Schema.String,
  flagName: Schema.String,
  ...auditFields,
});
export type ConfigWorkspaceFeatureFlagRow = typeof ConfigWorkspaceFeatureFlagRow.Type;

export const ConfigWorkspaceUpdateAnnouncementDeliveryRow = Schema.Struct({
  workspaceId: Schema.String,
  announcementId: Schema.String,
  publishedAt: Schema.Number,
  deliveredAt: Schema.Number,
  conversationId: Schema.String,
  messageId: Schema.String,
  ...auditFields,
});
export type ConfigWorkspaceUpdateAnnouncementDeliveryRow =
  typeof ConfigWorkspaceUpdateAnnouncementDeliveryRow.Type;

export const ConfigUserPlatformRow = Schema.Struct({
  platform: Schema.String,
  userId: Schema.String,
  defaultClientId: Schema.NullOr(Schema.String),
  checkinDmEnabled: Schema.Boolean,
  monitorDmEnabled: Schema.Boolean,
  ...auditFields,
});
export type ConfigUserPlatformRow = typeof ConfigUserPlatformRow.Type;

export const ConfigWorkspaceConversationRow = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
  name: Schema.NullOr(Schema.String),
  running: Schema.NullOr(Schema.Boolean),
  roleId: Schema.NullOr(Schema.String),
  checkinConversationId: Schema.NullOr(Schema.String),
  ...auditFields,
});
export type ConfigWorkspaceConversationRow = typeof ConfigWorkspaceConversationRow.Type;

export const ConfigWorkspaceTeamSubmissionChannelRow = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
  destinationTeamConfigName: Schema.NullOr(Schema.String),
  writeMode: TeamSubmissionWriteMode,
  removedRowStrategy: TeamSubmissionRemovedRowStrategy,
  requireValidOshi: Schema.Boolean,
  ...auditFields,
});
export type ConfigWorkspaceTeamSubmissionChannelRow =
  typeof ConfigWorkspaceTeamSubmissionChannelRow.Type;

export const MessageSlotRow = Schema.Struct({
  ...messageKeyFields,
  day: Schema.Number,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  createdByUserId: Schema.String,
  ...auditFields,
});
export type MessageSlotRow = typeof MessageSlotRow.Type;

export const MessageCheckinRow = Schema.Struct({
  ...messageKeyFields,
  initialMessage: ReadonlyJSONValue,
  hour: Schema.Number,
  runningConversationId: Schema.String,
  roleId: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
  ...auditFields,
});
export type MessageCheckinRow = typeof MessageCheckinRow.Type;

export const MessageCheckinMemberRow = Schema.Struct({
  ...messageKeyFields,
  memberId: Schema.String,
  checkinAt: Schema.NullOr(Schema.Number),
  checkinClaimId: Schema.NullOr(Schema.String),
  ...auditFields,
});
export type MessageCheckinMemberRow = typeof MessageCheckinMemberRow.Type;

export const MessageRoomOrderRow = Schema.Struct({
  ...messageKeyFields,
  previousFills: Schema.Array(Schema.String),
  fills: Schema.Array(Schema.String),
  hour: Schema.Number,
  rank: Schema.Number,
  tentative: Schema.Boolean,
  monitor: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
  sendClaimId: Schema.NullOr(Schema.String),
  sendClaimedAt: Schema.NullOr(Schema.Number),
  sentMessageId: Schema.NullOr(Schema.String),
  sentConversationId: Schema.NullOr(Schema.String),
  sentAt: Schema.NullOr(Schema.Number),
  tentativeUpdateClaimId: Schema.NullOr(Schema.String),
  tentativeUpdateClaimedAt: Schema.NullOr(Schema.Number),
  tentativePinClaimId: Schema.NullOr(Schema.String),
  tentativePinClaimedAt: Schema.NullOr(Schema.Number),
  tentativePinnedAt: Schema.NullOr(Schema.Number),
  ...auditFields,
});
export type MessageRoomOrderRow = typeof MessageRoomOrderRow.Type;

export const MessageRoomOrderEntryRow = Schema.Struct({
  ...messageKeyFields,
  rank: Schema.Number,
  position: Schema.Number,
  hour: Schema.Number,
  team: Schema.String,
  tags: Schema.Array(Schema.String),
  effectValue: Schema.Number,
  ...auditFields,
});
export type MessageRoomOrderEntryRow = typeof MessageRoomOrderEntryRow.Type;

export const MessageTeamSubmissionRow = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
  messageId: Schema.String,
  clientPlatform: Schema.String,
  clientId: Schema.String,
  discordGuildId: Schema.String,
  discordChannelId: Schema.String,
  discordAuthorId: Schema.String,
  sheetId: Schema.String,
  sheetConfigurationBinding: Schema.NullOr(ReadonlyJSONValue),
  confirmationMessageId: Schema.NullOr(Schema.String),
  parsedSubmission: ReadonlyJSONValue,
  rowMappings: ReadonlyJSONValue,
  rollbackSnapshot: Schema.NullOr(ReadonlyJSONValue),
  version: Schema.Number,
  status: TeamSubmissionStatus,
  ...auditFields,
});
export type MessageTeamSubmissionRow = typeof MessageTeamSubmissionRow.Type;
