import { Schema } from "effect";
import { NotificationClient as WorkflowNotificationClient } from "sheet-workflow-contracts/values";
import { AuditTimestampFields } from "../auditTimestamps";
import { ClientPlatform } from "../client/clientRefs";

export class UserPlatformConfig extends Schema.TaggedClass<UserPlatformConfig>()(
  "UserPlatformConfig",
  {
    platform: Schema.String,
    userId: Schema.String,
    defaultClientId: Schema.OptionFromNullOr(Schema.String),
    checkinDmEnabled: Schema.Boolean,
    monitorDmEnabled: Schema.Boolean,
    ...AuditTimestampFields,
  },
) {}

// Temporary gateway-era compatibility name. New consumers import NotificationClient directly.
export const SupportedNotificationClient = WorkflowNotificationClient;

export type SupportedNotificationClient = typeof SupportedNotificationClient.Type;

export const CheckinDmRecipient = Schema.Struct({
  platform: ClientPlatform,
  userId: Schema.String,
  defaultClientId: Schema.String,
});

export type CheckinDmRecipient = typeof CheckinDmRecipient.Type;

export const MonitorDmRecipient = Schema.Struct({
  platform: ClientPlatform,
  userId: Schema.String,
  defaultClientId: Schema.String,
});

export type MonitorDmRecipient = typeof MonitorDmRecipient.Type;
