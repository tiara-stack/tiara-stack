import { Schema } from "effect";
import {
  BotOutboundMessage,
  MessageRef,
  SendMessageReceipt,
  SetMessagePinnedReceipt,
} from "sheet-bot-api";
import { RoomOrdersSend } from "sheet-workflow-contracts";
import { AuthorizedRoomOrderSendContext } from "../readOnly/authorization";
import { workflowContractExecutionSchema } from "../shared/execution";

export const RoomOrderSendExecution = workflowContractExecutionSchema(RoomOrdersSend);

export const RoomOrderSendClaim = Schema.Struct({
  context: AuthorizedRoomOrderSendContext,
  claimId: Schema.String,
  status: Schema.Literals(["claimed", "already-sent", "denied"]),
  detail: Schema.NullOr(Schema.String),
});

export const RoomOrderSendView = Schema.Struct({
  context: AuthorizedRoomOrderSendContext,
  claimId: Schema.String,
  message: BotOutboundMessage,
});

export const RoomOrderSendCommit = Schema.Struct({
  context: AuthorizedRoomOrderSendContext,
  claimId: Schema.String,
  source: Schema.Literals(["sent", "already-sent"]),
  sentMessage: MessageRef,
  sendReceipt: Schema.NullOr(SendMessageReceipt),
});

export const RoomOrderSendRecordDisposition = Schema.Struct({
  commit: RoomOrderSendCommit,
  status: Schema.Literals(["tracked", "not-required", "recovery-required", "inconsistent"]),
  detail: Schema.NullOr(Schema.String),
});

export const RoomOrderSendPinDisposition = Schema.Struct({
  commit: RoomOrderSendCommit,
  status: Schema.Literals(["pinned", "rejected"]),
  receipt: Schema.NullOr(SetMessagePinnedReceipt),
});

// The same-named exported type below is the consumer-facing shape of this runtime schema.
// fallow-ignore-next-line unused-export
export const RoomOrderSendResponse = Schema.Struct({
  context: AuthorizedRoomOrderSendContext,
  commit: Schema.NullOr(RoomOrderSendCommit),
  sourceMessageId: Schema.String,
  sourceConversationId: Schema.String,
  resultMessageId: Schema.String,
  resultConversationId: Schema.String,
  status: Schema.Literals(["pinned", "partial", "denied"]),
  detail: Schema.String,
  message: BotOutboundMessage,
});

export const RoomOrderSendClaimExecution = Schema.Struct({
  ...RoomOrderSendExecution.fields,
  claim: RoomOrderSendClaim,
});

export const RoomOrderSendViewExecution = Schema.Struct({
  ...RoomOrderSendExecution.fields,
  view: RoomOrderSendView,
});

export const RoomOrderSendCommitExecution = Schema.Struct({
  ...RoomOrderSendExecution.fields,
  commit: RoomOrderSendCommit,
});

export const RoomOrderSendResponseExecution = Schema.Struct({
  ...RoomOrderSendExecution.fields,
  response: RoomOrderSendResponse,
});

export const RoomOrderSendReleaseExecution = RoomOrderSendClaimExecution;

export type RoomOrderSendClaim = typeof RoomOrderSendClaim.Type;
export type RoomOrderSendView = typeof RoomOrderSendView.Type;
export type RoomOrderSendCommit = typeof RoomOrderSendCommit.Type;
export type RoomOrderSendResponse = typeof RoomOrderSendResponse.Type;
export type RoomOrderSendRecordDisposition = typeof RoomOrderSendRecordDisposition.Type;
export type RoomOrderSendPinDisposition = typeof RoomOrderSendPinDisposition.Type;
