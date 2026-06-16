import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { pipe, Schema } from "effect";
import { ArgumentError, SchemaError, UnknownError } from "typhoon-core/error";
import { MutatorResultError, QueryResultError } from "typhoon-zero/error";
import { SheetApisRpcAuthorization } from "./middlewares/sheetApisRpcAuthorization/tag";
import { CheckinGenerateResult } from "./schemas/checkin";
import { DiscordGuild, DiscordUser } from "./schemas/discord";
import { GoogleSheetsError } from "./schemas/google";
import {
  FeatureFlagName,
  GuildChannelConfig,
  GuildConfig,
  GuildFeatureFlag,
  GuildConfigMonitorRole,
  GuildUpdateAnnouncementDelivery,
  GuildUpdateAnnouncementDeliveryClaimResult,
} from "./schemas/guildConfig";
import { MessageCheckin, MessageCheckinMember } from "./schemas/messageCheckin";
import {
  MessageRoomOrder,
  MessageRoomOrderEntry,
  MessageRoomOrderRange,
} from "./schemas/messageRoomOrder";
import { MessageSlot } from "./schemas/messageSlot";
import { Unauthorized } from "typhoon-core/error";
import { CurrentUserPermissions } from "./schemas/permissions";
import { RoomOrderGenerateResult } from "./schemas/roomOrder";
import {
  Monitor,
  PartialIdMonitor,
  PartialIdPlayer,
  PartialNameMonitor,
  PartialNamePlayer,
  Player,
  PlayerDayScheduleResponse,
  PopulatedScheduleResponse,
  RawMonitor,
  RawPlayer,
  ScheduleResponse,
  ScheduleView,
  Team,
} from "./schemas/sheet";
import { ParserFieldError } from "./schemas/sheet/error";
import { Room } from "./schemas/sheet/room";
import {
  EventConfig,
  RangesConfig,
  RunnerConfig,
  ScheduleConfig,
  SheetConfigError,
  TeamConfig,
} from "./schemas/sheetConfig";
import { HealthResponseSchema } from "./handlers/health/schema";
import { ServicesStatusResponse } from "./handlers/status/schema";
import {
  annotateRpcScopePolicy,
  SheetRpcScopePolicies,
  type SheetRpcScopePolicy,
} from "./middlewares/rpcScopePolicy";
import {
  AutoCheckinTestChannelResult,
  AutoCheckinTestDispatchPayload,
  AutoCheckinTestDispatchResult,
  CheckinDispatchError,
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonError,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  DispatchAcceptedResult,
  DispatchRoomOrderButtonMethods,
  GuildWelcomeDispatchError,
  GuildWelcomeDispatchPayload,
  GuildWelcomeDispatchResult,
  interactionTokenExpirySafetyMarginMs,
  interactionTokenLifetimeMs,
  KickoutDispatchError,
  KickoutDispatchPayload,
  KickoutDispatchResult,
  RoomOrderDispatchError,
  RoomOrderDispatchPayload,
  RoomOrderDispatchResult,
  RoomOrderHandleButtonError,
  RoomOrderNextButtonPayload,
  RoomOrderNextButtonResult,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPinTentativeButtonResult,
  RoomOrderPreviousButtonPayload,
  RoomOrderPreviousButtonResult,
  RoomOrderSendButtonPayload,
  RoomOrderSendButtonResult,
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
  ServiceGuildFeatureFlagDispatchPayload,
  ServiceGuildFeatureFlagDispatchResult,
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotDispatchError,
  SlotListDispatchPayload,
  SlotListDispatchResult,
  SlotOpenButtonPayload,
  SlotOpenButtonResult,
  UpdateAnnouncementDispatchError,
  UpdateAnnouncementDispatchPayload,
  UpdateAnnouncementDispatchResult,
} from "./handlers/dispatch/schema";

