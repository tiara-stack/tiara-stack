import { Schema } from "effect";
import { DeliveryReceipt, MessageRef, ResponseReference } from "sheet-bot-api";
import { TeamSubmissionStatus } from "sheet-domain";

const Identifier = Schema.Trimmed.check(Schema.isNonEmpty());

export const WorkspaceId = Identifier.pipe(Schema.brand("sheet-workflow-contracts/WorkspaceId"));
export type WorkspaceId = Schema.Schema.Type<typeof WorkspaceId>;

export const SpreadsheetId = Identifier.pipe(
  Schema.brand("sheet-workflow-contracts/SpreadsheetId"),
);
export type SpreadsheetId = Schema.Schema.Type<typeof SpreadsheetId>;

export const SheetReference = Identifier.pipe(
  Schema.brand("sheet-workflow-contracts/SheetReference"),
);
export type SheetReference = Schema.Schema.Type<typeof SheetReference>;

const WorkspaceFields = { workspaceId: WorkspaceId } as const;
const ResponseFields = { responseReference: ResponseReference } as const;
const DeliveryEvidenceFields = {
  deliveryReceipts: Schema.Array(DeliveryReceipt),
} as const;

export const EmptyInput = Schema.Struct({});
export type EmptyInput = Schema.Schema.Type<typeof EmptyInput>;

export const DiscordProfileUser = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatar: Schema.NullOr(Schema.String),
});
export type DiscordProfileUser = Schema.Schema.Type<typeof DiscordProfileUser>;

export const DiscordProfileWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.NullOr(Schema.String),
  ownerId: Schema.String,
});
export type DiscordProfileWorkspace = Schema.Schema.Type<typeof DiscordProfileWorkspace>;

export const DiscordLoadProfileSuccess = Schema.Struct({
  user: DiscordProfileUser,
  guilds: Schema.Array(DiscordProfileWorkspace),
});
export type DiscordLoadProfileSuccess = Schema.Schema.Type<typeof DiscordLoadProfileSuccess>;

export const WorkspaceInput = Schema.Struct(WorkspaceFields);
export type WorkspaceInput = Schema.Schema.Type<typeof WorkspaceInput>;

export const DiscordChannel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.Int,
  parentId: Schema.NullOr(Schema.String),
  position: Schema.Int,
});
export type DiscordChannel = Schema.Schema.Type<typeof DiscordChannel>;

export const DiscordRole = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  position: Schema.Int,
  color: Schema.Int,
  managed: Schema.Boolean,
});
export type DiscordRole = Schema.Schema.Type<typeof DiscordRole>;

export const DiscordLoadWorkspaceChannelsSuccess = Schema.Array(DiscordChannel);
export type DiscordLoadWorkspaceChannelsSuccess = Schema.Schema.Type<
  typeof DiscordLoadWorkspaceChannelsSuccess
>;

export const DiscordLoadWorkspaceRolesSuccess = Schema.Array(DiscordRole);
export type DiscordLoadWorkspaceRolesSuccess = Schema.Schema.Type<
  typeof DiscordLoadWorkspaceRolesSuccess
>;

export const WorkspaceCapability = Schema.Literals([
  "member",
  "monitor",
  "manage",
  "participant",
  "app_owner",
]);
export type WorkspaceCapability = Schema.Schema.Type<typeof WorkspaceCapability>;

export const WorkspaceCapabilities = Schema.Struct({
  workspaceId: WorkspaceId,
  capabilities: Schema.Array(WorkspaceCapability),
});
export type WorkspaceCapabilities = Schema.Schema.Type<typeof WorkspaceCapabilities>;

export const PopulatedScheduleSummary = Schema.Struct({
  conversationName: Schema.String,
  day: Schema.Number,
  visible: Schema.Boolean,
  hour: Schema.NullOr(Schema.Number),
  playerNames: Schema.Array(Schema.String),
  monitorName: Schema.NullOr(Schema.String),
});
export type PopulatedScheduleSummary = Schema.Schema.Type<typeof PopulatedScheduleSummary>;

export const SchedulesLoadWorkspaceSuccess = Schema.Struct({
  eventConfig: Schema.Struct({ startTimeEpochMs: Schema.Number }),
  populatedSchedules: Schema.Array(PopulatedScheduleSummary),
});
export type SchedulesLoadWorkspaceSuccess = Schema.Schema.Type<
  typeof SchedulesLoadWorkspaceSuccess
