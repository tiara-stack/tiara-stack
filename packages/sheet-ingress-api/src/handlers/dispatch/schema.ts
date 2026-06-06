import { Schema } from "effect";
import { ArgumentError, SchemaError, UnknownError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
import { FeatureFlagName } from "../../schemas/guildConfig";
import { GoogleSheetsError } from "../../schemas/google";
import { ParserFieldError } from "../../schemas/sheet/error";
import { SheetConfigError } from "../../schemas/sheetConfig";

export const interactionTokenLifetimeMs = 15 * 60 * 1000;
export const interactionTokenExpirySafetyMarginMs = 30 * 1000;

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

export const GuildWelcomeDispatchErrorSchemas = [ArgumentError, UnknownError] as const;
export const GuildWelcomeDispatchError = Schema.Union(GuildWelcomeDispatchErrorSchemas);

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
  dispatchRequestId: Schema.String,
  interactionToken: Schema.String,
  interactionDeadlineEpochMs: Schema.Number,
} as const;

export const CheckinDispatchPayload = Schema.Struct({
  dispatchRequestId: Schema.String,
  guildId: Schema.String,
  channelId: Schema.optional(Schema.String),
  channelName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  template: Schema.optional(Schema.String),
  interactionToken: Schema.optional(Schema.String),
  interactionDeadlineEpochMs: Schema.optional(Schema.Number),
});

export type CheckinDispatchPayload = Schema.Schema.Type<typeof CheckinDispatchPayload>;

export const CheckinDispatchResult = Schema.Struct({
  hour: Schema.Number,
  runningChannelId: Schema.String,
  checkinChannelId: Schema.String,
  checkinMessageId: Schema.NullOr(Schema.String),
  checkinMessageChannelId: Schema.NullOr(Schema.String),
  primaryMessageId: Schema.String,
  primaryMessageChannelId: Schema.String,
  tentativeRoomOrderMessageId: Schema.NullOr(Schema.String),
  tentativeRoomOrderMessageChannelId: Schema.NullOr(Schema.String),
});

export type CheckinDispatchResult = Schema.Schema.Type<typeof CheckinDispatchResult>;

export const CheckinHandleButtonPayload = Schema.Struct({
  messageId: Schema.String,
  interactionToken: Schema.String,
  interactionDeadlineEpochMs: Schema.Number,
});

export type CheckinHandleButtonPayload = Schema.Schema.Type<typeof CheckinHandleButtonPayload>;

export const CheckinHandleButtonResult = Schema.Struct({
  messageId: Schema.String,
  messageChannelId: Schema.String,
  checkedInMemberId: Schema.String,
});

export type CheckinHandleButtonResult = Schema.Schema.Type<typeof CheckinHandleButtonResult>;

export const RoomOrderDispatchPayload = Schema.Struct({
  dispatchRequestId: Schema.String,
  guildId: Schema.String,
  channelId: Schema.optional(Schema.String),
  channelName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  healNeeded: Schema.optional(Schema.Number),
  interactionToken: Schema.optional(Schema.String),
  interactionDeadlineEpochMs: Schema.optional(Schema.Number),
});

export type RoomOrderDispatchPayload = Schema.Schema.Type<typeof RoomOrderDispatchPayload>;

export const RoomOrderDispatchResult = Schema.Struct({
  messageId: Schema.String,
  messageChannelId: Schema.String,
  hour: Schema.Number,
  runningChannelId: Schema.String,
  rank: Schema.Number,
});

export type RoomOrderDispatchResult = Schema.Schema.Type<typeof RoomOrderDispatchResult>;

export const KickoutDispatchPayload = Schema.Struct({
  dispatchRequestId: Schema.String,
  guildId: Schema.String,
  channelId: Schema.optional(Schema.String),
  channelName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  interactionToken: Schema.optional(Schema.String),
  interactionDeadlineEpochMs: Schema.optional(Schema.Number),
});

