import { Schema } from "effect";
import { BotOutboundMessage, ConversationRef, MessageRef, SendMessageReceipt } from "sheet-bot-api";
import {
  CheckinsTestAuto,
  CheckinsTestAutoConversationResult,
  InteractiveDeclaredFailure,
} from "sheet-workflow-contracts";
import { workflowContractExecutionSchema } from "../shared/execution";

export const AutoCheckinTestExecution = workflowContractExecutionSchema(CheckinsTestAuto);

export const AutoCheckinTestDiscovery = Schema.Struct({
  conversationNames: Schema.Array(Schema.String),
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
});

const AutoCheckinTestPreview = Schema.Struct({
  conversation: ConversationRef,
  message: BotOutboundMessage,
});
export type AutoCheckinTestPreview = typeof AutoCheckinTestPreview.Type;

export const AutoCheckinTestPreparation = Schema.Struct({
  conversationName: Schema.String,
  runningConversationId: Schema.String,
  checkinConversationId: Schema.String,
  hour: Schema.Number,
  status: Schema.Literals(["sent", "skipped"]),
  checkinPreview: Schema.NullOr(AutoCheckinTestPreview),
  monitorPreview: AutoCheckinTestPreview,
  tentativeRoomOrderPreview: Schema.NullOr(AutoCheckinTestPreview),
  error: Schema.NullOr(Schema.String),
});
export type AutoCheckinTestPreparation = typeof AutoCheckinTestPreparation.Type;

export const AutoCheckinTestPreviewDeliveryOutcome = Schema.Union([
  // Replay compatibility for v1 actions completed before tagged outcomes were introduced.
  // New delivery operations emit only Committed or Unknown.
  SendMessageReceipt,
  Schema.TaggedStruct("Committed", { receipt: SendMessageReceipt }),
  Schema.TaggedStruct("Unknown", { failure: InteractiveDeclaredFailure }),
]);
export type AutoCheckinTestPreviewDeliveryOutcome =
  typeof AutoCheckinTestPreviewDeliveryOutcome.Type;

export const AutoCheckinTestAnchorExecution = Schema.Struct({
  ...AutoCheckinTestExecution.fields,
  anchor: MessageRef,
});

export const AutoCheckinTestTargetExecution = Schema.Struct({
  ...AutoCheckinTestAnchorExecution.fields,
  conversationName: Schema.String,
});

export const AutoCheckinTestPreparedExecution = Schema.Struct({
  ...AutoCheckinTestTargetExecution.fields,
  preparation: AutoCheckinTestPreparation,
});

const AutoCheckinTestSummaryExecutionFields = {
  ...AutoCheckinTestAnchorExecution.fields,
  conversations: Schema.Array(CheckinsTestAutoConversationResult),
};

export const AutoCheckinTestCurrentSummaryExecution = Schema.Struct({
  ...AutoCheckinTestSummaryExecutionFields,
  previewMayHaveCommitted: Schema.Boolean,
});

export const AutoCheckinTestSummaryExecution = Schema.Struct({
  ...AutoCheckinTestSummaryExecutionFields,
  previewMayHaveCommitted: Schema.optional(Schema.Boolean),
  // Replay compatibility for v1 summary actions created with the former field name.
  // New workflow executions populate previewMayHaveCommitted instead.
  previewCommitted: Schema.optional(Schema.Boolean),
});
