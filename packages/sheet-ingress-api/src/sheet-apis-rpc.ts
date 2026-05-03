import { Rpc, RpcGroup } from "effect/unstable/rpc";
import { pipe, Schema } from "effect";
import { ArgumentError, SchemaError, UnknownError } from "typhoon-core/error";
import { MutatorResultError, QueryResultError } from "typhoon-zero/error";
import { SheetApisRpcAuthorization } from "./middlewares/sheetApisRpcAuthorization/tag";
import { CheckinGenerateResult } from "./schemas/checkin";
import { DiscordGuild, DiscordUser } from "./schemas/discord";
import { GoogleSheetsError } from "./schemas/google";
import { GuildChannelConfig, GuildConfig, GuildConfigMonitorRole } from "./schemas/guildConfig";
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

const CheckinDispatchError = Schema.Union([CheckinGenerateError, UnknownError]);

const MessageCheckinError = Schema.Union([
  SchemaError,
  QueryResultError,
  ArgumentError,
  UnknownError,
]);

const CheckinHandleButtonError = Schema.Union([
  CheckinGenerateError,
  MessageCheckinError,
  UnknownError,
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

const RoomOrderDispatchError = Schema.Union([RoomOrderGenerateError, UnknownError]);

const MessageRoomOrderError = Schema.Union([
  SchemaError,
  QueryResultError,
  ArgumentError,
  UnknownError,
]);

const RoomOrderHandleButtonError = Schema.Union([
  RoomOrderGenerateError,
  MessageRoomOrderError,
  UnknownError,
]);

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

export const CheckinDispatchPayload = Schema.Struct({
  guildId: Schema.String,
  channelId: Schema.optional(Schema.String),
  channelName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  template: Schema.optional(Schema.String),
  interactionToken: Schema.optional(Schema.String),
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
  guildId: Schema.String,
  messageId: Schema.String,
  messageChannelId: Schema.String,
  interactionToken: Schema.String,
});

export type CheckinHandleButtonPayload = Schema.Schema.Type<typeof CheckinHandleButtonPayload>;

export const CheckinHandleButtonResult = Schema.Struct({
  messageId: Schema.String,
  messageChannelId: Schema.String,
  checkedInMemberId: Schema.String,
});

export type CheckinHandleButtonResult = Schema.Schema.Type<typeof CheckinHandleButtonResult>;

export const RoomOrderDispatchPayload = Schema.Struct({
  guildId: Schema.String,
  channelId: Schema.optional(Schema.String),
  channelName: Schema.optional(Schema.String),
  hour: Schema.optional(Schema.Number),
  healNeeded: Schema.optional(Schema.Number),
  interactionToken: Schema.optional(Schema.String),
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

export const RoomOrderButtonAction = Schema.Literals(["previous", "next", "send", "pinTentative"]);

export type RoomOrderButtonAction = Schema.Schema.Type<typeof RoomOrderButtonAction>;

export const RoomOrderHandleButtonPayload = Schema.Struct({
  guildId: Schema.String,
  messageId: Schema.String,
  messageChannelId: Schema.String,
  messageContent: Schema.NullOr(Schema.String),
  interactionToken: Schema.String,
  action: RoomOrderButtonAction,
});

export type RoomOrderHandleButtonPayload = Schema.Schema.Type<typeof RoomOrderHandleButtonPayload>;

export const RoomOrderHandleButtonResult = Schema.Struct({
  messageId: Schema.String,
  messageChannelId: Schema.String,
  action: RoomOrderButtonAction,
  status: Schema.Literals(["updated", "sent", "pinned", "partial", "denied"]),
  detail: Schema.NullOr(Schema.String),
});

export type RoomOrderHandleButtonResult = Schema.Schema.Type<typeof RoomOrderHandleButtonResult>;

const protectedRpc = <
  const Tag extends string,
  PayloadSchema extends Schema.Codec<unknown, unknown, never, never>,
  Success extends Schema.Codec<unknown, unknown, never, never>,
  Error extends Schema.Codec<unknown, unknown, never, never>,
>(
  tag: Tag,
  options: {
    readonly payload?: PayloadSchema;
    readonly success: Success;
    readonly error: Error;
  },
) =>
  Rpc.make(tag, {
    ...options,
    error: Schema.Union([options.error, Unauthorized]),
  }).middleware(SheetApisRpcAuthorization);

export const CalcRpcs = RpcGroup.make(
  protectedRpc("calc.calcBot", {
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
  protectedRpc("checkin.dispatch", {
    payload: Schema.Struct({
      payload: CheckinDispatchPayload,
    }),
    success: CheckinDispatchResult,
    error: CheckinDispatchError,
  }),
  protectedRpc("checkin.handleButton", {
    payload: Schema.Struct({
      payload: CheckinHandleButtonPayload,
    }),
    success: CheckinHandleButtonResult,
    error: CheckinHandleButtonError,
  }),
);

export const DiscordRpcs = RpcGroup.make(
  protectedRpc("discord.getCurrentUser", {
    success: DiscordUser,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("discord.getCurrentUserGuilds", {
    success: Schema.Array(DiscordGuild),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
);

export const GuildConfigRpcs = RpcGroup.make(
  protectedRpc("guildConfig.getAutoCheckinGuilds", {
    success: Schema.Array(GuildConfig),
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("guildConfig.getGuildConfig", {
    payload: Query({ guildId: Schema.String }),
    success: GuildConfig,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("guildConfig.upsertGuildConfig", {
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
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(GuildConfigMonitorRole),
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("guildConfig.getGuildChannels", {
    payload: Query({
      guildId: Schema.String,
      running: Schema.optional(Schema.Boolean),
    }),
    success: Schema.Array(GuildChannelConfig),
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("guildConfig.addGuildMonitorRole", {
    payload: Payload({ guildId: Schema.String, roleId: Schema.String }),
    success: GuildConfigMonitorRole,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.removeGuildMonitorRole", {
    payload: Payload({ guildId: Schema.String, roleId: Schema.String }),
    success: GuildConfigMonitorRole,
    error: Schema.Union([SchemaError, QueryResultError, MutatorResultError]),
  }),
  protectedRpc("guildConfig.upsertGuildChannelConfig", {
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
    payload: Query({
      guildId: Schema.String,
      channelId: Schema.String,
      running: Schema.optional(Schema.Boolean),
    }),
    success: GuildChannelConfig,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("guildConfig.getGuildChannelByName", {
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
  Rpc.make("health.ready", { success: HealthResponseSchema }),
);

export const MessageCheckinRpcs = RpcGroup.make(
  protectedRpc("messageCheckin.getMessageCheckinData", {
    payload: Query({ messageId: Schema.String }),
    success: MessageCheckin,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageCheckin.upsertMessageCheckinData", {
    payload: Payload({
      messageId: Schema.String,
      data: messageCheckinData,
    }),
    success: MessageCheckin,
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("messageCheckin.getMessageCheckinMembers", {
    payload: Query({ messageId: Schema.String }),
    success: Schema.Array(MessageCheckinMember),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageCheckin.addMessageCheckinMembers", {
    payload: Payload({
      messageId: Schema.String,
      memberIds: Schema.Array(Schema.String),
    }),
    success: Schema.Array(MessageCheckinMember),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageCheckin.persistMessageCheckin", {
    payload: Payload({
      messageId: Schema.String,
      data: messageCheckinData,
      memberIds: Schema.Array(Schema.String),
    }),
    success: MessageCheckin,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageCheckin.setMessageCheckinMemberCheckinAt", {
    payload: Payload({
      messageId: Schema.String,
      memberId: Schema.String,
      checkinAt: Schema.Number,
    }),
    success: MessageCheckinMember,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageCheckin.removeMessageCheckinMember", {
    payload: Payload({
      messageId: Schema.String,
      memberId: Schema.String,
    }),
    success: MessageCheckinMember,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
);

export const MessageRoomOrderRpcs = RpcGroup.make(
  protectedRpc("messageRoomOrder.getMessageRoomOrder", {
    payload: Query({ messageId: Schema.String }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.upsertMessageRoomOrder", {
    payload: Payload({
      messageId: Schema.String,
      data: messageRoomOrderData,
    }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("messageRoomOrder.persistMessageRoomOrder", {
    payload: Payload({
      messageId: Schema.String,
      data: messageRoomOrderData,
      entries: Schema.Array(messageRoomOrderEntryInput),
    }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError]),
  }),
  protectedRpc("messageRoomOrder.decrementMessageRoomOrderRank", {
    payload: Payload({ messageId: Schema.String }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.incrementMessageRoomOrderRank", {
    payload: Payload({ messageId: Schema.String }),
    success: MessageRoomOrder,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.getMessageRoomOrderEntry", {
    payload: Query({
      messageId: Schema.String,
      rank: Schema.Number,
    }),
    success: Schema.Array(MessageRoomOrderEntry),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.getMessageRoomOrderRange", {
    payload: Query({ messageId: Schema.String }),
    success: MessageRoomOrderRange,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.upsertMessageRoomOrderEntry", {
    payload: Payload({
      messageId: Schema.String,
      entries: Schema.Array(messageRoomOrderEntryInput),
    }),
    success: Schema.Array(MessageRoomOrderEntry),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageRoomOrder.removeMessageRoomOrderEntry", {
    payload: Payload({ messageId: Schema.String }),
    success: Schema.Array(MessageRoomOrderEntry),
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
);

export const MessageSlotRpcs = RpcGroup.make(
  protectedRpc("messageSlot.getMessageSlotData", {
    payload: Query({ messageId: Schema.String }),
    success: MessageSlot,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
  protectedRpc("messageSlot.upsertMessageSlotData", {
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
    payload: Query({ guildId: Schema.String, ids: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Schema.Union([Monitor, PartialIdMonitor]))),
    error: MonitorError,
  }),
  protectedRpc("monitor.getByNames", {
    payload: Query({ guildId: Schema.String, names: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Schema.Union([Monitor, PartialNameMonitor]))),
    error: MonitorError,
  }),
);

export const PermissionsRpcs = RpcGroup.make(
  protectedRpc("permissions.getCurrentUserPermissions", {
    payload: Query({ guildId: Schema.optional(Schema.String) }),
    success: CurrentUserPermissions,
    error: Schema.Union([SchemaError, QueryResultError, ArgumentError]),
  }),
);

export const PlayerRpcs = RpcGroup.make(
  protectedRpc("player.getPlayerMaps", {
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
    payload: Query({ guildId: Schema.String, ids: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Schema.Union([Player, PartialIdPlayer]))),
    error: PlayerError,
  }),
  protectedRpc("player.getByNames", {
    payload: Query({ guildId: Schema.String, names: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Schema.Union([Player, PartialNamePlayer]))),
    error: PlayerError,
  }),
  protectedRpc("player.getTeamsByIds", {
    payload: Query({ guildId: Schema.String, ids: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Team)),
    error: PlayerError,
  }),
  protectedRpc("player.getTeamsByNames", {
    payload: Query({ guildId: Schema.String, names: Schema.Array(Schema.String) }),
    success: Schema.Array(Schema.Array(Team)),
    error: PlayerError,
  }),
);

export const RoomOrderRpcs = RpcGroup.make(
  protectedRpc("roomOrder.generate", {
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
  protectedRpc("roomOrder.dispatch", {
    payload: Schema.Struct({
      payload: RoomOrderDispatchPayload,
    }),
    success: RoomOrderDispatchResult,
    error: RoomOrderDispatchError,
  }),
  protectedRpc("roomOrder.handleButton", {
    payload: Schema.Struct({
      payload: RoomOrderHandleButtonPayload,
    }),
    success: RoomOrderHandleButtonResult,
    error: RoomOrderHandleButtonError,
  }),
);

export const ScheduleRpcs = RpcGroup.make(
  protectedRpc("schedule.getAllPopulatedSchedules", {
    payload: Query({ guildId: Schema.String, view: ScheduleViewUrlParam }),
    success: PopulatedScheduleResponse,
    error: ScheduleError,
  }),
  protectedRpc("schedule.getDayPopulatedSchedules", {
    payload: Query({
      guildId: Schema.String,
      day: Schema.Number,
      view: ScheduleViewUrlParam,
    }),
    success: PopulatedScheduleResponse,
    error: ScheduleError,
  }),
  protectedRpc("schedule.getChannelPopulatedSchedules", {
    payload: Query({
      guildId: Schema.String,
      channel: Schema.String,
      view: ScheduleViewUrlParam,
    }),
    success: PopulatedScheduleResponse,
    error: ScheduleError,
  }),
  protectedRpc("schedule.getDayPlayerSchedule", {
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
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(RawPlayer),
    error: SheetError,
  }),
  protectedRpc("sheet.getMonitors", {
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(RawMonitor),
    error: SheetError,
  }),
  protectedRpc("sheet.getTeams", {
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(Team),
    error: SheetError,
  }),
  protectedRpc("sheet.getAllSchedules", {
    payload: Query({ guildId: Schema.String, view: ScheduleViewUrlParam }),
    success: ScheduleResponse,
    error: SheetError,
  }),
  protectedRpc("sheet.getDaySchedules", {
    payload: Query({
      guildId: Schema.String,
      day: Schema.Number,
      view: ScheduleViewUrlParam,
    }),
    success: ScheduleResponse,
    error: SheetError,
  }),
  protectedRpc("sheet.getChannelSchedules", {
    payload: Query({
      guildId: Schema.String,
      channel: Schema.String,
      view: ScheduleViewUrlParam,
    }),
    success: ScheduleResponse,
    error: SheetError,
  }),
  protectedRpc("sheet.getRangesConfig", {
    payload: Query({ guildId: Schema.String }),
    success: RangesConfig,
    error: SheetError,
  }),
  protectedRpc("sheet.getTeamConfig", {
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(TeamConfig),
    error: SheetError,
  }),
  protectedRpc("sheet.getEventConfig", {
    payload: Query({ guildId: Schema.String }),
    success: EventConfig,
    error: SheetError,
  }),
  protectedRpc("sheet.getScheduleConfig", {
    payload: Query({ guildId: Schema.String }),
    success: Schema.Array(ScheduleConfig),
    error: SheetError,
  }),
  protectedRpc("sheet.getRunnerConfig", {
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
);