export type KickoutDispatchPayload = Schema.Schema.Type<typeof KickoutDispatchPayload>;

export const KickoutDispatchResult = Schema.Struct({
  guildId: Schema.String,
  runningChannelId: Schema.String,
  hour: Schema.Number,
  roleId: Schema.NullOr(Schema.String),
  removedMemberIds: Schema.Array(Schema.String),
  status: Schema.Literals(["removed", "empty", "tooEarly", "missingRole"]),
});

export type KickoutDispatchResult = Schema.Schema.Type<typeof KickoutDispatchResult>;

export const SlotButtonDispatchPayload = Schema.Struct({
  dispatchRequestId: Schema.String,
  guildId: Schema.String,
  channelId: Schema.String,
  day: Schema.Number,
  interactionToken: Schema.String,
  interactionDeadlineEpochMs: Schema.Number,
});

export type SlotButtonDispatchPayload = Schema.Schema.Type<typeof SlotButtonDispatchPayload>;

export const SlotButtonDispatchResult = Schema.Struct({
  messageId: Schema.String,
  messageChannelId: Schema.String,
  day: Schema.Number,
});

export type SlotButtonDispatchResult = Schema.Schema.Type<typeof SlotButtonDispatchResult>;

export const SlotListMessageType = Schema.Literals(["persistent", "ephemeral"]);

export type SlotListMessageType = Schema.Schema.Type<typeof SlotListMessageType>;

export const SlotListDispatchPayload = Schema.Struct({
  dispatchRequestId: Schema.String,
  guildId: Schema.String,
  day: Schema.Number,
  messageType: SlotListMessageType,
  interactionToken: Schema.String,
  interactionDeadlineEpochMs: Schema.Number,
});

export type SlotListDispatchPayload = Schema.Schema.Type<typeof SlotListDispatchPayload>;

export const SlotListDispatchResult = Schema.Struct({
  guildId: Schema.String,
  day: Schema.Number,
  messageType: SlotListMessageType,
});

export type SlotListDispatchResult = Schema.Schema.Type<typeof SlotListDispatchResult>;

export const SlotOpenButtonPayload = Schema.Struct({
  messageId: Schema.String,
  interactionToken: Schema.String,
  interactionDeadlineEpochMs: Schema.Number,
});

export type SlotOpenButtonPayload = Schema.Schema.Type<typeof SlotOpenButtonPayload>;

export const SlotOpenButtonResult = Schema.Struct({
  messageId: Schema.String,
  guildId: Schema.String,
  day: Schema.Number,
});

export type SlotOpenButtonResult = Schema.Schema.Type<typeof SlotOpenButtonResult>;

export const ServiceStatusDispatchPayload = Schema.Struct({
  dispatchRequestId: Schema.String,
  interactionToken: Schema.String,
  interactionDeadlineEpochMs: Schema.Number,
});

export type ServiceStatusDispatchPayload = Schema.Schema.Type<typeof ServiceStatusDispatchPayload>;

export const GuildWelcomeDispatchPayload = Schema.Struct({
  dispatchRequestId: Schema.String,
  guildId: Schema.String,
  guildName: Schema.String,
  joinedAt: Schema.String,
  systemChannelId: Schema.optional(Schema.String),
});

export type GuildWelcomeDispatchPayload = Schema.Schema.Type<typeof GuildWelcomeDispatchPayload>;

export const GuildWelcomeDispatchResult = Schema.Struct({
  guildId: Schema.String,
  channelId: Schema.String,
  messageId: Schema.String,
});

export type GuildWelcomeDispatchResult = Schema.Schema.Type<typeof GuildWelcomeDispatchResult>;

export const ServiceGuildFeatureFlagDispatchPayload = Schema.Struct({
  dispatchRequestId: Schema.String,
  guildId: Schema.String,
  flagName: FeatureFlagName,
  systemChannelId: Schema.optional(Schema.String),
});

export type ServiceGuildFeatureFlagDispatchPayload = Schema.Schema.Type<
  typeof ServiceGuildFeatureFlagDispatchPayload
