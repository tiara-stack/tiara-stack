import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import {
  BotOutboundMessage,
  BotTextPart,
  DeliveryReceipt,
  MessageRef,
  ResponseReference,
  RespondReceipt,
  SendMessageReceipt,
} from "sheet-bot-api";
import { ActorProvenance, EffectivePrincipal } from "sheet-auth/identity";
import { CheckinGenerateResult } from "sheet-ingress-api/schemas/checkin";
import { CheckinsOpenInput, WorkspaceId } from "sheet-workflow-contracts";

export const CheckinsOpenExecution = Schema.Struct({
  invocationId: InvocationId,
  input: CheckinsOpenInput,
  principal: EffectivePrincipal,
  actorProvenance: Schema.optional(ActorProvenance),
});

export const CheckinsOpenContext = Schema.Struct({
  clientPlatform: Schema.Literal("discord"),
  clientId: Schema.String,
  workspaceId: WorkspaceId,
  principalKind: Schema.Literals(["user", "service"]),
  createdByUserId: Schema.NullOr(Schema.String),
  responseReference: Schema.NullOr(ResponseReference),
  generated: CheckinGenerateResult,
  initialMessage: Schema.NullOr(Schema.Array(BotTextPart)),
  monitorCheckinMessage: Schema.Array(BotTextPart),
  monitorFailureMessage: Schema.NullOr(Schema.Array(BotTextPart)),
  primaryConversationId: Schema.String,
  primaryMessage: BotOutboundMessage,
});
export type CheckinsOpenContext = typeof CheckinsOpenContext.Type;

export const CheckinsOpenResolvedExecution = Schema.Struct({
  ...CheckinsOpenExecution.fields,
  context: CheckinsOpenContext,
});

export const CheckinsOpenCommit = Schema.Struct({
  message: MessageRef,
  receipt: SendMessageReceipt,
});
export type CheckinsOpenCommit = typeof CheckinsOpenCommit.Type;

export const CheckinsOpenCommittedExecution = Schema.Struct({
  ...CheckinsOpenResolvedExecution.fields,
  committed: CheckinsOpenCommit,
});

const CheckinsOpenPrimaryReceipt = Schema.Union([RespondReceipt, SendMessageReceipt]);

export const CheckinsOpenPrimaryDelivery = Schema.Struct({
  receipt: CheckinsOpenPrimaryReceipt,
  additionalReceipts: Schema.Array(DeliveryReceipt),
});
export type CheckinsOpenPrimaryDelivery = typeof CheckinsOpenPrimaryDelivery.Type;