>;

export const NotificationPlatform = Identifier;
export type NotificationPlatform = Schema.Schema.Type<typeof NotificationPlatform>;

export const NotificationsLoadSupportedClientsInput = Schema.Struct({
  platform: NotificationPlatform,
});
export type NotificationsLoadSupportedClientsInput = Schema.Schema.Type<
  typeof NotificationsLoadSupportedClientsInput
>;

export const NotificationClient = Schema.Struct({
  platform: NotificationPlatform,
  clientId: Schema.String,
});
export type NotificationClient = Schema.Schema.Type<typeof NotificationClient>;

export const NotificationsLoadSupportedClientsSuccess = Schema.Array(NotificationClient);
export type NotificationsLoadSupportedClientsSuccess = Schema.Schema.Type<
  typeof NotificationsLoadSupportedClientsSuccess
>;

export const CheckinsOpenInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  conversationId: Schema.optional(Schema.String),
  conversationName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  template: Schema.optional(Schema.String),
});
export type CheckinsOpenInput = Schema.Schema.Type<typeof CheckinsOpenInput>;

export const CheckinsOpenSuccess = Schema.Struct({
  hour: Schema.Number,
  runningConversationId: Schema.String,
  checkinConversationId: Schema.String,
  checkinMessageId: Schema.NullOr(Schema.String),
  primaryMessageId: Schema.String,
  tentativeRoomOrderMessageId: Schema.NullOr(Schema.String),
  ...DeliveryEvidenceFields,
});
export type CheckinsOpenSuccess = Schema.Schema.Type<typeof CheckinsOpenSuccess>;

export const CheckinsTestAutoInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  anchorConversationId: Schema.String,
});
export type CheckinsTestAutoInput = Schema.Schema.Type<typeof CheckinsTestAutoInput>;

export const CheckinsTestAutoConversationResult = Schema.Struct({
  conversationName: Schema.String,
  runningConversationId: Schema.NullOr(Schema.String),
  checkinConversationId: Schema.NullOr(Schema.String),
  hour: Schema.Number,
  status: Schema.Literals(["sent", "skipped", "failed"]),
  error: Schema.NullOr(Schema.String),
});
export type CheckinsTestAutoConversationResult = Schema.Schema.Type<
  typeof CheckinsTestAutoConversationResult
>;

export const CheckinsTestAutoSuccess = Schema.Struct({
  ...WorkspaceFields,
  hour: Schema.Number,
  conversationCount: Schema.Number,
  sentCount: Schema.Number,
  skippedCount: Schema.Number,
  failedCount: Schema.Number,
  conversations: Schema.Array(CheckinsTestAutoConversationResult),
  ...DeliveryEvidenceFields,
});
export type CheckinsTestAutoSuccess = Schema.Schema.Type<typeof CheckinsTestAutoSuccess>;

export const CheckinsRespondInput = Schema.Struct({
  ...ResponseFields,
  messageId: Schema.String,
});
export type CheckinsRespondInput = Schema.Schema.Type<typeof CheckinsRespondInput>;

export const CheckinsRespondSuccess = Schema.Struct({
  messageId: Schema.String,
  messageConversationId: Schema.String,
  checkedInMemberId: Schema.String,
  ...DeliveryEvidenceFields,
});
export type CheckinsRespondSuccess = Schema.Schema.Type<typeof CheckinsRespondSuccess>;

export const RoomOrdersCreateInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  conversationId: Schema.optional(Schema.String),
  conversationName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  healNeeded: Schema.optional(Schema.Number),
});
export type RoomOrdersCreateInput = Schema.Schema.Type<typeof RoomOrdersCreateInput>;

export const RoomOrdersCreateSuccess = Schema.Struct({
  messageId: Schema.String,
  messageConversationId: Schema.String,
  hour: Schema.Number,
  runningConversationId: Schema.String,
  rank: Schema.Number,
  ...DeliveryEvidenceFields,
});
export type RoomOrdersCreateSuccess = Schema.Schema.Type<typeof RoomOrdersCreateSuccess>;

const RoomOrderMessageFields = {
  ...WorkspaceFields,
  ...ResponseFields,
  messageId: Schema.String,
  messageConversationId: Schema.String,
  messageContent: Schema.optional(Schema.NullOr(Schema.String)),
} as const;

