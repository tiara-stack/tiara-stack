import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const configGuild = pgTable(
  "config_guild",
  {
    guildId: varchar("guild_id").primaryKey(),
    sheetId: varchar("sheet_id"),
    autoCheckin: boolean("auto_checkin"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [index("config_guild_sheet_id_idx").on(table.sheetId)],
);

export const configGuildManagerRole = pgTable(
  "config_guild_manager_role",
  {
    guildId: varchar("guild_id").notNull(),
    roleId: varchar("role_id").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.roleId] })],
);

export const configGuildChannel = pgTable(
  "config_guild_channel",
  {
    guildId: varchar("guild_id").notNull(),
    channelId: varchar("channel_id").notNull(),
    name: varchar("name"),
    running: boolean("running"),
    roleId: varchar("role_id"),
    checkinChannelId: varchar("checkin_channel_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.channelId] }),
    uniqueIndex("config_guild_channel_guild_id_name_idx").on(table.guildId, table.name),
  ],
);

export const messageSlot = pgTable("message_slot", {
  messageId: varchar("message_id").primaryKey(),
  day: integer("day").notNull(),
  guildId: varchar("guild_id"),
  messageChannelId: varchar("message_channel_id"),
  createdByUserId: varchar("created_by_user_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
});

export const messageCheckin = pgTable("message_checkin", {
  messageId: varchar("message_id").primaryKey(),
  initialMessage: varchar("initial_message").notNull(),
  hour: integer("hour").notNull(),
  channelId: varchar("channel_id").notNull(),
  roleId: varchar("role_id"),
  guildId: varchar("guild_id"),
  messageChannelId: varchar("message_channel_id"),
  createdByUserId: varchar("created_by_user_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
});

export const messageCheckinMember = pgTable(
  "message_checkin_member",
  {
    messageId: varchar("message_id").notNull(),
    memberId: varchar("member_id").notNull(),
    checkinAt: timestamp("checkin_at", { mode: "date", withTimezone: true }),
    checkinClaimId: varchar("checkin_claim_id"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.messageId, table.memberId] })],
);

export const messageRoomOrder = pgTable("message_room_order", {
  messageId: varchar("message_id").primaryKey(),
  previousFills: varchar("previous_fills").array().notNull(),
  fills: varchar("fills").array().notNull(),
  hour: integer("hour").notNull(),
  rank: integer("rank").notNull(),
  tentative: boolean("tentative").default(false).notNull(),
  monitor: varchar("monitor"),
  guildId: varchar("guild_id"),
  messageChannelId: varchar("message_channel_id"),
  createdByUserId: varchar("created_by_user_id"),
  sendClaimId: varchar("send_claim_id"),
  sendClaimedAt: timestamp("send_claimed_at", { mode: "date", withTimezone: true }),
  sentMessageId: varchar("sent_message_id"),
  sentMessageChannelId: varchar("sent_message_channel_id"),
  sentAt: timestamp("sent_at", { mode: "date", withTimezone: true }),
  tentativeUpdateClaimId: varchar("tentative_update_claim_id"),
  tentativeUpdateClaimedAt: timestamp("tentative_update_claimed_at", {
    mode: "date",
    withTimezone: true,
  }),
  tentativePinClaimId: varchar("tentative_pin_claim_id"),
  tentativePinClaimedAt: timestamp("tentative_pin_claimed_at", {
    mode: "date",
    withTimezone: true,
  }),
  tentativePinnedAt: timestamp("tentative_pinned_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
});

export const messageRoomOrderEntry = pgTable(
  "message_room_order_entry",
  {
    messageId: varchar("message_id").notNull(),
    rank: integer("rank").notNull(),
    position: integer("position").notNull(),
    hour: integer("hour").notNull(),
    team: varchar("team").notNull(),
    tags: varchar("tags").array().notNull(),
    effectValue: real("effect_value").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.rank, table.position] }),
    index("message_room_order_entry_message_id_rank_idx").on(table.messageId, table.rank),
  ],
);

export const sheetApisDispatchJobs = pgTable(
  "sheet_apis_dispatch_jobs",
  {
    dispatchRequestId: text("dispatch_request_id").primaryKey(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    operation: text("operation").notNull(),
    status: text("status").notNull(),
    runId: text("run_id"),
    payload: jsonb("payload").notNull(),
    result: jsonb("result"),
    error: jsonb("error"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    index("sheet_apis_dispatch_jobs_status_updated_at_idx").on(table.status, table.updatedAt),
  ],
);