export {
  AutoCheckinTestChannelResult,
  AutoCheckinTestDispatchPayload,
  AutoCheckinTestDispatchResult,
  CheckinDispatchError,
  CheckinDispatchPayload,
  CheckinDispatchResult,
  CheckinHandleButtonError,
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
  ChannelListConfigDispatchPayload,
  ChannelListConfigDispatchResult,
  ChannelSetDispatchPayload,
  ChannelSetDispatchResult,
  ChannelUnsetDispatchPayload,
  ChannelUnsetDispatchResult,
  DispatchAcceptedResult,
  DispatchRoomOrderButtonMethods,
  GuildWelcomeDispatchError,
  GuildWelcomeDispatchPayload,
  GuildWelcomeDispatchResult,
  interactionTokenExpirySafetyMarginMs,
  interactionTokenLifetimeMs,
  KickoutDispatchError,
  KickoutDispatchPayload,
  KickoutDispatchResult,
  RoomOrderButtonBasePayload,
  RoomOrderButtonInteractionResponseType,
  RoomOrderButtonResult,
  RoomOrderDispatchError,
  RoomOrderDispatchPayload,
  RoomOrderDispatchResult,
  RoomOrderHandleButtonError,
  RoomOrderNextButtonPayload,
  RoomOrderNextButtonResult,
  RoomOrderPinTentativeButtonPayload,
  RoomOrderPinTentativeButtonResult,
  RoomOrderPreviousButtonPayload,
  RoomOrderPreviousButtonResult,
  RoomOrderSendButtonPayload,
  RoomOrderSendButtonResult,
  ScheduleListDispatchPayload,
  ScheduleListDispatchResult,
  ServiceStatusDispatchPayload,
  ServiceStatusDispatchResult,
  ServiceGuildFeatureFlagDispatchPayload,
  ServiceGuildFeatureFlagDispatchResult,
  ServerAddMonitorRoleDispatchPayload,
  ServerAddMonitorRoleDispatchResult,
  ServerListConfigDispatchPayload,
  ServerListConfigDispatchResult,
  ServerRemoveMonitorRoleDispatchPayload,
  ServerRemoveMonitorRoleDispatchResult,
  ServerSetAutoCheckinDispatchPayload,
  ServerSetAutoCheckinDispatchResult,
  ServerSetSheetDispatchPayload,
  ServerSetSheetDispatchResult,
  ScreenshotDispatchPayload,
  ScreenshotDispatchResult,
  SlotButtonDispatchPayload,
  SlotButtonDispatchResult,
  SlotDispatchError,
  SlotListDispatchPayload,
  SlotListDispatchResult,
  SlotOpenButtonPayload,
  SlotOpenButtonResult,
  TeamListDispatchPayload,
  TeamListDispatchResult,
  UpdateAnnouncement,
  UpdateAnnouncementDispatchError,
  UpdateAnnouncementDispatchPayload,
  UpdateAnnouncementDispatchResult,
} from "./handlers/dispatch/schema";
export { ServiceStatus, ServicesStatusResponse } from "./handlers/status/schema";

const Query = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ query: Schema.Struct(fields) });

const Payload = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct({ payload: Schema.Struct(fields) });

const ScheduleViewUrlParam = Schema.optional(ScheduleView);

const CalcError = Schema.Union([
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
]);

const CheckinGenerateError = Schema.Union([
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
]);

const MonitorError = Schema.Union([
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
]);

const PlayerError = Schema.Union([
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
]);

const RoomOrderGenerateError = Schema.Union([
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  ArgumentError,
]);

export const MESSAGE_ROOM_ORDER_NOT_REGISTERED_ERROR_MESSAGE =
  "Cannot get message room order, the message might not be registered";

const ScheduleError = Schema.Union([
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
]);

const ScreenshotError = Schema.Union([
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
  UnknownError,
]);

const SheetError = Schema.Union([
  GoogleSheetsError,
  ParserFieldError,
  SheetConfigError,
  SchemaError,
  QueryResultError,
]);