>;

export const ServiceGuildFeatureFlagDispatchResult = Schema.Struct({
  guildId: Schema.String,
  flagName: Schema.String,
  announcementChannelId: Schema.NullOr(Schema.String),
  announcementMessageId: Schema.NullOr(Schema.String),
});

export type ServiceGuildFeatureFlagDispatchResult = Schema.Schema.Type<
  typeof ServiceGuildFeatureFlagDispatchResult
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
  dispatchRequestId: Schema.String,
  guildId: Schema.String,
  guildName: Schema.String,
  joinedAt: Schema.String,
  systemChannelId: Schema.optional(Schema.String),
  announcement: UpdateAnnouncement,
});

export type UpdateAnnouncementDispatchPayload = Schema.Schema.Type<
  typeof UpdateAnnouncementDispatchPayload
>;

export const UpdateAnnouncementDispatchResult = Schema.Struct({
  guildId: Schema.String,
  announcementId: Schema.String,
  status: Schema.Literals(["sent", "skipped_not_gated", "skipped_already_delivered"]),
  announcementChannelId: Schema.NullOr(Schema.String),
  announcementMessageId: Schema.NullOr(Schema.String),
});

export type UpdateAnnouncementDispatchResult = Schema.Schema.Type<
  typeof UpdateAnnouncementDispatchResult
>;

export const ChannelListConfigDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  channelId: Schema.String,
});

export type ChannelListConfigDispatchPayload = Schema.Schema.Type<
  typeof ChannelListConfigDispatchPayload
>;

export const ChannelListConfigDispatchResult = Schema.Struct({
  guildId: Schema.String,
  channelId: Schema.String,
});

export type ChannelListConfigDispatchResult = Schema.Schema.Type<
  typeof ChannelListConfigDispatchResult
>;

export const ChannelSetDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  channelId: Schema.String,
  running: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
  roleId: Schema.optional(Schema.String),
  checkinChannelId: Schema.optional(Schema.String),
});

export type ChannelSetDispatchPayload = Schema.Schema.Type<typeof ChannelSetDispatchPayload>;

export const ChannelSetDispatchResult = Schema.Struct({
  guildId: Schema.String,
  channelId: Schema.String,
});

export type ChannelSetDispatchResult = Schema.Schema.Type<typeof ChannelSetDispatchResult>;

export const ChannelUnsetDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  channelId: Schema.String,
  running: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.Boolean),
  role: Schema.optional(Schema.Boolean),
  checkinChannel: Schema.optional(Schema.Boolean),
});

export type ChannelUnsetDispatchPayload = Schema.Schema.Type<typeof ChannelUnsetDispatchPayload>;

export const ChannelUnsetDispatchResult = ChannelSetDispatchResult;
export type ChannelUnsetDispatchResult = Schema.Schema.Type<typeof ChannelUnsetDispatchResult>;

export const ServerListConfigDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
});

export type ServerListConfigDispatchPayload = Schema.Schema.Type<
  typeof ServerListConfigDispatchPayload
>;

export const ServerListConfigDispatchResult = Schema.Struct({
  guildId: Schema.String,
  monitorRoleCount: Schema.Number,
});

export type ServerListConfigDispatchResult = Schema.Schema.Type<
  typeof ServerListConfigDispatchResult
>;

export const ServerAddMonitorRoleDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  roleId: Schema.String,
});

export type ServerAddMonitorRoleDispatchPayload = Schema.Schema.Type<
  typeof ServerAddMonitorRoleDispatchPayload
>;

export const ServerAddMonitorRoleDispatchResult = Schema.Struct({
  guildId: Schema.String,
  roleId: Schema.String,
});

export type ServerAddMonitorRoleDispatchResult = Schema.Schema.Type<
  typeof ServerAddMonitorRoleDispatchResult
>;

