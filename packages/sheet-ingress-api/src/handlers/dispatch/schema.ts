import { Schema } from "effect";
import { ArgumentError, SchemaError, UnknownError } from "typhoon-core/error";
import { QueryResultError } from "typhoon-zero/error";
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
    "checkinButton",
    "roomOrderPreviousButton",
    "roomOrderNextButton",
    "roomOrderSendButton",
    "roomOrderPinTentativeButton",
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
