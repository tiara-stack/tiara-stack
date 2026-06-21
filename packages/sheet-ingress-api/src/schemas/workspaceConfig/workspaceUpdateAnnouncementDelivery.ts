import { Schema } from "effect";
import { configWorkspaceUpdateAnnouncementDelivery } from "sheet-db-schema/models";
import type { DateTimeOptionField, StringField } from "../model";
import { modelTaggedFields, validateTaggedFields } from "../model";

const WorkspaceUpdateAnnouncementDeliveryFields = validateTaggedFields<{
  readonly workspaceId: StringField;
  readonly announcementId: StringField;
  readonly publishedAt: DateTimeOptionField;
  readonly deliveredAt: DateTimeOptionField;
  readonly conversationId: StringField;
  readonly messageId: StringField;
  readonly createdAt: DateTimeOptionField;
  readonly updatedAt: DateTimeOptionField;
  readonly deletedAt: DateTimeOptionField;
}>(modelTaggedFields(configWorkspaceUpdateAnnouncementDelivery), [
  "workspaceId",
  "announcementId",
  "publishedAt",
  "deliveredAt",
  "conversationId",
  "messageId",
  "createdAt",
  "updatedAt",
  "deletedAt",
] as const);

export class WorkspaceUpdateAnnouncementDelivery extends Schema.TaggedClass<WorkspaceUpdateAnnouncementDelivery>()(
  "WorkspaceUpdateAnnouncementDelivery",
  WorkspaceUpdateAnnouncementDeliveryFields,
) {}

export const WorkspaceUpdateAnnouncementDeliveryClaimResult = Schema.Struct({
  status: Schema.Literals(["claimed", "already_claimed", "already_delivered"]),
  delivery: Schema.Option(WorkspaceUpdateAnnouncementDelivery),
});

export type WorkspaceUpdateAnnouncementDeliveryClaimResult =
  typeof WorkspaceUpdateAnnouncementDeliveryClaimResult.Type;
