import { schema as effectSqlSchema } from "effect-sql-schema";
import type { EffectSqlTable } from "effect-sql-schema";
import {
  configGuild as internalConfigGuild,
  configGuildChannel as internalConfigGuildChannel,
  configGuildFeatureFlag as internalConfigGuildFeatureFlag,
  configGuildManagerRole as internalConfigGuildManagerRole,
  configGuildUpdateAnnouncementDelivery as internalConfigGuildUpdateAnnouncementDelivery,
  messageCheckin as internalMessageCheckin,
  messageCheckinMember as internalMessageCheckinMember,
  messageRoomOrder as internalMessageRoomOrder,
  messageRoomOrderEntry as internalMessageRoomOrderEntry,
  messageSlot as internalMessageSlot,
  sheetApisDispatchJobs as internalSheetApisDispatchJobs,
} from "./schema.internal";

type PgTable = EffectSqlTable<"postgresql">;

// Compatibility exports keep the historical widened table type. Prefer
// sheet-db-schema/models when model variant types are needed.
export const configGuild = internalConfigGuild as unknown as PgTable;
export const configGuildManagerRole = internalConfigGuildManagerRole as unknown as PgTable;
export const configGuildFeatureFlag = internalConfigGuildFeatureFlag as unknown as PgTable;
export const configGuildUpdateAnnouncementDelivery =
  internalConfigGuildUpdateAnnouncementDelivery as unknown as PgTable;
export const configGuildChannel = internalConfigGuildChannel as unknown as PgTable;
export const messageSlot = internalMessageSlot as unknown as PgTable;
export const messageCheckin = internalMessageCheckin as unknown as PgTable;
export const messageCheckinMember = internalMessageCheckinMember as unknown as PgTable;
export const messageRoomOrder = internalMessageRoomOrder as unknown as PgTable;
export const messageRoomOrderEntry = internalMessageRoomOrderEntry as unknown as PgTable;
export const sheetApisDispatchJobs = internalSheetApisDispatchJobs as unknown as PgTable;

export const schema = effectSqlSchema({
  configGuild,
  configGuildManagerRole,
  configGuildFeatureFlag,
  configGuildUpdateAnnouncementDelivery,
  configGuildChannel,
  messageSlot,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  sheetApisDispatchJobs,
});