export const RoomOrdersNavigateInput = Schema.Struct({
  ...RoomOrderMessageFields,
  direction: Schema.Literals(["previous", "next"]),
});
export type RoomOrdersNavigateInput = Schema.Schema.Type<typeof RoomOrdersNavigateInput>;

export const RoomOrdersSendInput = Schema.Struct(RoomOrderMessageFields);
export type RoomOrdersSendInput = Schema.Schema.Type<typeof RoomOrdersSendInput>;

export const RoomOrdersPinTentativeInput = Schema.Struct(RoomOrderMessageFields);
export type RoomOrdersPinTentativeInput = Schema.Schema.Type<typeof RoomOrdersPinTentativeInput>;

export const RoomOrderOperationSuccess = Schema.Struct({
  messageId: Schema.String,
  messageConversationId: Schema.String,
  status: Schema.Literals(["updated", "sent", "pinned", "partial", "denied", "failed"]),
  detail: Schema.NullOr(Schema.String),
  ...DeliveryEvidenceFields,
});
export type RoomOrderOperationSuccess = Schema.Schema.Type<typeof RoomOrderOperationSuccess>;

export const SlotListMessageType = Schema.Literals(["persistent", "ephemeral"]);
export type SlotListMessageType = Schema.Schema.Type<typeof SlotListMessageType>;

export const SlotsDeliverListInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  day: Schema.Number,
  messageType: SlotListMessageType,
});
export type SlotsDeliverListInput = Schema.Schema.Type<typeof SlotsDeliverListInput>;

export const SlotsDeliverListSuccess = Schema.Struct({
  ...WorkspaceFields,
  day: Schema.Number,
  messageType: SlotListMessageType,
  ...DeliveryEvidenceFields,
});
export type SlotsDeliverListSuccess = Schema.Schema.Type<typeof SlotsDeliverListSuccess>;

export const SlotsPublishButtonInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  conversationId: Schema.String,
  day: Schema.Number,
});
export type SlotsPublishButtonInput = Schema.Schema.Type<typeof SlotsPublishButtonInput>;

export const SlotsPublishButtonSuccess = Schema.Struct({
  messageId: Schema.String,
  messageConversationId: Schema.String,
  day: Schema.Number,
  ...DeliveryEvidenceFields,
});
export type SlotsPublishButtonSuccess = Schema.Schema.Type<typeof SlotsPublishButtonSuccess>;

export const SlotsOpenInput = Schema.Struct({
  ...ResponseFields,
  messageId: Schema.String,
});
export type SlotsOpenInput = Schema.Schema.Type<typeof SlotsOpenInput>;

export const SlotsOpenSuccess = Schema.Struct({
  messageId: Schema.String,
  ...WorkspaceFields,
  day: Schema.Number,
  ...DeliveryEvidenceFields,
});
export type SlotsOpenSuccess = Schema.Schema.Type<typeof SlotsOpenSuccess>;

export const MembersKickInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  conversationId: Schema.optional(Schema.String),
  conversationName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
});
export type MembersKickInput = Schema.Schema.Type<typeof MembersKickInput>;

export const MembersKickSuccess = Schema.Struct({
  ...WorkspaceFields,
  runningConversationId: Schema.String,
  hour: Schema.Number,
  roleId: Schema.NullOr(Schema.String),
  removedMemberIds: Schema.Array(Schema.String),
  status: Schema.Literals(["removed", "empty", "tooEarly", "missingRole"]),
  ...DeliveryEvidenceFields,
});
export type MembersKickSuccess = Schema.Schema.Type<typeof MembersKickSuccess>;

export const PreferenceKind = Schema.Literals(["checkin", "monitor"]);
export type PreferenceKind = Schema.Schema.Type<typeof PreferenceKind>;

export const PreferencesDeliverStatusInput = Schema.Struct({
  ...ResponseFields,
  kind: PreferenceKind,
  platform: Schema.optional(NotificationPlatform),
});
export type PreferencesDeliverStatusInput = Schema.Schema.Type<
  typeof PreferencesDeliverStatusInput
>;

