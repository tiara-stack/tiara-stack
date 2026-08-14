import { Schema } from "effect";
import { BotOutboundMessage, MessageRef, RespondReceipt } from "sheet-bot-api";
import { InteractiveDeclaredFailure, RoomOrdersCreate } from "sheet-workflow-contracts";
import { AuthorizedRoomOrderCreateContext } from "../readOnly/authorization";
import { workflowContractExecutionSchema } from "../shared/execution";

export const RoomOrderCreateExecution = workflowContractExecutionSchema(RoomOrdersCreate);

const RoomOrderCreateEntry = Schema.Struct({
  rank: Schema.Int,
  position: Schema.Int,
  hour: Schema.Number,
  team: Schema.String,
  tags: Schema.Array(Schema.String),
  effectValue: Schema.Number,
});

export const RoomOrderCreateDraft = Schema.Struct({
  context: AuthorizedRoomOrderCreateContext,
  spreadsheetId: Schema.String,
  runningConversationId: Schema.String,
  runningConversationName: Schema.String,
  hour: Schema.Number,
  rank: Schema.Literal(0),
  range: Schema.Struct({ minRank: Schema.Literal(0), maxRank: Schema.Int }),
  previousFills: Schema.Array(Schema.String),
  fills: Schema.Array(Schema.String),
  monitor: Schema.NullOr(Schema.String),
  entries: Schema.Array(RoomOrderCreateEntry),
  generatingMessage: BotOutboundMessage,
  finalMessage: BotOutboundMessage,
});
export type RoomOrderCreateDraft = typeof RoomOrderCreateDraft.Type;

export const RoomOrderCreatePublication = Schema.Struct({
  draft: RoomOrderCreateDraft,
  message: MessageRef,
  receipt: RespondReceipt,
});
export type RoomOrderCreatePublication = typeof RoomOrderCreatePublication.Type;

export const RoomOrderCreateBindingOutcome = Schema.Union([
  Schema.TaggedStruct("Bound", {}),
  Schema.TaggedStruct("CleanupRequired", { failure: InteractiveDeclaredFailure }),
]);
export type RoomOrderCreateBindingOutcome = typeof RoomOrderCreateBindingOutcome.Type;

export const RoomOrderCreateDraftExecution = Schema.Struct({
  ...RoomOrderCreateExecution.fields,
  draft: RoomOrderCreateDraft,
});

export const RoomOrderCreatePublicationExecution = Schema.Struct({
  ...RoomOrderCreateExecution.fields,
  publication: RoomOrderCreatePublication,
});

export const RoomOrderCreateCleanupExecution = Schema.Struct({
  ...RoomOrderCreatePublicationExecution.fields,
  binding: Schema.optional(RoomOrderCreateBindingOutcome),
});
