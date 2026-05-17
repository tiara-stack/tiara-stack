import { pg, schema as effectSqlSchema } from "effect-sql-schema";
import { ReadonlyJSONValue } from "typhoon-zero/schema";

const createdAt = () =>
  pg.timestamp("created_at", { withTimezone: true }).defaultSql("now()").notNull();

const updatedAt = () =>
  pg.timestamp("updated_at", { withTimezone: true }).defaultSql("now()").notNull();

const deletedAt = () => pg.timestamp("deleted_at", { withTimezone: true });

interface ConfigGuild {}

const ConfigGuild = pg.Class<ConfigGuild>("ConfigGuild")({
  table: "config_guild",
  fields: {
    guildId: pg.varchar("guild_id").primaryKey(),
    sheetId: pg.varchar("sheet_id"),
    autoCheckin: pg.boolean("auto_checkin"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  indexes: [pg.index("config_guild_sheet_id_idx").on("sheetId")],
});

interface ConfigGuildManagerRole {}

const ConfigGuildManagerRole = pg.Class<ConfigGuildManagerRole>("ConfigGuildManagerRole")({
  table: "config_guild_manager_role",
  fields: {
    guildId: pg.varchar("guild_id").notNull(),
    roleId: pg.varchar("role_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["guildId", "roleId"],
});

interface ConfigGuildChannel {}

const ConfigGuildChannel = pg.Class<ConfigGuildChannel>("ConfigGuildChannel")({
  table: "config_guild_channel",
  fields: {
    guildId: pg.varchar("guild_id").notNull(),
    channelId: pg.varchar("channel_id").notNull(),
    name: pg.varchar("name"),
    running: pg.boolean("running"),
    roleId: pg.varchar("role_id"),
    checkinChannelId: pg.varchar("checkin_channel_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["guildId", "channelId"],
  indexes: [pg.uniqueIndex("config_guild_channel_guild_id_name_idx").on("guildId", "name")],
});

interface MessageSlot {}

const MessageSlot = pg.Class<MessageSlot>("MessageSlot")({
  table: "message_slot",
  fields: {
    messageId: pg.varchar("message_id").primaryKey(),
    day: pg.integer("day").notNull(),
    guildId: pg.varchar("guild_id"),
    messageChannelId: pg.varchar("message_channel_id"),
    createdByUserId: pg.varchar("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
});

interface MessageCheckin {}

const MessageCheckin = pg.Class<MessageCheckin>("MessageCheckin")({
  table: "message_checkin",
  fields: {
    messageId: pg.varchar("message_id").primaryKey(),
    initialMessage: pg.varchar("initial_message").notNull(),
    hour: pg.integer("hour").notNull(),
    channelId: pg.varchar("channel_id").notNull(),
    roleId: pg.varchar("role_id"),
    guildId: pg.varchar("guild_id"),
    messageChannelId: pg.varchar("message_channel_id"),
    createdByUserId: pg.varchar("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
});

interface MessageCheckinMember {}

const MessageCheckinMember = pg.Class<MessageCheckinMember>("MessageCheckinMember")({
  table: "message_checkin_member",
  fields: {
    messageId: pg.varchar("message_id").notNull(),
    memberId: pg.varchar("member_id").notNull(),
    checkinAt: pg.timestamp("checkin_at", { withTimezone: true }),
    checkinClaimId: pg.varchar("checkin_claim_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  primaryKey: ["messageId", "memberId"],
});

interface MessageRoomOrder {}

const MessageRoomOrder = pg.Class<MessageRoomOrder>("MessageRoomOrder")({
  table: "message_room_order",
  fields: {
    messageId: pg.varchar("message_id").primaryKey(),
    previousFills: pg.varchar("previous_fills").array().notNull(),
    fills: pg.varchar("fills").array().notNull(),
    hour: pg.integer("hour").notNull(),
    rank: pg.integer("rank").notNull(),
    tentative: pg.boolean("tentative").default(false).notNull(),
    monitor: pg.varchar("monitor"),
    guildId: pg.varchar("guild_id"),
    messageChannelId: pg.varchar("message_channel_id"),
    createdByUserId: pg.varchar("created_by_user_id"),
    sendClaimId: pg.varchar("send_claim_id"),
    sendClaimedAt: pg.timestamp("send_claimed_at", { withTimezone: true }),
    sentMessageId: pg.varchar("sent_message_id"),
    sentMessageChannelId: pg.varchar("sent_message_channel_id"),
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
});

interface MessageRoomOrderEntry {}

const MessageRoomOrderEntry = pg.Class<MessageRoomOrderEntry>("MessageRoomOrderEntry")({
  table: "message_room_order_entry",
  fields: {
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
  primaryKey: ["messageId", "rank", "position"],
  indexes: [pg.index("message_room_order_entry_message_id_rank_idx").on("messageId", "rank")],
});

interface SheetApisDispatchJobs {}

const SheetApisDispatchJobs = pg.Class<SheetApisDispatchJobs>("SheetApisDispatchJobs")({
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
});

export const configGuild = ConfigGuild;
export const configGuildManagerRole = ConfigGuildManagerRole;
export const configGuildChannel = ConfigGuildChannel;
export const messageSlot = MessageSlot;
export const messageCheckin = MessageCheckin;
export const messageCheckinMember = MessageCheckinMember;
export const messageRoomOrder = MessageRoomOrder;
export const messageRoomOrderEntry = MessageRoomOrderEntry;
export const sheetApisDispatchJobs = SheetApisDispatchJobs;

export const schema = effectSqlSchema({
  configGuild,
  configGuildManagerRole,
  configGuildChannel,
  messageSlot,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  sheetApisDispatchJobs,
});