export const PreferencesUpdateAndDeliverInput = Schema.Struct({
  ...ResponseFields,
  platform: NotificationPlatform,
  checkinDmEnabled: Schema.optional(Schema.Boolean),
  monitorDmEnabled: Schema.optional(Schema.Boolean),
  defaultClientId: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PreferencesUpdateAndDeliverInput = Schema.Schema.Type<
  typeof PreferencesUpdateAndDeliverInput
>;

export const PreferencesDeliverySuccess = Schema.Struct({
  platform: NotificationPlatform,
  checkinDmEnabled: Schema.Boolean,
  monitorDmEnabled: Schema.Boolean,
  defaultClientId: Schema.NullOr(Schema.String),
  ...DeliveryEvidenceFields,
});
export type PreferencesDeliverySuccess = Schema.Schema.Type<typeof PreferencesDeliverySuccess>;

export const WorkspacesDeliverConfigInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
});
export type WorkspacesDeliverConfigInput = Schema.Schema.Type<typeof WorkspacesDeliverConfigInput>;

export const WorkspaceConfigDeliverySuccess = Schema.Struct({
  ...WorkspaceFields,
  monitorRoleCount: Schema.Number,
  ...DeliveryEvidenceFields,
});
export type WorkspaceConfigDeliverySuccess = Schema.Schema.Type<
  typeof WorkspaceConfigDeliverySuccess
>;

export const WorkspacesUpdateConfigAndDeliverInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  patch: Schema.Struct({
    spreadsheetId: Schema.optional(Schema.NullOr(SpreadsheetId)),
    autoCheckin: Schema.optional(Schema.Boolean),
    monitorConversationId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
export type WorkspacesUpdateConfigAndDeliverInput = Schema.Schema.Type<
  typeof WorkspacesUpdateConfigAndDeliverInput
>;

export const WorkspacesSetMonitorRoleAndDeliverInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  roleId: Schema.String,
  enabled: Schema.Boolean,
});
export type WorkspacesSetMonitorRoleAndDeliverInput = Schema.Schema.Type<
  typeof WorkspacesSetMonitorRoleAndDeliverInput
>;

export const MonitorRoleDeliverySuccess = Schema.Struct({
  ...WorkspaceFields,
  roleId: Schema.String,
  enabled: Schema.Boolean,
  ...DeliveryEvidenceFields,
});
export type MonitorRoleDeliverySuccess = Schema.Schema.Type<typeof MonitorRoleDeliverySuccess>;

export const WorkspacesDeliverWelcomeInput = Schema.Struct({
  ...WorkspaceFields,
  workspaceName: Schema.String,
  joinedAt: Schema.DateFromString,
  systemConversationId: Schema.optional(Schema.String),
});
export type WorkspacesDeliverWelcomeInput = Schema.Schema.Type<
  typeof WorkspacesDeliverWelcomeInput
>;

export const WorkspacesDeliverWelcomeSuccess = Schema.Struct({
  ...WorkspaceFields,
  conversationId: Schema.String,
  messageId: Schema.String,
  ...DeliveryEvidenceFields,
});
export type WorkspacesDeliverWelcomeSuccess = Schema.Schema.Type<
  typeof WorkspacesDeliverWelcomeSuccess
>;

export const FeatureFlagName = Identifier;
export type FeatureFlagName = Schema.Schema.Type<typeof FeatureFlagName>;

export const WorkspacesFeatureFlagsSetAndDeliverInput = Schema.Struct({
  ...WorkspaceFields,
  responseReference: Schema.optional(ResponseReference),
  flagName: FeatureFlagName,
  enabled: Schema.Boolean,
  systemConversationId: Schema.optional(Schema.String),
});
export type WorkspacesFeatureFlagsSetAndDeliverInput = Schema.Schema.Type<
  typeof WorkspacesFeatureFlagsSetAndDeliverInput
>;

export const WorkspacesFeatureFlagsSetAndDeliverSuccess = Schema.Struct({
  ...WorkspaceFields,
  flagName: FeatureFlagName,
  enabled: Schema.Boolean,
  announcementConversationId: Schema.NullOr(Schema.String),
  announcementMessageId: Schema.NullOr(Schema.String),
  ...DeliveryEvidenceFields,
});
export type WorkspacesFeatureFlagsSetAndDeliverSuccess = Schema.Schema.Type<
  typeof WorkspacesFeatureFlagsSetAndDeliverSuccess
>;

export const ConversationsDeliverConfigInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  conversationId: Schema.String,
});
export type ConversationsDeliverConfigInput = Schema.Schema.Type<
  typeof ConversationsDeliverConfigInput
>;

export const ConversationConfigDeliverySuccess = Schema.Struct({
  ...WorkspaceFields,
  conversationId: Schema.String,
  ...DeliveryEvidenceFields,
});
export type ConversationConfigDeliverySuccess = Schema.Schema.Type<
  typeof ConversationConfigDeliverySuccess