const messageRoomOrderData = Schema.Struct({
  previousFills: Schema.Array(Schema.String),
  fills: Schema.Array(Schema.String),
  hour: Schema.Number,
  rank: Schema.Number,
  tentative: Schema.optional(Schema.Boolean),
  monitor: Schema.optional(Schema.NullOr(Schema.String)),
  guildId: Schema.NullOr(Schema.String),
  messageChannelId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
});

const messageCheckinData = Schema.Struct({
  initialMessage: Schema.String,
  hour: Schema.Number,
  channelId: Schema.String,
  roleId: Schema.optional(Schema.NullOr(Schema.String)),
  guildId: Schema.NullOr(Schema.String),
  messageChannelId: Schema.NullOr(Schema.String),
  createdByUserId: Schema.NullOr(Schema.String),
});

const messageRoomOrderEntryInput = Schema.Struct({
  rank: Schema.Number,
  position: Schema.Number,
  hour: Schema.Number,
  team: Schema.String,
  tags: Schema.Array(Schema.String),
  effectValue: Schema.Number,
});

const protectedRpc = <
  const Tag extends string,
  PayloadSchema extends Schema.Codec<unknown, unknown, never, never>,
  Success extends Schema.Codec<unknown, unknown, never, never>,
  Error extends Schema.Codec<unknown, unknown, never, never>,
  const ScopePolicy extends SheetRpcScopePolicy,
>(
  tag: Tag,
  options: {
    readonly scopePolicy: ScopePolicy;
    readonly payload?: PayloadSchema;
    readonly success: Success;
    readonly error: Error;
  },
) => {
  const { scopePolicy, ...rpcOptions } = options;
  return annotateRpcScopePolicy(
    Rpc.make(tag, {
      ...rpcOptions,
      error: Schema.Union([options.error, Unauthorized]),
    }).middleware(SheetApisRpcAuthorization),
    scopePolicy,
  );
};

const noneScopePolicy = SheetRpcScopePolicies.none;
const serviceScopePolicy = SheetRpcScopePolicies.service;
const readScopePolicy = SheetRpcScopePolicies.oauth("sheet.read");
const writeScopePolicy = SheetRpcScopePolicies.oauth("sheet.write");
const manageScopePolicy = SheetRpcScopePolicies.oauth("sheet.manage");
const workflowDispatchScopePolicy = SheetRpcScopePolicies.oauth("workflow.dispatch");

export const CalcRpcs = RpcGroup.make(
  protectedRpc("calc.calcBot", {
    scopePolicy: serviceScopePolicy,
    payload: Payload({
      config: Schema.Struct({
        healNeeded: Schema.Number,
        considerEnc: Schema.Boolean,
      }),
      players: pipe(Schema.Array(Schema.Array(Team)), Schema.check(Schema.isLengthBetween(5, 5))),
    }),
    success: Schema.Array(
      Schema.Struct({
        averageTalent: Schema.Number,
        averageEffectValue: Schema.Number,
        room: Schema.Array(
          Schema.Struct({
            type: Schema.String,
            team: Schema.String,
            talent: Schema.Number,
            effectValue: Schema.Number,
            tags: Schema.Array(Schema.String),
          }),
        ),
      }),
    ),
    error: SchemaError,
  }),
  protectedRpc("calc.calcSheet", {
    scopePolicy: noneScopePolicy,
    payload: Payload({
      sheetId: Schema.String,
      config: Schema.Struct({
        cc: Schema.Boolean,
        considerEnc: Schema.Boolean,
        healNeeded: Schema.Number,
      }),
      players: pipe(
        Schema.Array(Schema.Struct({ name: Schema.String, encable: Schema.Boolean })),
        Schema.check(Schema.isLengthBetween(5, 5)),
      ),
      fixedTeams: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          heal: Schema.Boolean,
        }),
      ),
    }),
    success: Schema.Array(Room),
    error: CalcError,
  }),
);

export const CheckinRpcs = RpcGroup.make(
  protectedRpc("checkin.generate", {
    scopePolicy: readScopePolicy,
    payload: Payload({
      guildId: Schema.String,
      channelId: Schema.optional(Schema.String),
      channelName: Schema.optional(Schema.String),
      hour: Schema.optional(Schema.Number),
      template: Schema.optional(Schema.String),
    }),
    success: CheckinGenerateResult,
    error: CheckinGenerateError,
  }),
);

