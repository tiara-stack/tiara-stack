import { Schema } from "effect";
import { BotOutboundMessage } from "sheet-bot-api";
import { RoomOrdersNavigate } from "sheet-workflow-contracts";
import { AuthorizedRoomOrderNavigateContext } from "../readOnly/authorization";
import { workflowContractExecutionSchema } from "../shared/execution";

export const RoomOrderNavigateExecution = workflowContractExecutionSchema(RoomOrdersNavigate);

export const RoomOrderNavigationClaim = Schema.Struct({
  context: AuthorizedRoomOrderNavigateContext,
  claimId: Schema.String,
  status: Schema.Literals(["claimed", "denied"]),
  detail: Schema.NullOr(Schema.String),
});
export type RoomOrderNavigationClaim = typeof RoomOrderNavigationClaim.Type;

const RoomOrderNavigationRange = Schema.Struct({
  minRank: Schema.Int,
  maxRank: Schema.Int,
});

export const RoomOrderNavigationView = Schema.Struct({
  context: AuthorizedRoomOrderNavigateContext,
  claimId: Schema.String,
  direction: Schema.Literals(["previous", "next"]),
  targetRank: Schema.Int,
  range: RoomOrderNavigationRange,
  status: Schema.Literals(["ready", "denied"]),
  detail: Schema.NullOr(Schema.String),
  message: BotOutboundMessage,
});
export type RoomOrderNavigationView = typeof RoomOrderNavigationView.Type;

export const RoomOrderNavigationCommitted = Schema.Struct({
  context: AuthorizedRoomOrderNavigateContext,
  claimId: Schema.String,
  targetRank: Schema.Int,
  status: Schema.Literals(["updated", "denied"]),
  detail: Schema.NullOr(Schema.String),
  message: BotOutboundMessage,
});
export type RoomOrderNavigationCommitted = typeof RoomOrderNavigationCommitted.Type;

export const RoomOrderNavigationClaimExecution = Schema.Struct({
  ...RoomOrderNavigateExecution.fields,
  claim: RoomOrderNavigationClaim,
});

export const RoomOrderNavigationViewExecution = Schema.Struct({
  ...RoomOrderNavigateExecution.fields,
  view: RoomOrderNavigationView,
});

export const RoomOrderNavigationCommittedExecution = Schema.Struct({
  ...RoomOrderNavigateExecution.fields,
  committed: RoomOrderNavigationCommitted,
});

export const RoomOrderNavigationReleaseExecution = Schema.Struct({
  ...RoomOrderNavigationCommittedExecution.fields,
  canonicalProjectionConfirmed: Schema.Boolean,
});