>;

export const ConversationsUpdateConfigAndDeliverInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  conversationId: Schema.String,
  patch: Schema.Struct({
    running: Schema.optional(Schema.Boolean),
    name: Schema.optional(Schema.NullOr(Schema.String)),
    roleId: Schema.optional(Schema.NullOr(Schema.String)),
    checkinConversationId: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
export type ConversationsUpdateConfigAndDeliverInput = Schema.Schema.Type<
  typeof ConversationsUpdateConfigAndDeliverInput
>;

export const ConversationsSetLockdownInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  conversationId: Schema.String,
  enabled: Schema.Boolean,
});
export type ConversationsSetLockdownInput = Schema.Schema.Type<
  typeof ConversationsSetLockdownInput
>;

export const ConversationsSetLockdownSuccess = Schema.Struct({
  ...WorkspaceFields,
  conversationId: Schema.String,
  enabled: Schema.Boolean,
  ...DeliveryEvidenceFields,
});
export type ConversationsSetLockdownSuccess = Schema.Schema.Type<
  typeof ConversationsSetLockdownSuccess
>;

export const TeamsDeliverListInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  targetUserId: Schema.String,
  targetUsername: Schema.String,
});
export type TeamsDeliverListInput = Schema.Schema.Type<typeof TeamsDeliverListInput>;

export const TeamsDeliverListSuccess = Schema.Struct({
  ...WorkspaceFields,
  targetUserId: Schema.String,
  teamCount: Schema.Number,
  ...DeliveryEvidenceFields,
});
export type TeamsDeliverListSuccess = Schema.Schema.Type<typeof TeamsDeliverListSuccess>;

export const SchedulesDeliverUserScheduleInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  day: Schema.Number,
  targetUserId: Schema.String,
  targetUsername: Schema.String,
});
export type SchedulesDeliverUserScheduleInput = Schema.Schema.Type<
  typeof SchedulesDeliverUserScheduleInput
>;

export const SchedulesDeliverUserScheduleSuccess = Schema.Struct({
  ...WorkspaceFields,
  day: Schema.Number,
  targetUserId: Schema.String,
  invisible: Schema.Boolean,
  ...DeliveryEvidenceFields,
});
export type SchedulesDeliverUserScheduleSuccess = Schema.Schema.Type<
  typeof SchedulesDeliverUserScheduleSuccess
>;

export const ScreenshotsCaptureAndDeliverInput = Schema.Struct({
  ...WorkspaceFields,
  ...ResponseFields,
  conversationName: Schema.String,
  day: Schema.Number,
});
export type ScreenshotsCaptureAndDeliverInput = Schema.Schema.Type<
  typeof ScreenshotsCaptureAndDeliverInput
>;

export const ScreenshotsCaptureAndDeliverSuccess = Schema.Struct({
  ...WorkspaceFields,
  conversationName: Schema.String,
  day: Schema.Number,
  byteLength: Schema.Number,
  ...DeliveryEvidenceFields,
});
export type ScreenshotsCaptureAndDeliverSuccess = Schema.Schema.Type<
  typeof ScreenshotsCaptureAndDeliverSuccess
>;

export const ServicesDeliverStatusInput = Schema.Struct(ResponseFields);
export type ServicesDeliverStatusInput = Schema.Schema.Type<typeof ServicesDeliverStatusInput>;

export const ServiceDisposition = Schema.Struct({
  service: Schema.String,
  status: Schema.Literals(["ok", "down"]),
});
export type ServiceDisposition = Schema.Schema.Type<typeof ServiceDisposition>;

export const ServicesDeliverStatusSuccess = Schema.Struct({
  overallStatus: Schema.Literals(["ok", "degraded"]),
  okCount: Schema.Number,
  downCount: Schema.Number,
  services: Schema.Array(ServiceDisposition),
  ...DeliveryEvidenceFields,
});
export type ServicesDeliverStatusSuccess = Schema.Schema.Type<typeof ServicesDeliverStatusSuccess>;

export const TeamSubmissionsProcessInput = Schema.Struct({
  sourceMessage: MessageRef,
  authorId: Schema.String,
  authorDisplayName: Schema.String,
  content: Schema.String,
  editedAt: Schema.optional(Schema.NullOr(Schema.DateFromString)),
});
export type TeamSubmissionsProcessInput = Schema.Schema.Type<typeof TeamSubmissionsProcessInput>;

