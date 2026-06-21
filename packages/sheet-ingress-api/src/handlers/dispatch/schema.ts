import { Schema } from "effect";
import { ArgumentError, SchemaError, UnknownError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { FeatureFlagName } from "../../schemas/workspaceConfig";
import { GoogleSheetsError } from "../../schemas/google";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";
import { ClientRef } from "../../schemas/client";

export const interactionResponseTokenLifetimeMs = 15 * 60 * 1000;
export const interactionResponseTokenExpirySafetyMarginMs = 30 * 1000;

export const CheckinGenerateErrorSchemas = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
] as const;

export const CheckinDispatchErrorSchemas = [...CheckinGenerateErrorSchemas, UnknownError] as const;
export const CheckinDispatchError = Schema.Union(CheckinDispatchErrorSchemas);

export const CheckinHandleButtonErrorSchemas = CheckinDispatchErrorSchemas;
export const CheckinHandleButtonError = Schema.Union(CheckinHandleButtonErrorSchemas);

export const RoomOrderGenerateErrorSchemas = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
] as const;

export const RoomOrderDispatchErrorSchemas = [
  ...RoomOrderGenerateErrorSchemas,
  UnknownError,
] as const;
export const RoomOrderDispatchError = Schema.Union(RoomOrderDispatchErrorSchemas);

export const RoomOrderHandleButtonErrorSchemas = RoomOrderDispatchErrorSchemas;
export const RoomOrderHandleButtonError = Schema.Union(RoomOrderHandleButtonErrorSchemas);

export const KickoutDispatchErrorSchemas = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
  UnknownError,
] as const;
export const KickoutDispatchError = Schema.Union(KickoutDispatchErrorSchemas);

export const SlotDispatchErrorSchemas = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
  UnknownError,
] as const;
export const SlotDispatchError = Schema.Union(SlotDispatchErrorSchemas);

export const WorkspaceWelcomeDispatchErrorSchemas = [ArgumentError, UnknownError] as const;
export const WorkspaceWelcomeDispatchError = Schema.Union(WorkspaceWelcomeDispatchErrorSchemas);

export const UpdateAnnouncementDispatchErrorSchemas = [
  SchemaError,
  QueryResultError,
  ArgumentError,
  UnknownError,
] as const;
export const UpdateAnnouncementDispatchError = Schema.Union(UpdateAnnouncementDispatchErrorSchemas);

export const BotCommandDispatchErrorSchemas = [
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
  UnknownError,
] as const;
export const BotCommandDispatchError = Schema.Union(BotCommandDispatchErrorSchemas);

const CommandDispatchPayloadBase = {
  client: ClientRef,
  dispatchRequestId: Schema.String,
  interactionResponseToken: Schema.String,
  interactionResponseDeadlineEpochMs: Schema.Number,
} as const;

const ClientDispatchPayloadBase = {
  client: ClientRef,
} as const;

export const CheckinDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  conversationId: Schema.optional(Schema.String),
  conversationName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  template: Schema.optional(Schema.String),
  interactionResponseToken: Schema.optional(Schema.String),
  interactionResponseDeadlineEpochMs: Schema.optional(Schema.Number),
});

export type CheckinDispatchPayload = Schema.Schema.Type<typeof CheckinDispatchPayload>;

export const CheckinDispatchResult = Schema.Struct({
  hour: Schema.Number,
  runningConversationId: Schema.String,
  checkinConversationId: Schema.String,
  checkinMessageId: Schema.NullOr(Schema.String),
  checkinMessageConversationId: Schema.NullOr(Schema.String),
  primaryMessageId: Schema.String,
  primaryMessageConversationId: Schema.String,
  tentativeRoomOrderMessageId: Schema.NullOr(Schema.String),
  tentativeRoomOrderMessageConversationId: Schema.NullOr(Schema.String),
});

export type CheckinDispatchResult = Schema.Schema.Type<typeof CheckinDispatchResult>;

export const AutoCheckinTestDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  anchorConversationId: Schema.String,
  interactionResponseToken: Schema.optional(Schema.String),
  interactionResponseDeadlineEpochMs: Schema.optional(Schema.Number),
});

export type AutoCheckinTestDispatchPayload = Schema.Schema.Type<
  typeof AutoCheckinTestDispatchPayload
>;

