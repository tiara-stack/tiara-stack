import { schema as effectSqlSchema } from "effect-sql-schema";
import type { EffectSqlTable } from "effect-sql-schema";
import {
  configUserPlatform as internalConfigUserPlatform,
  configWorkspace as internalConfigWorkspace,
  configWorkspaceConversation as internalConfigWorkspaceConversation,
  configWorkspaceFeatureFlag as internalConfigWorkspaceFeatureFlag,
  configWorkspaceMonitorRole as internalConfigWorkspaceMonitorRole,
  configWorkspaceUpdateAnnouncementDelivery as internalConfigWorkspaceUpdateAnnouncementDelivery,
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
export const configWorkspace = internalConfigWorkspace as unknown as PgTable;
export const configWorkspaceMonitorRole = internalConfigWorkspaceMonitorRole as unknown as PgTable;
export const configWorkspaceFeatureFlag = internalConfigWorkspaceFeatureFlag as unknown as PgTable;
export const configWorkspaceUpdateAnnouncementDelivery =
  internalConfigWorkspaceUpdateAnnouncementDelivery as unknown as PgTable;
export const configUserPlatform = internalConfigUserPlatform as unknown as PgTable;
export const configWorkspaceConversation =
  internalConfigWorkspaceConversation as unknown as PgTable;
export const messageSlot = internalMessageSlot as unknown as PgTable;
export const messageCheckin = internalMessageCheckin as unknown as PgTable;
export const messageCheckinMember = internalMessageCheckinMember as unknown as PgTable;
export const messageRoomOrder = internalMessageRoomOrder as unknown as PgTable;
export const messageRoomOrderEntry = internalMessageRoomOrderEntry as unknown as PgTable;
export const sheetApisDispatchJobs = internalSheetApisDispatchJobs as unknown as PgTable;

export const schema = effectSqlSchema({
  configWorkspace,
  configWorkspaceMonitorRole,
  configWorkspaceFeatureFlag,
  configWorkspaceUpdateAnnouncementDelivery,
  configUserPlatform,
  configWorkspaceConversation,
  messageSlot,
  messageCheckin,
  messageCheckinMember,
  messageRoomOrder,
  messageRoomOrderEntry,
  sheetApisDispatchJobs,
});
