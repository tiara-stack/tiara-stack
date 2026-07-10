import { Schema } from "effect";
import { AuditTimestampFields } from "../auditTimestamps";

export class WorkspaceUpdateAnnouncementDelivery extends Schema.TaggedClass<WorkspaceUpdateAnnouncementDelivery>()(
  "WorkspaceUpdateAnnouncementDelivery",
  {
    workspaceId: Schema.String,
    announcementId: Schema.String,
    publishedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
    deliveredAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
    conversationId: Schema.String,
    messageId: Schema.String,
    ...AuditTimestampFields,
  },
) {}

export const WorkspaceUpdateAnnouncementDeliveryClaimResult = Schema.Struct({
  status: Schema.Literals(["claimed", "already_claimed", "already_delivered"]),
  delivery: Schema.Option(WorkspaceUpdateAnnouncementDelivery),
});

export type WorkspaceUpdateAnnouncementDeliveryClaimResult =
  typeof WorkspaceUpdateAnnouncementDeliveryClaimResult.Type;