export const AutoCheckinTestConversationResult = Schema.Struct({
  conversationName: Schema.String,
  runningConversationId: Schema.NullOr(Schema.String),
  checkinConversationId: Schema.NullOr(Schema.String),
  hour: Schema.Number,
  status: Schema.Literals(["sent", "skipped", "failed"]),
  checkinPreviewMessageId: Schema.NullOr(Schema.String),
  monitorPreviewMessageId: Schema.NullOr(Schema.String),
  tentativeRoomOrderPreviewMessageId: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

export type AutoCheckinTestConversationResult = Schema.Schema.Type<
  typeof AutoCheckinTestConversationResult
>;

export const AutoCheckinTestDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  hour: Schema.Number,
  anchorMessageId: Schema.String,
  anchorMessageConversationId: Schema.String,
  conversationCount: Schema.Number,
  sentCount: Schema.Number,
  skippedCount: Schema.Number,
  failedCount: Schema.Number,
  conversations: Schema.Array(AutoCheckinTestConversationResult),
});

export type AutoCheckinTestDispatchResult = Schema.Schema.Type<
  typeof AutoCheckinTestDispatchResult
>;

export const CheckinHandleButtonPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  messageId: Schema.String,
  interactionResponseToken: Schema.String,
  interactionResponseDeadlineEpochMs: Schema.Number,
});

export type CheckinHandleButtonPayload = Schema.Schema.Type<typeof CheckinHandleButtonPayload>;

export const CheckinHandleButtonResult = Schema.Struct({
  messageId: Schema.String,
  messageConversationId: Schema.String,
  checkedInMemberId: Schema.String,
});

export type CheckinHandleButtonResult = Schema.Schema.Type<typeof CheckinHandleButtonResult>;

export const RoomOrderDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  conversationId: Schema.optional(Schema.String),
  conversationName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  healNeeded: Schema.optional(Schema.Number),
  interactionResponseToken: Schema.optional(Schema.String),
  interactionResponseDeadlineEpochMs: Schema.optional(Schema.Number),
});

export type RoomOrderDispatchPayload = Schema.Schema.Type<typeof RoomOrderDispatchPayload>;

export const RoomOrderDispatchResult = Schema.Struct({
  messageId: Schema.String,
  messageConversationId: Schema.String,
  hour: Schema.Number,
  runningConversationId: Schema.String,
  rank: Schema.Number,
});

export type RoomOrderDispatchResult = Schema.Schema.Type<typeof RoomOrderDispatchResult>;

export const KickoutDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  conversationId: Schema.optional(Schema.String),
  conversationName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  interactionResponseToken: Schema.optional(Schema.String),
  interactionResponseDeadlineEpochMs: Schema.optional(Schema.Number),
});

export type KickoutDispatchPayload = Schema.Schema.Type<typeof KickoutDispatchPayload>;

export const KickoutDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  runningConversationId: Schema.String,
  hour: Schema.Number,
  roleId: Schema.NullOr(Schema.String),
  removedMemberIds: Schema.Array(Schema.String),
  status: Schema.Literals(["removed", "empty", "tooEarly", "missingRole"]),
});

export type KickoutDispatchResult = Schema.Schema.Type<typeof KickoutDispatchResult>;

export const SlotButtonDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  day: Schema.Number,
  interactionResponseToken: Schema.String,
  interactionResponseDeadlineEpochMs: Schema.Number,
});

export type SlotButtonDispatchPayload = Schema.Schema.Type<typeof SlotButtonDispatchPayload>;

export const SlotButtonDispatchResult = Schema.Struct({
  messageId: Schema.String,
  messageConversationId: Schema.String,
  day: Schema.Number,
});

export type SlotButtonDispatchResult = Schema.Schema.Type<typeof SlotButtonDispatchResult>;

export const SlotListMessageType = Schema.Literals(["persistent", "ephemeral"]);

export type SlotListMessageType = Schema.Schema.Type<typeof SlotListMessageType>;

export const SlotListDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  day: Schema.Number,
  messageType: SlotListMessageType,
  interactionResponseToken: Schema.String,
  interactionResponseDeadlineEpochMs: Schema.Number,
});

export type SlotListDispatchPayload = Schema.Schema.Type<typeof SlotListDispatchPayload>;

export const SlotListDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  day: Schema.Number,
  messageType: SlotListMessageType,
});

export type SlotListDispatchResult = Schema.Schema.Type<typeof SlotListDispatchResult>;

export const SlotOpenButtonPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  messageId: Schema.String,
  interactionResponseToken: Schema.String,
  interactionResponseDeadlineEpochMs: Schema.Number,
});

export type SlotOpenButtonPayload = Schema.Schema.Type<typeof SlotOpenButtonPayload>;