export const DispatchRpcs = RpcGroup.make(
  protectedRpc("dispatch.checkin", {
    scopePolicy: workflowDispatchScopePolicy,
    payload: Schema.Struct({
      payload: CheckinDispatchPayload,
    }),
    success: DispatchAcceptedResult,
    error: CheckinDispatchError,
  }),
  protectedRpc("dispatch.checkinButton", {
    scopePolicy: workflowDispatchScopePolicy,
    payload: Schema.Struct({
      payload: CheckinHandleButtonPayload,
    }),
    success: DispatchAcceptedResult,
    error: CheckinHandleButtonError,
  }),
  protectedRpc("dispatch.roomOrder", {
    scopePolicy: workflowDispatchScopePolicy,
    payload: Schema.Struct({
      payload: RoomOrderDispatchPayload,
    }),
    success: DispatchAcceptedResult,
    error: RoomOrderDispatchError,
  }),
  protectedRpc(DispatchRoomOrderButtonMethods.previous.rpcTag, {
    scopePolicy: workflowDispatchScopePolicy,
    payload: Schema.Struct({
      payload: RoomOrderPreviousButtonPayload,
    }),
    success: DispatchAcceptedResult,
    error: RoomOrderHandleButtonError,
  }),
  protectedRpc(DispatchRoomOrderButtonMethods.next.rpcTag, {
    scopePolicy: workflowDispatchScopePolicy,
    payload: Schema.Struct({
      payload: RoomOrderNextButtonPayload,
    }),
    success: DispatchAcceptedResult,
    error: RoomOrderHandleButtonError,
  }),
  protectedRpc(DispatchRoomOrderButtonMethods.send.rpcTag, {
    scopePolicy: workflowDispatchScopePolicy,
    payload: Schema.Struct({
      payload: RoomOrderSendButtonPayload,
    }),
    success: DispatchAcceptedResult,
    error: RoomOrderHandleButtonError,
  }),
  protectedRpc(DispatchRoomOrderButtonMethods.pinTentative.rpcTag, {
    scopePolicy: workflowDispatchScopePolicy,
    payload: Schema.Struct({
      payload: RoomOrderPinTentativeButtonPayload,
    }),
    success: DispatchAcceptedResult,
    error: RoomOrderHandleButtonError,
  }),
);

