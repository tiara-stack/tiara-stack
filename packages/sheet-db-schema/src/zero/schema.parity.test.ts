import { describe, expect, it } from "vitest";
import { schema } from "./schema";

type ColumnSpec = readonly [
  field: string,
  type: "string" | "number" | "boolean" | "json",
  optional: boolean,
  serverName?: string,
];

const columns = (specs: readonly ColumnSpec[]) =>
  Object.fromEntries(
    specs.map(([field, type, optional, serverName]) => [
      field,
      serverName === undefined ? { type, optional } : { type, optional, serverName },
    ]),
  );

const table = (
  name: string,
  serverName: string,
  primaryKey: readonly string[],
  columnSpecs: readonly ColumnSpec[],
) => ({
  name,
  columns: columns(columnSpecs),
  primaryKey,
  serverName,
});

const auditColumns = [
  ["createdAt", "number", false, "created_at"],
  ["updatedAt", "number", false, "updated_at"],
  ["deletedAt", "number", true, "deleted_at"],
] as const satisfies readonly ColumnSpec[];

const sheetDb = (serverName: string) => `sheet_db_${serverName}`;

const normalizeSchema = (input: typeof schema) => ({
  tables: Object.fromEntries(
    Object.entries(input.tables).map(([tableName, table]) => [
      tableName,
      {
        name: table.name,
        columns: Object.fromEntries(
          Object.entries(table.columns).map(([columnName, column]) => [
            columnName,
            {
              type: column.type,
              optional: column.optional,
              ...("serverName" in column ? { serverName: column.serverName } : {}),
            },
          ]),
        ),
        primaryKey: table.primaryKey,
        serverName: table.serverName,
      },
    ]),
  ),
  relationships: input.relationships,
  enableLegacyQueries: input.enableLegacyQueries,
  enableLegacyMutators: input.enableLegacyMutators,
});

const expectedSchema = {
  tables: {
    configGuild: table(
      "configGuild",
      sheetDb("config_guild"),
      ["guildId"],
      [
        ["guildId", "string", false, "guild_id"],
        ["sheetId", "string", true, "sheet_id"],
        ["autoCheckin", "boolean", true, "auto_checkin"],
        ...auditColumns,
      ],
    ),
    configGuildChannel: table(
      "configGuildChannel",
      sheetDb("config_guild_channel"),
      ["guildId", "channelId"],
      [
        ["guildId", "string", false, "guild_id"],
        ["channelId", "string", false, "channel_id"],
        ["name", "string", true],
        ["running", "boolean", true],
        ["roleId", "string", true, "role_id"],
        ["checkinChannelId", "string", true, "checkin_channel_id"],
        ...auditColumns,
      ],
    ),
    configGuildFeatureFlag: table(
      "configGuildFeatureFlag",
      sheetDb("config_guild_feature_flag"),
      ["guildId", "flagName"],
      [
        ["guildId", "string", false, "guild_id"],
        ["flagName", "string", false, "flag_name"],
        ...auditColumns,
      ],
    ),
    configGuildManagerRole: table(
      "configGuildManagerRole",
      sheetDb("config_guild_manager_role"),
      ["guildId", "roleId"],
      [
        ["guildId", "string", false, "guild_id"],
        ["roleId", "string", false, "role_id"],
        ...auditColumns,
      ],
    ),
    messageCheckin: table(
      "messageCheckin",
      sheetDb("message_checkin"),
      ["messageId"],
      [
        ["messageId", "string", false, "message_id"],
        ["initialMessage", "string", false, "initial_message"],
        ["hour", "number", false],
        ["channelId", "string", false, "channel_id"],
        ["roleId", "string", true, "role_id"],
        ["guildId", "string", true, "guild_id"],
        ["messageChannelId", "string", true, "message_channel_id"],
        ["createdByUserId", "string", true, "created_by_user_id"],
        ...auditColumns,
      ],
    ),
    messageCheckinMember: table(
      "messageCheckinMember",
      sheetDb("message_checkin_member"),
      ["messageId", "memberId"],
      [
        ["messageId", "string", false, "message_id"],
        ["memberId", "string", false, "member_id"],
        ["checkinAt", "number", true, "checkin_at"],
        ["checkinClaimId", "string", true, "checkin_claim_id"],
        ...auditColumns,
      ],
    ),
    messageRoomOrder: table(
      "messageRoomOrder",
      sheetDb("message_room_order"),
      ["messageId"],
      [
        ["messageId", "string", false, "message_id"],
        ["previousFills", "json", false, "previous_fills"],
        ["fills", "json", false],
        ["hour", "number", false],
        ["rank", "number", false],
        ["tentative", "boolean", false],
        ["monitor", "string", true],
        ["guildId", "string", true, "guild_id"],
        ["messageChannelId", "string", true, "message_channel_id"],
        ["createdByUserId", "string", true, "created_by_user_id"],
        ["sendClaimId", "string", true, "send_claim_id"],
        ["sendClaimedAt", "number", true, "send_claimed_at"],
        ["sentMessageId", "string", true, "sent_message_id"],
        ["sentMessageChannelId", "string", true, "sent_message_channel_id"],
        ["sentAt", "number", true, "sent_at"],
        ["tentativeUpdateClaimId", "string", true, "tentative_update_claim_id"],
        ["tentativeUpdateClaimedAt", "number", true, "tentative_update_claimed_at"],
        ["tentativePinClaimId", "string", true, "tentative_pin_claim_id"],
        ["tentativePinClaimedAt", "number", true, "tentative_pin_claimed_at"],
        ["tentativePinnedAt", "number", true, "tentative_pinned_at"],
        ...auditColumns,
      ],
    ),
    messageRoomOrderEntry: table(
      "messageRoomOrderEntry",
      sheetDb("message_room_order_entry"),
      ["messageId", "rank", "position"],
      [
        ["messageId", "string", false, "message_id"],
        ["rank", "number", false],
        ["position", "number", false],
        ["hour", "number", false],
        ["team", "string", false],
        ["tags", "json", false],
        ["effectValue", "number", false, "effect_value"],
        ...auditColumns,
      ],
    ),
    messageSlot: table(
      "messageSlot",
      sheetDb("message_slot"),
      ["messageId"],
      [
        ["messageId", "string", false, "message_id"],
        ["day", "number", false],
        ["guildId", "string", true, "guild_id"],
        ["messageChannelId", "string", true, "message_channel_id"],
        ["createdByUserId", "string", true, "created_by_user_id"],
        ...auditColumns,
      ],
    ),
    sheetApisDispatchJobs: table(
      "sheetApisDispatchJobs",
      sheetDb("sheet_apis_dispatch_jobs"),
      ["dispatchRequestId"],
      [
        ["dispatchRequestId", "string", false, "dispatch_request_id"],
        ["entityType", "string", false, "entity_type"],
        ["entityId", "string", false, "entity_id"],
        ["operation", "string", false],
        ["status", "string", false],
        ["runId", "string", true, "run_id"],
        ["payload", "json", false],
        ["result", "json", true],
        ["error", "json", true],
        ...auditColumns,
      ],
    ),
  },
  relationships: {},
  enableLegacyQueries: false,
  enableLegacyMutators: false,
};

describe("generated Zero schema parity", () => {
  it("matches the previous drizzle-zero runtime schema behavior", () => {
    expect(normalizeSchema(schema)).toEqual(expectedSchema);
  });
});