export const TeamSubmissionsProcessSuccess = Schema.Struct({
  sourceMessage: MessageRef,
  confirmationMessage: Schema.NullOr(MessageRef),
  parsedTeamCount: Schema.Number,
  skippedTeamCount: Schema.Number,
  status: TeamSubmissionStatus,
  ...DeliveryEvidenceFields,
});
export type TeamSubmissionsProcessSuccess = Schema.Schema.Type<
  typeof TeamSubmissionsProcessSuccess
>;

export const TeamSubmissionDecision = Schema.Literals(["confirm", "reject"]);
export type TeamSubmissionDecision = Schema.Schema.Type<typeof TeamSubmissionDecision>;

export const TeamSubmissionsDecideInput = Schema.Struct({
  ...ResponseFields,
  sourceMessage: MessageRef,
  confirmationMessage: MessageRef,
  decision: TeamSubmissionDecision,
});
export type TeamSubmissionsDecideInput = Schema.Schema.Type<typeof TeamSubmissionsDecideInput>;

export const TeamSubmissionsDecideSuccess = Schema.Struct({
  sourceMessage: MessageRef,
  status: Schema.Literals(["confirmed", "rejected", "rollbackFailed"]),
  ...DeliveryEvidenceFields,
});
export type TeamSubmissionsDecideSuccess = Schema.Schema.Type<typeof TeamSubmissionsDecideSuccess>;

export const Announcement = Schema.Struct({
  id: Schema.String,
  publishedAt: Schema.DateFromString,
  title: Schema.String,
  description: Schema.String,
  color: Schema.optional(Schema.Number),
});
export type Announcement = Schema.Schema.Type<typeof Announcement>;

export const AnnouncementsDeliverUpdateInput = Schema.Struct({
  ...WorkspaceFields,
  workspaceName: Schema.String,
  joinedAt: Schema.DateFromString,
  systemConversationId: Schema.optional(Schema.String),
  announcement: Announcement,
});
export type AnnouncementsDeliverUpdateInput = Schema.Schema.Type<
  typeof AnnouncementsDeliverUpdateInput
>;

export const AnnouncementsDeliverUpdateSuccess = Schema.Struct({
  ...WorkspaceFields,
  announcementId: Schema.String,
  status: Schema.Literals([
    "sent",
    "skipped_not_gated",
    "skipped_already_claimed",
    "skipped_already_delivered",
  ]),
  announcementConversationId: Schema.NullOr(Schema.String),
  announcementMessageId: Schema.NullOr(Schema.String),
  ...DeliveryEvidenceFields,
});
export type AnnouncementsDeliverUpdateSuccess = Schema.Schema.Type<
  typeof AnnouncementsDeliverUpdateSuccess
>;

export const CalculationConfig = Schema.Struct({
  cc: Schema.Boolean,
  considerEnc: Schema.Boolean,
  healNeeded: Schema.Number,
});
export type CalculationConfig = Schema.Schema.Type<typeof CalculationConfig>;

export const CalculationPlayer = Schema.Struct({
  name: Schema.String,
  encable: Schema.Boolean,
});
export type CalculationPlayer = Schema.Schema.Type<typeof CalculationPlayer>;

export const CalculationFixedTeam = Schema.Struct({
  name: Schema.String,
  heal: Schema.Boolean,
});
export type CalculationFixedTeam = Schema.Schema.Type<typeof CalculationFixedTeam>;

export const CalculationsRecalculateSheetInput = Schema.Struct({
  spreadsheetId: SpreadsheetId,
  sheetRef: SheetReference,
  hour: Schema.Number,
  config: CalculationConfig,
  players: Schema.Array(CalculationPlayer).check(Schema.isLengthBetween(5, 5)),
  fixedTeams: Schema.Array(CalculationFixedTeam),
});
export type CalculationsRecalculateSheetInput = Schema.Schema.Type<
  typeof CalculationsRecalculateSheetInput
>;

export const CalculationsRecalculateSheetSuccess = Schema.Struct({
  spreadsheetId: SpreadsheetId,
  sheetRef: SheetReference,
  hour: Schema.Number,
  outputRange: Schema.String,
  roomCount: Schema.Number,
});
export type CalculationsRecalculateSheetSuccess = Schema.Schema.Type<
  typeof CalculationsRecalculateSheetSuccess
>;