export const DiscordRpcs = RpcGroup.make(
  protectedRpc("discord.getCurrentUser", {
    scopePolicy: readScopePolicy,
    success: DiscordUser,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("discord.getCurrentUserGuilds", {
    scopePolicy: readScopePolicy,
    success: Schema.Array(DiscordGuild),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
);

export const GuildConfigRpcs = RpcGroup.make(
  protectedRpc("guildConfig.getAutoCheckinGuilds", {
    scopePolicy: serviceScopePolicy,
    success: Schema.Array(GuildConfig),
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("guildConfig.getGuildConfig", {
    scopePolicy: manageScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: GuildConfig,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("guildConfig.upsertGuildConfig", {
    scopePolicy: manageScopePolicy,
    payload: Payload({
      guildId: Schema.String,
      config: Schema.Struct({
        sheetId: Schema.optional(Schema.NullOr(Schema.String)),
        autoCheckin: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    }),
    success: GuildConfig,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.getGuildMonitorRoles", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(GuildConfigMonitorRole),
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("guildConfig.getGuildFeatureFlags", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(GuildFeatureFlag),
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("guildConfig.getGuildsForFeatureFlag", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ flagName: FeatureFlagName }),
    success: Schema.Array(GuildFeatureFlag),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("guildConfig.getGuildUpdateAnnouncementDelivery", {
    scopePolicy: serviceScopePolicy,
    payload: Query({
      guildId: Schema.String,
      announcementId: Schema.String,
    }),
    success: Schema.Option(GuildUpdateAnnouncementDelivery),
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("guildConfig.getGuildChannels", {
    scopePolicy: readScopePolicy,
    payload: Query({
      guildId: Schema.String,
      running: Schema.optional(Schema.Boolean),
    }),
    success: Schema.Array(GuildChannelConfig),
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("guildConfig.addGuildMonitorRole", {
    scopePolicy: manageScopePolicy,
    payload: Payload({ guildId: Schema.String, roleId: Schema.String }),
    success: GuildConfigMonitorRole,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.removeGuildMonitorRole", {
    scopePolicy: manageScopePolicy,
    payload: Payload({ guildId: Schema.String, roleId: Schema.String }),
    success: GuildConfigMonitorRole,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.addGuildFeatureFlag", {
    scopePolicy: serviceScopePolicy,
    payload: Payload({ guildId: Schema.String, flagName: FeatureFlagName }),
    success: GuildFeatureFlag,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError, ArgumentError]),
  }),
  protectedRpc("guildConfig.removeGuildFeatureFlag", {
    scopePolicy: serviceScopePolicy,
    payload: Payload({ guildId: Schema.String, flagName: FeatureFlagName }),
    success: GuildFeatureFlag,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError, ArgumentError]),
  }),
  protectedRpc("guildConfig.recordGuildUpdateAnnouncementDelivery", {
    scopePolicy: serviceScopePolicy,
    payload: Payload({
      guildId: Schema.String,
      announcementId: Schema.String,
      publishedAt: Schema.DateTimeUtcFromMillis,
      deliveredAt: Schema.DateTimeUtcFromMillis,
      channelId: Schema.String,
      messageId: Schema.String,
    }),
    success: GuildUpdateAnnouncementDelivery,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.claimGuildUpdateAnnouncementDelivery", {
    scopePolicy: serviceScopePolicy,
    payload: Payload({
      guildId: Schema.String,
      announcementId: Schema.String,
      publishedAt: Schema.DateTimeUtcFromMillis,
      claimToken: Schema.String,
    }),
    success: GuildUpdateAnnouncementDeliveryClaimResult,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.releaseGuildUpdateAnnouncementDeliveryClaim", {
    scopePolicy: serviceScopePolicy,
    payload: Payload({
      guildId: Schema.String,
      announcementId: Schema.String,
      claimToken: Schema.String,
    }),
    success: Schema.Void,
    error: Schema.Union([SchemaError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.upsertGuildChannelConfig", {
    scopePolicy: manageScopePolicy,
    payload: Payload({
      guildId: Schema.String,
      channelId: Schema.String,
      config: Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.String)),
        running: Schema.optional(Schema.NullOr(Schema.Boolean)),
        roleId: Schema.optional(Schema.NullOr(Schema.String)),
        checkinChannelId: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    }),
    success: GuildChannelConfig,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.getGuildChannelById", {
    scopePolicy: readScopePolicy,
    payload: Query({
      guildId: Schema.String,
      channelId: Schema.String,
      running: Schema.optional(Schema.Boolean),
    }),
    success: GuildChannelConfig,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("guildConfig.getGuildChannelByName", {
    scopePolicy: readScopePolicy,
    payload: Query({
      guildId: Schema.String,
      channelName: Schema.String,
      running: Schema.optional(Schema.Boolean),
    }),
    success: GuildChannelConfig,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
);

export const HealthRpcs = RpcGroup.make(
  Rpc.make("health.live", { success: HealthResponseSchema }),
  Rpc.make("health.ready", { success: HealthResponseSchema, error: UnknownError }),
);

export const StatusRpcs = RpcGroup.make(
  protectedRpc("status.getServices", {
    scopePolicy: noneScopePolicy,
    success: ServicesStatusResponse,
    error: UnknownError,
  }),
);

export const MessageCheckinRpcs = RpcGroup.make(
  protectedRpc("messageCheckin.getMessageCheckinData", {
    scopePolicy: readScopePolicy,
    payload: Query({ messageId: Schema.String }),
    success: MessageCheckin,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError, Unauthorized]),
  }),
  protectedRpc("messageCheckin.upsertMessageCheckinData", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      data: messageCheckinData,
    }),
    success: MessageCheckin,
    error: Schema.Union([SchemaError, QueryResultError, Unauthorized]),
  }),
  protectedRpc("messageCheckin.getMessageCheckinMembers", {
    scopePolicy: readScopePolicy,
    payload: Query({ messageId: Schema.String }),
    success: Schema.Array(MessageCheckinMember),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError, Unauthorized]),
  }),
  protectedRpc("messageCheckin.addMessageCheckinMembers", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      memberIds: Schema.Array(Schema.String),
    }),
    success: Schema.Array(MessageCheckinMember),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError, Unauthorized]),
  }),
  protectedRpc("messageCheckin.persistMessageCheckin", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      data: messageCheckinData,
      memberIds: Schema.Array(Schema.String),
    }),
    success: MessageCheckin,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError, Unauthorized]),
  }),
  protectedRpc("messageCheckin.setMessageCheckinMemberCheckinAt", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      memberId: Schema.String,
      checkinAt: Schema.Number,
    }),
    success: MessageCheckinMember,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError, Unauthorized]),
  }),
  protectedRpc("messageCheckin.setMessageCheckinMemberCheckinAtIfUnset", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      memberId: Schema.String,
      checkinAt: Schema.Number,
      checkinClaimId: Schema.String,
    }),
    success: MessageCheckinMember,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError, Unauthorized]),
  }),
  protectedRpc("messageCheckin.removeMessageCheckinMember", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      memberId: Schema.String,
    }),
    success: MessageCheckinMember,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError, Unauthorized]),
  }),
);

