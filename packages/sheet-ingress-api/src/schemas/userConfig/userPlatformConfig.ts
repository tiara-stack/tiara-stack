import { Schema } from "effect";
import { configUserPlatform } from "sheet-db-schema/models";
import { ClientPlatform } from "../client/clientRefs";
import type { BooleanField, DateTimeOptionField, StringField, StringOptionField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const UserPlatformConfigFields = validateTaggedFields<{
  readonly platform: StringField;
  readonly userId: StringField;
  readonly defaultClientId: StringOptionField;
  readonly checkinDmEnabled: BooleanField;
  readonly monitorDmEnabled: BooleanField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configUserPlatform), [
  "platform",
  "userId",
  "defaultClientId",
  "checkinDmEnabled",
  "monitorDmEnabled",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class UserPlatformConfig extends Schema.TaggedClass<UserPlatformConfig>()(
  "UserPlatformConfig",
  UserPlatformConfigFields,
) {}

export const SupportedNotificationClient = Schema.Struct({
  platform: ClientPlatform,
  clientId: Schema.String,
});

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
