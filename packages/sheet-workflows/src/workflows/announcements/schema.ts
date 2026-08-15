import { Schema } from "effect";
import { ConversationRef, MessageRef, SendMessageReceipt } from "sheet-bot-api";
import { AnnouncementsDeliverUpdate } from "sheet-workflow-contracts";
import { WorkspaceId } from "sheet-workflow-contracts/values";
import { workflowContractExecutionSchema } from "../shared/execution";

export const UpdateAnnouncementExecution = workflowContractExecutionSchema(
  AnnouncementsDeliverUpdate,
);

export const UpdateAnnouncementClaim = Schema.Struct({
  workspaceId: WorkspaceId,
  announcementId: Schema.String,
  publishedAt: Schema.Number,
  claimId: Schema.String,
  status: Schema.Literals([
    "owned",
    "skipped_not_gated",
    "skipped_already_claimed",
    "skipped_already_delivered",
  ]),
  delivery: Schema.NullOr(MessageRef),
});

export const UpdateAnnouncementCommit = Schema.Struct({
  claim: UpdateAnnouncementClaim,
  conversation: ConversationRef,
  receipt: SendMessageReceipt,
  deliveredAt: Schema.Number,
});

export const UpdateAnnouncementRecordDisposition = Schema.Struct({
  commit: UpdateAnnouncementCommit,
  status: Schema.Literal("tracked"),
});

export const UpdateAnnouncementClaimExecution = Schema.Struct({
  ...UpdateAnnouncementExecution.fields,
  claim: UpdateAnnouncementClaim,
});

export const UpdateAnnouncementDeliveryExecution = Schema.Struct({
  ...UpdateAnnouncementClaimExecution.fields,
  conversation: ConversationRef,
});

export const UpdateAnnouncementCommitExecution = Schema.Struct({
  ...UpdateAnnouncementExecution.fields,
  commit: UpdateAnnouncementCommit,
});

export type UpdateAnnouncementClaim = typeof UpdateAnnouncementClaim.Type;
export type UpdateAnnouncementCommit = typeof UpdateAnnouncementCommit.Type;
export type UpdateAnnouncementRecordDisposition = typeof UpdateAnnouncementRecordDisposition.Type;