export const SlotOpenButtonResult = Schema.Struct({
  messageId: Schema.String,
  workspaceId: Schema.String,
  day: Schema.Number,
});

export type SlotOpenButtonResult = Schema.Schema.Type<typeof SlotOpenButtonResult>;

export const ServiceStatusDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  interactionResponseToken: Schema.String,
  interactionResponseDeadlineEpochMs: Schema.Number,
});

export type ServiceStatusDispatchPayload = Schema.Schema.Type<typeof ServiceStatusDispatchPayload>;

export const WorkspaceWelcomeDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  workspaceName: Schema.String,
  joinedAt: Schema.String,
  systemConversationId: Schema.optional(Schema.String),
});

export type WorkspaceWelcomeDispatchPayload = Schema.Schema.Type<
  typeof WorkspaceWelcomeDispatchPayload
>;

export const WorkspaceWelcomeDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
  messageId: Schema.String,
});

export type WorkspaceWelcomeDispatchResult = Schema.Schema.Type<
  typeof WorkspaceWelcomeDispatchResult
>;

export const ServiceWorkspaceFeatureFlagDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  flagName: FeatureFlagName,
  systemConversationId: Schema.optional(Schema.String),
});

export type ServiceWorkspaceFeatureFlagDispatchPayload = Schema.Schema.Type<
  typeof ServiceWorkspaceFeatureFlagDispatchPayload
>;

export const ServiceWorkspaceFeatureFlagDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  flagName: Schema.String,
  announcementConversationId: Schema.NullOr(Schema.String),
  announcementMessageId: Schema.NullOr(Schema.String),
});

export type ServiceWorkspaceFeatureFlagDispatchResult = Schema.Schema.Type<
  typeof ServiceWorkspaceFeatureFlagDispatchResult
>;

export const UpdateAnnouncement = Schema.Struct({
  id: Schema.String,
  publishedAt: Schema.String,
  title: Schema.String,
  description: Schema.String,
  color: Schema.optional(Schema.Number),
});

export type UpdateAnnouncement = Schema.Schema.Type<typeof UpdateAnnouncement>;

export const UpdateAnnouncementDispatchPayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  dispatchRequestId: Schema.String,
  workspaceId: Schema.String,
  workspaceName: Schema.String,
  joinedAt: Schema.String,
  systemConversationId: Schema.optional(Schema.String),
  announcement: UpdateAnnouncement,
});

export type UpdateAnnouncementDispatchPayload = Schema.Schema.Type<
  typeof UpdateAnnouncementDispatchPayload
>;

export const UpdateAnnouncementDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  announcementId: Schema.String,
  status: Schema.Literals(["sent", "skipped_not_gated", "skipped_already_delivered"]),
  announcementConversationId: Schema.NullOr(Schema.String),
  announcementMessageId: Schema.NullOr(Schema.String),
});

export type UpdateAnnouncementDispatchResult = Schema.Schema.Type<
  typeof UpdateAnnouncementDispatchResult
>;

export const ConversationListConfigDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  conversationId: Schema.String,
});

export type ConversationListConfigDispatchPayload = Schema.Schema.Type<
  typeof ConversationListConfigDispatchPayload
>;

export const ConversationListConfigDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
});

export type ConversationListConfigDispatchResult = Schema.Schema.Type<
  typeof ConversationListConfigDispatchResult
>;

export const ConversationSetDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  running: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  roleId: Schema.optional(Schema.String),
  checkinConversationId: Schema.optional(Schema.String),
});

export type ConversationSetDispatchPayload = Schema.Schema.Type<
  typeof ConversationSetDispatchPayload
>;

export const ConversationSetDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
});

export type ConversationSetDispatchResult = Schema.Schema.Type<
  typeof ConversationSetDispatchResult
>;

export const ConversationUnsetDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  conversationId: Schema.String,
  running: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.Boolean),
  role: Schema.optional(Schema.Boolean),
  checkinConversation: Schema.optional(Schema.Boolean),
});

export type ConversationUnsetDispatchPayload = Schema.Schema.Type<
  typeof ConversationUnsetDispatchPayload
>;

export const ConversationUnsetDispatchResult = ConversationSetDispatchResult;
export type ConversationUnsetDispatchResult = Schema.Schema.Type<
  typeof ConversationUnsetDispatchResult
>;

export const WorkspaceListConfigDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
});

export type WorkspaceListConfigDispatchPayload = Schema.Schema.Type<
  typeof WorkspaceListConfigDispatchPayload
