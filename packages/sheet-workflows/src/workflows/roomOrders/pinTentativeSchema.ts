import { Schema } from "effect";
import { BotOutboundMessage, SetMessagePinnedReceipt } from "sheet-bot-api";
import { RoomOrdersPinTentative } from "sheet-workflow-contracts";
import { AuthorizedRoomOrderPinTentativeContext } from "../readOnly/authorization";
import { workflowContractExecutionSchema } from "../shared/execution";

export const RoomOrderTentativePinExecution =
  workflowContractExecutionSchema(RoomOrdersPinTentative);

export const RoomOrderTentativePinClaim = Schema.Struct({
  context: AuthorizedRoomOrderPinTentativeContext,
  claimId: Schema.String,
  status: Schema.Literals(["claimed", "already-pinned", "denied"]),
  detail: Schema.NullOr(Schema.String),
});

export const RoomOrderTentativePinView = Schema.Struct({
  context: AuthorizedRoomOrderPinTentativeContext,
  claimId: Schema.String,
  message: BotOutboundMessage,
});

export const RoomOrderTentativePinAttempt = Schema.Struct({
  view: RoomOrderTentativePinView,
  status: Schema.Literals(["pinned", "rejected"]),
  pinnedAt: Schema.NullOr(Schema.Number),
  receipt: Schema.NullOr(SetMessagePinnedReceipt),
});

// The same-named exported type below is the consumer-facing shape of this runtime schema.
// fallow-ignore-next-line unused-export
export const RoomOrderTentativePinCommit = Schema.Struct({
  view: RoomOrderTentativePinView,
  source: Schema.Literals(["pinned", "already-pinned"]),
  pinnedAt: Schema.Number,
  receipt: Schema.NullOr(SetMessagePinnedReceipt),
});

export const RoomOrderTentativePinRecordDisposition = Schema.Struct({
  commit: RoomOrderTentativePinCommit,
  status: Schema.Literals(["tracked", "not-required", "recovery-required", "inconsistent"]),
  detail: Schema.NullOr(Schema.String),
});

// The same-named exported type below is the consumer-facing shape of this runtime schema.
// fallow-ignore-next-line unused-export
export const RoomOrderTentativePinFinalization = Schema.Struct({
  view: RoomOrderTentativePinView,
  committed: Schema.Boolean,
  committedReference: Schema.NullOr(Schema.String),
});

// The same-named exported type below is the consumer-facing shape of this runtime schema.
// fallow-ignore-next-line unused-export
export const RoomOrderTentativePinResponse = Schema.Struct({
  context: AuthorizedRoomOrderPinTentativeContext,
  commit: Schema.NullOr(RoomOrderTentativePinCommit),
  messageId: Schema.String,
  messageConversationId: Schema.String,
  status: Schema.Literals(["pinned", "partial", "failed", "denied"]),
  detail: Schema.String,
  message: BotOutboundMessage,
});

export const RoomOrderTentativePinClaimExecution = Schema.Struct({
  ...RoomOrderTentativePinExecution.fields,
  claim: RoomOrderTentativePinClaim,
});

export const RoomOrderTentativePinViewExecution = Schema.Struct({
  ...RoomOrderTentativePinExecution.fields,
  view: RoomOrderTentativePinView,
});

export const RoomOrderTentativePinCommitExecution = Schema.Struct({
  ...RoomOrderTentativePinExecution.fields,
  commit: RoomOrderTentativePinCommit,
});

export const RoomOrderTentativePinFinalizationExecution = Schema.Struct({
  ...RoomOrderTentativePinExecution.fields,
  finalization: RoomOrderTentativePinFinalization,
});

export const RoomOrderTentativePinResponseExecution = Schema.Struct({
  ...RoomOrderTentativePinExecution.fields,
  response: RoomOrderTentativePinResponse,
});

export const RoomOrderTentativePinReleaseExecution = RoomOrderTentativePinClaimExecution;

export type RoomOrderTentativePinClaim = typeof RoomOrderTentativePinClaim.Type;
export type RoomOrderTentativePinView = typeof RoomOrderTentativePinView.Type;
export type RoomOrderTentativePinAttempt = typeof RoomOrderTentativePinAttempt.Type;
export type RoomOrderTentativePinCommit = typeof RoomOrderTentativePinCommit.Type;
export type RoomOrderTentativePinRecordDisposition =
  typeof RoomOrderTentativePinRecordDisposition.Type;
export type RoomOrderTentativePinFinalization = typeof RoomOrderTentativePinFinalization.Type;
export type RoomOrderTentativePinResponse = typeof RoomOrderTentativePinResponse.Type;