export const MessageRoomOrderRpcs = RpcGroup.make(
  protectedRpc("messageRoomOrder.getMessageRoomOrder", {
    scopePolicy: readScopePolicy,
    payload: Query({ messageId: Schema.String }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.upsertMessageRoomOrder", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      data: messageRoomOrderData,
    }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("messageRoomOrder.persistMessageRoomOrder", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      data: messageRoomOrderData,
      entries: Schema.Array(messageRoomOrderEntryInput),
    }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("messageRoomOrder.decrementMessageRoomOrderRank", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      expectedRank: Schema.optional(Schema.Number),
      tentativeUpdateClaimId: Schema.optional(Schema.String),
    }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.incrementMessageRoomOrderRank", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      expectedRank: Schema.optional(Schema.Number),
      tentativeUpdateClaimId: Schema.optional(Schema.String),
    }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.getMessageRoomOrderEntry", {
    scopePolicy: readScopePolicy,
    payload: Query({
      messageId: Schema.String,
      rank: Schema.Number,
    }),
    success: Schema.Array(MessageRoomOrderEntry),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.getMessageRoomOrderRange", {
    scopePolicy: readScopePolicy,
    payload: Query({ messageId: Schema.String }),
    success: MessageRoomOrderRange,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.upsertMessageRoomOrderEntry", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      entries: Schema.Array(messageRoomOrderEntryInput),
    }),
    success: Schema.Array(MessageRoomOrderEntry),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.removeMessageRoomOrderEntry", {
    scopePolicy: writeScopePolicy,
    payload: Payload({ messageId: Schema.String }),
    success: Schema.Array(MessageRoomOrderEntry),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.claimMessageRoomOrderSend", {
    scopePolicy: writeScopePolicy,
    payload: Payload({ messageId: Schema.String, claimId: Schema.String }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.completeMessageRoomOrderSend", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      claimId: Schema.String,
      sentMessage: Schema.Struct({
        id: Schema.String,
        channelId: Schema.String,
      }),
    }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.releaseMessageRoomOrderSendClaim", {
    scopePolicy: writeScopePolicy,
    payload: Payload({ messageId: Schema.String, claimId: Schema.String }),
    success: Schema.Void,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.claimMessageRoomOrderTentativeUpdate", {
    scopePolicy: writeScopePolicy,
    payload: Payload({ messageId: Schema.String, claimId: Schema.String }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.releaseMessageRoomOrderTentativeUpdateClaim", {
    scopePolicy: writeScopePolicy,
    payload: Payload({ messageId: Schema.String, claimId: Schema.String }),
    success: Schema.Void,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.claimMessageRoomOrderTentativePin", {
    scopePolicy: writeScopePolicy,
    payload: Payload({ messageId: Schema.String, claimId: Schema.String }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.completeMessageRoomOrderTentativePin", {
    scopePolicy: writeScopePolicy,
    payload: Payload({ messageId: Schema.String, claimId: Schema.String }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.releaseMessageRoomOrderTentativePinClaim", {
    scopePolicy: writeScopePolicy,
    payload: Payload({ messageId: Schema.String, claimId: Schema.String }),
    success: Schema.Void,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.markMessageRoomOrderTentative", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
    }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
);

export const MessageSlotRpcs = RpcGroup.make(
  protectedRpc("messageSlot.getMessageSlotData", {
    scopePolicy: readScopePolicy,
    payload: Query({ messageId: Schema.String }),
    success: MessageSlot,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageSlot.upsertMessageSlotData", {
    scopePolicy: writeScopePolicy,
    payload: Payload({
      messageId: Schema.String,
      data: Schema.Struct({
        day: Schema.Number,
        guildId: Schema.NullOr(Schema.String),
        messageChannelId: Schema.NullOr(Schema.String),
        createdByUserId: Schema.NullOr(Schema.String),
      }),
    }),
    success: MessageSlot,
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
);

export const MonitorRpcs = RpcGroup.make(
  protectedRpc("monitor.getMonitorMaps", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Struct({
      idToMonitor: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          value: Schema.Array(Monitor),
        }),
      ),
      nameToMonitor: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          value: Schema.Struct({
            name: Schema.String,
            monitors: Schema.Array(Monitor),
          }),
        }),
      ),
    }),
    error: MonitorError,
  }),
  protectedRpc("monitor.getByIds", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String, ids: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Schema.Union([Monitor, PartialIdMonitor]))),
    error: MonitorError,
  }),
  protectedRpc("monitor.getByNames", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String, names: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Schema.Union([Monitor, PartialNameMonitor]))),
    error: MonitorError,
  }),
);