>;

export const WorkspaceListConfigDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  monitorRoleCount: Schema.Number,
});

export type WorkspaceListConfigDispatchResult = Schema.Schema.Type<
  typeof WorkspaceListConfigDispatchResult
>;

export const WorkspaceAddMonitorRoleDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  roleId: Schema.String,
});

export type WorkspaceAddMonitorRoleDispatchPayload = Schema.Schema.Type<
  typeof WorkspaceAddMonitorRoleDispatchPayload
>;

export const WorkspaceAddMonitorRoleDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  roleId: Schema.String,
});

export type WorkspaceAddMonitorRoleDispatchResult = Schema.Schema.Type<
  typeof WorkspaceAddMonitorRoleDispatchResult
>;

export const WorkspaceRemoveMonitorRoleDispatchPayload = WorkspaceAddMonitorRoleDispatchPayload;
export type WorkspaceRemoveMonitorRoleDispatchPayload = Schema.Schema.Type<
  typeof WorkspaceRemoveMonitorRoleDispatchPayload
>;

export const WorkspaceRemoveMonitorRoleDispatchResult = WorkspaceAddMonitorRoleDispatchResult;
export type WorkspaceRemoveMonitorRoleDispatchResult = Schema.Schema.Type<
  typeof WorkspaceRemoveMonitorRoleDispatchResult
>;

export const WorkspaceSetSheetDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  sheetId: Schema.String,
});

export type WorkspaceSetSheetDispatchPayload = Schema.Schema.Type<
  typeof WorkspaceSetSheetDispatchPayload
>;

export const WorkspaceSetSheetDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  sheetId: Schema.String,
});

export type WorkspaceSetSheetDispatchResult = Schema.Schema.Type<
  typeof WorkspaceSetSheetDispatchResult
>;

export const WorkspaceSetAutoCheckinDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  autoCheckin: Schema.Boolean,
});

export type WorkspaceSetAutoCheckinDispatchPayload = Schema.Schema.Type<
  typeof WorkspaceSetAutoCheckinDispatchPayload
>;

export const WorkspaceSetAutoCheckinDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  autoCheckin: Schema.Boolean,
});

export type WorkspaceSetAutoCheckinDispatchResult = Schema.Schema.Type<
  typeof WorkspaceSetAutoCheckinDispatchResult
>;

export const TeamListDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  targetUserId: Schema.String,
  targetUsername: Schema.String,
});

export type TeamListDispatchPayload = Schema.Schema.Type<typeof TeamListDispatchPayload>;

export const TeamListDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  targetUserId: Schema.String,
  teamCount: Schema.Number,
});

export type TeamListDispatchResult = Schema.Schema.Type<typeof TeamListDispatchResult>;

export const ScheduleListDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  day: Schema.Number,
  targetUserId: Schema.String,
  targetUsername: Schema.String,
});

export type ScheduleListDispatchPayload = Schema.Schema.Type<typeof ScheduleListDispatchPayload>;

export const ScheduleListDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  day: Schema.Number,
  targetUserId: Schema.String,
  invisible: Schema.Boolean,
});

export type ScheduleListDispatchResult = Schema.Schema.Type<typeof ScheduleListDispatchResult>;

export const ScreenshotDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  workspaceId: Schema.String,
  conversationName: Schema.String,
  day: Schema.Number,
});

export type ScreenshotDispatchPayload = Schema.Schema.Type<typeof ScreenshotDispatchPayload>;

export const ScreenshotDispatchResult = Schema.Struct({
  workspaceId: Schema.String,
  conversationName: Schema.String,
  day: Schema.Number,
  byteLength: Schema.Number,
});

export type ScreenshotDispatchResult = Schema.Schema.Type<typeof ScreenshotDispatchResult>;

export const ServiceStatusDispatchResult = Schema.Struct({
  overallStatus: Schema.Literals(["ok", "degraded"]),
  okCount: Schema.Number,
  downCount: Schema.Number,
});

export type ServiceStatusDispatchResult = Schema.Schema.Type<typeof ServiceStatusDispatchResult>;

