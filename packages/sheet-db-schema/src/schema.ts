import { schema as effectSqlSchema } from "effect-sql-schema";
import type { EffectSqlTable } from "effect-sql-schema";
import {
  configGuild as internalConfigGuild,
  configGuildChannel as internalConfigGuildChannel,
  configGuildManagerRole as internalConfigGuildManagerRole,
  messageCheckin as internalMessageCheckin,
  messageCheckinMember as internalMessageCheckinMember,
  messageRoomOrder as internalMessageRoomOrder,
  messageRoomOrderEntry as internalMessageRoomOrderEntry,
  messageSlot as internalMessageSlot,
  sheetApisDispatchJobs as internalSheetApisDispatchJobs,
} from "./schema.internal";

type PgTable = EffectSqlTable<"postgresql">;

export const configGuild: PgTable = internalConfigGuild;
export const configGuildManagerRole: PgTable = internalConfigGuildManagerRole;
export const configGuildChannel: PgTable = internalConfigGuildChannel;
export const messageSlot: PgTable = internalMessageSlot;
export const messageCheckin: PgTable = internalMessageCheckin;
export const messageCheckinMember: PgTable = internalMessageCheckinMember;
export const messageRoomOrder: PgTable = internalMessageRoomOrder;
export const messageRoomOrderEntry: PgTable = internalMessageRoomOrderEntry;
export const sheetApisDispatchJobs: PgTable = internalSheetApisDispatchJobs;

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