export const PermissionsRpcs = RpcGroup.make(
  protectedRpc("permissions.getCurrentUserPermissions", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.optional(Schema.String) }),
    success: CurrentUserPermissions,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
);

export const PlayerRpcs = RpcGroup.make(
  protectedRpc("player.getPlayerMaps", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Struct({
      nameToPlayer: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          value: Schema.Struct({
            name: Schema.String,
            players: Schema.Array(Player),
          }),
        }),
      ),
      idToPlayer: Schema.Array(
        Schema.Struct({
          key: Schema.String,
          value: Schema.Array(Player),
        }),
      ),
    }),
    error: PlayerError,
  }),
  protectedRpc("player.getByIds", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String, ids: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Schema.Union([Player, PartialIdPlayer]))),
    error: PlayerError,
  }),
  protectedRpc("player.getByNames", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String, names: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Schema.Union([Player, PartialNamePlayer]))),
    error: PlayerError,
  }),
  protectedRpc("player.getTeamsByIds", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String, ids: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Team)),
    error: PlayerError,
  }),
  protectedRpc("player.getTeamsByNames", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String, names: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Team)),
    error: PlayerError,
  }),
);

export const RoomOrderRpcs = RpcGroup.make(
  protectedRpc("roomOrder.generate", {
    scopePolicy: readScopePolicy,
    payload: Payload({
      guildId: Schema.String,
      channelId: Schema.optional(Schema.String),
      channelName: Schema.optional(Schema.String),
      hour: Schema.optional(Schema.Number),
      healNeeded: Schema.optional(Schema.Number),
    }),
    success: RoomOrderGenerateResult,
    error: RoomOrderGenerateError,
  }),
);