export const DispatchRoomOrderButtonMethods = {
  previous: {
    endpointName: "roomOrderPreviousButton",
    path: "/dispatch/roomOrder/buttons/previous",
    rpcTag: "dispatch.roomOrderPreviousButton",
  },
  next: {
    endpointName: "roomOrderNextButton",
    path: "/dispatch/roomOrder/buttons/next",
    rpcTag: "dispatch.roomOrderNextButton",
  },
  send: {
    endpointName: "roomOrderSendButton",
    path: "/dispatch/roomOrder/buttons/send",
    rpcTag: "dispatch.roomOrderSendButton",
  },
  pinTentative: {
    endpointName: "roomOrderPinTentativeButton",
    path: "/dispatch/roomOrder/buttons/pinTentative",
    rpcTag: "dispatch.roomOrderPinTentativeButton",
  },
} as const;

export const DispatchAcceptedResult = Schema.Struct({
  executionId: Schema.String,
  operation: Schema.Literals([
    "autoCheckinTest",
    "checkin",
    "roomOrder",
    "kickout",
    "slotButton",
    "slotList",
    "slotOpenButton",
    "serviceStatus",
    "workspaceWelcome",
    "updateAnnouncement",
    "serviceAddWorkspaceFeatureFlag",
    "serviceRemoveWorkspaceFeatureFlag",
    "checkinButton",
    "roomOrderPreviousButton",
    "roomOrderNextButton",
    "roomOrderSendButton",
    "roomOrderPinTentativeButton",
    "conversationListConfig",
    "conversationSet",
    "conversationUnset",
    "workspaceListConfig",
    "workspaceAddMonitorRole",
    "workspaceRemoveMonitorRole",
    "workspaceSetSheet",
    "workspaceSetAutoCheckin",
    "teamList",
    "scheduleList",
    "screenshot",
  ]),
  status: Schema.Literal("accepted"),
});

export type DispatchAcceptedResult = Schema.Schema.Type<typeof DispatchAcceptedResult>;

export const RoomOrderButtonInteractionResponseType = Schema.Literals(["reply", "update"]);

export type RoomOrderButtonInteractionResponseType = Schema.Schema.Type<
  typeof RoomOrderButtonInteractionResponseType
>;

export const RoomOrderButtonBasePayload = Schema.Struct({
  ...ClientDispatchPayloadBase,
  workspaceId: Schema.String,
  messageId: Schema.String,
  messageConversationId: Schema.String,
  messageContent: Schema.optional(Schema.NullOr(Schema.String)),
  interactionResponseToken: Schema.String,
  interactionResponseDeadlineEpochMs: Schema.Number,
  interactionResponseType: Schema.optional(RoomOrderButtonInteractionResponseType),
});

export type RoomOrderButtonBasePayload = Schema.Schema.Type<typeof RoomOrderButtonBasePayload>;

export const RoomOrderPreviousButtonPayload = RoomOrderButtonBasePayload;
export type RoomOrderPreviousButtonPayload = Schema.Schema.Type<
  typeof RoomOrderPreviousButtonPayload
>;

export const RoomOrderNextButtonPayload = RoomOrderButtonBasePayload;
export type RoomOrderNextButtonPayload = Schema.Schema.Type<typeof RoomOrderNextButtonPayload>;

export const RoomOrderSendButtonPayload = RoomOrderButtonBasePayload;
export type RoomOrderSendButtonPayload = Schema.Schema.Type<typeof RoomOrderSendButtonPayload>;

export const RoomOrderPinTentativeButtonPayload = RoomOrderButtonBasePayload;
export type RoomOrderPinTentativeButtonPayload = Schema.Schema.Type<
  typeof RoomOrderPinTentativeButtonPayload
>;

export const RoomOrderButtonResult = Schema.Struct({
  messageId: Schema.String,
  messageConversationId: Schema.String,
  status: Schema.Literals(["updated", "sent", "pinned", "partial", "denied", "failed"]),
  detail: Schema.NullOr(Schema.String),
});

export type RoomOrderButtonResult = Schema.Schema.Type<typeof RoomOrderButtonResult>;

export const RoomOrderPreviousButtonResult = RoomOrderButtonResult;
export type RoomOrderPreviousButtonResult = Schema.Schema.Type<
  typeof RoomOrderPreviousButtonResult
>;

export const RoomOrderNextButtonResult = RoomOrderButtonResult;
export type RoomOrderNextButtonResult = Schema.Schema.Type<typeof RoomOrderNextButtonResult>;

export const RoomOrderSendButtonResult = RoomOrderButtonResult;
export type RoomOrderSendButtonResult = Schema.Schema.Type<typeof RoomOrderSendButtonResult>;

export const RoomOrderPinTentativeButtonResult = RoomOrderButtonResult;
export type RoomOrderPinTentativeButtonResult = Schema.Schema.Type<
  typeof RoomOrderPinTentativeButtonResult
>;
