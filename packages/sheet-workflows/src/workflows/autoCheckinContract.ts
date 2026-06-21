import { Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";

const AutoCheckinConversationPayload = Schema.Struct({
  workspaceId: Schema.String,
  conversationName: Schema.String,
  hour: Schema.Number,
  eventStartEpochMs: Schema.Number,
});

export type AutoCheckinConversationPayload = Schema.Schema.Type<
  typeof AutoCheckinConversationPayload
>;

export const AutoCheckinConversationResult = Schema.Struct({
  workspaceId: Schema.String,
  conversationName: Schema.String,
  hour: Schema.Number,
  status: Schema.Literals(["sent", "skipped"]),
  checkinMessageId: Schema.NullOr(Schema.String),
  monitorMessageId: Schema.String,
  tentativeRoomOrderMessageId: Schema.NullOr(Schema.String),
});

export type AutoCheckinConversationResult = Schema.Schema.Type<
  typeof AutoCheckinConversationResult
>;

export const AutoCheckinConversationWorkflow = Workflow.make({
  name: "autoCheckin.conversation",
  payload: AutoCheckinConversationPayload,
  success: AutoCheckinConversationResult,
  error: Schema.Unknown,
  idempotencyKey: ({ workspaceId, conversationName, hour, eventStartEpochMs }) =>
    `auto-checkin:${workspaceId}:${eventStartEpochMs}:${hour}:${conversationName}`,
}).annotate(ClusterSchema.ShardGroup, () => "autoCheckin");