export const ScheduleRpcs = RpcGroup.make(
  protectedRpc("schedule.getAllPopulatedSchedules", {
    scopePolicy: readScopePolicy,
    payload: Query({ guildId: Schema.String, view: ScheduleViewUrlParam }),
    success: PopulatedScheduleResponse,
    error: ScheduleError,
  }),
  protectedRpc("schedule.getDayPopulatedSchedules", {
    scopePolicy: readScopePolicy,
    payload: Query({
      guildId: Schema.String,
      day: Schema.Number,
      view: ScheduleViewUrlParam,
    }),
    success: PopulatedScheduleResponse,
    error: ScheduleError,
  }),
  protectedRpc("schedule.getChannelPopulatedSchedules", {
    scopePolicy: readScopePolicy,
    payload: Query({
      guildId: Schema.String,
      channel: Schema.String,
      view: ScheduleViewUrlParam,
    }),
    success: PopulatedScheduleResponse,
    error: ScheduleError,
  }),
  protectedRpc("schedule.getDayPlayerSchedule", {
    scopePolicy: readScopePolicy,
    payload: Query({
      guildId: Schema.String,
      day: Schema.Number,
      accountId: Schema.String,
      view: ScheduleViewUrlParam,
    }),
    success: PlayerDayScheduleResponse,
    error: ScheduleError,
  }),
);

export const ScreenshotRpcs = RpcGroup.make(
  protectedRpc("screenshot.getScreenshot", {
    scopePolicy: readScopePolicy,
    payload: Query({
      guildId: Schema.String,
      channel: Schema.String,
      day: Schema.Number,
    }),
    success: Schema.Uint8Array,
    error: ScreenshotError,
  }),
);

export const SheetRpcs = RpcGroup.make(
  protectedRpc("sheet.getPlayers", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(RawPlayer),
    error: SheetError,
  }),
  protectedRpc("sheet.getMonitors", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(RawMonitor),
    error: SheetError,
  }),
  protectedRpc("sheet.getTeams", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(Team),
    error: SheetError,
  }),
  protectedRpc("sheet.getAllSchedules", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String, view: ScheduleViewUrlParam }),
    success: ScheduleResponse,
    error: SheetError,
  }),
  protectedRpc("sheet.getDaySchedules", {
    scopePolicy: serviceScopePolicy,
    payload: Query({
      guildId: Schema.String,
      day: Schema.Number,
      view: ScheduleViewUrlParam,
    }),
    success: ScheduleResponse,
    error: SheetError,
  }),
  protectedRpc("sheet.getChannelSchedules", {
    scopePolicy: serviceScopePolicy,
    payload: Query({
      guildId: Schema.String,
      channel: Schema.String,
      view: ScheduleViewUrlParam,
    }),
    success: ScheduleResponse,
    error: SheetError,
  }),
  protectedRpc("sheet.getRangesConfig", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: RangesConfig,
    error: SheetError,
  }),
  protectedRpc("sheet.getTeamConfig", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(TeamConfig),
    error: SheetError,
  }),
  protectedRpc("sheet.getEventConfig", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: EventConfig,
    error: SheetError,
  }),
  protectedRpc("sheet.getScheduleConfig", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(ScheduleConfig),
    error: SheetError,
  }),
  protectedRpc("sheet.getRunnerConfig", {
    scopePolicy: serviceScopePolicy,
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(RunnerConfig),
    error: SheetError,
  }),
);

export const SheetApisRpcs = CalcRpcs.merge(
  CheckinRpcs,
  DiscordRpcs,
  GuildConfigRpcs,
  HealthRpcs,
  MessageCheckinRpcs,
  MessageRoomOrderRpcs,
  MessageSlotRpcs,
  MonitorRpcs,
  PermissionsRpcs,
  PlayerRpcs,
  RoomOrderRpcs,
  ScheduleRpcs,
  ScreenshotRpcs,
  SheetRpcs,
  StatusRpcs,
);
