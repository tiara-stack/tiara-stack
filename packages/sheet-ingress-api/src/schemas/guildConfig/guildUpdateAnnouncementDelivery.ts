import { Schema } from "effect";
import { configGuildUpdateAnnouncementDelivery } from "sheet-db-schema/models";
import type { DateTimeOptionField, StringField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const GuildUpdateAnnouncementDeliveryFields = validateTaggedFields<{
  readonly guildId: StringField;
  readonly announcementId: StringField;
  readonly publishedAt: DateTimeOptionField;
  readonly deliveredAt: DateTimeOptionField;
  readonly channelId: StringField;
  readonly messageId: StringField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configGuildUpdateAnnouncementDelivery), [
  "guildId",
  "announcementId",
  "publishedAt",
  "deliveredAt",
  "channelId",
  "messageId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class GuildUpdateAnnouncementDelivery extends Schema.TaggedClass<GuildUpdateAnnouncementDelivery>()(
  "GuildUpdateAnnouncementDelivery",
  GuildUpdateAnnouncementDeliveryFields,
) {}

export const GuildUpdateAnnouncementDeliveryClaimResult = Schema.Struct({
  status: Schema.Literals(["claimed", "already_claimed", "already_delivered"]),
  delivery: Schema.Option(GuildUpdateAnnouncementDelivery),
});

export type GuildUpdateAnnouncementDeliveryClaimResult =
  typeof GuildUpdateAnnouncementDeliveryClaimResult.Type;