export const ServerRemoveMonitorRoleDispatchPayload = ServerAddMonitorRoleDispatchPayload;
export type ServerRemoveMonitorRoleDispatchPayload = Schema.Schema.Type<
  typeof ServerRemoveMonitorRoleDispatchPayload
>;

export const ServerRemoveMonitorRoleDispatchResult = ServerAddMonitorRoleDispatchResult;
export type ServerRemoveMonitorRoleDispatchResult = Schema.Schema.Type<
  typeof ServerRemoveMonitorRoleDispatchResult
>;

export const ServerSetSheetDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  sheetId: Schema.String,
});

export type ServerSetSheetDispatchPayload = Schema.Schema.Type<
  typeof ServerSetSheetDispatchPayload
>;

export const ServerSetSheetDispatchResult = Schema.Struct({
  guildId: Schema.String,
  sheetId: Schema.String,
});

export type ServerSetSheetDispatchResult = Schema.Schema.Type<typeof ServerSetSheetDispatchResult>;

export const ServerSetAutoCheckinDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  autoCheckin: Schema.Boolean,
});

export type ServerSetAutoCheckinDispatchPayload = Schema.Schema.Type<
  typeof ServerSetAutoCheckinDispatchPayload
>;

export const ServerSetAutoCheckinDispatchResult = Schema.Struct({
  guildId: Schema.String,
  autoCheckin: Schema.Boolean,
});

export type ServerSetAutoCheckinDispatchResult = Schema.Schema.Type<
  typeof ServerSetAutoCheckinDispatchResult
>;

export const TeamListDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  targetUserId: Schema.String,
  targetUsername: Schema.String,
});

export type TeamListDispatchPayload = Schema.Schema.Type<typeof TeamListDispatchPayload>;

export const TeamListDispatchResult = Schema.Struct({
  guildId: Schema.String,
  targetUserId: Schema.String,
  teamCount: Schema.Number,
});

export type TeamListDispatchResult = Schema.Schema.Type<typeof TeamListDispatchResult>;

export const ScheduleListDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  day: Schema.Number,
  targetUserId: Schema.String,
  targetUsername: Schema.String,
});

export type ScheduleListDispatchPayload = Schema.Schema.Type<typeof ScheduleListDispatchPayload>;

export const ScheduleListDispatchResult = Schema.Struct({
  guildId: Schema.String,
  day: Schema.Number,
  targetUserId: Schema.String,
  invisible: Schema.Boolean,
});

export type ScheduleListDispatchResult = Schema.Schema.Type<typeof ScheduleListDispatchResult>;

export const ScreenshotDispatchPayload = Schema.Struct({
  ...CommandDispatchPayloadBase,
  guildId: Schema.String,
  channelName: Schema.String,
  day: Schema.Number,
});

export type ScreenshotDispatchPayload = Schema.Schema.Type<typeof ScreenshotDispatchPayload>;

export const ScreenshotDispatchResult = Schema.Struct({
  guildId: Schema.String,
  channelName: Schema.String,
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
    "checkin",
    "roomOrder",
    "kickout",
    "slotButton",
    "slotList",
    "slotOpenButton",
    "serviceStatus",
    "guildWelcome",
    "updateAnnouncement",
    "serviceAddGuildFeatureFlag",
    "serviceRemoveGuildFeatureFlag",
    "checkinButton",
    "roomOrderPreviousButton",
    "roomOrderNextButton",
    "roomOrderSendButton",
    "roomOrderPinTentativeButton",
    "channelListConfig",
    "channelSet",
    "channelUnset",
    "serverListConfig",
    "serverAddMonitorRole",
    "serverRemoveMonitorRole",
    "serverSetSheet",
    "serverSetAutoCheckin",
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
  guildId: Schema.String,
  messageId: Schema.String,
  messageChannelId: Schema.String,
  messageContent: Schema.optional(Schema.NullOr(Schema.String)),
  interactionToken: Schema.String,
  interactionDeadlineEpochMs: Schema.Number,
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
  messageChannelId: Schema.String,
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
