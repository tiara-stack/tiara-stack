import { Schema } from "effect";
import { CheckinsRespond } from "sheet-workflow-contracts";
import { AuthorizedCheckinRespondContext } from "../readOnly/authorization";
import { workflowContractExecutionSchema } from "../shared/execution";

export const CheckinRespondExecution = workflowContractExecutionSchema(CheckinsRespond);

export const CheckinCommit = Schema.Struct({
  context: AuthorizedCheckinRespondContext,
  checkinAt: Schema.Number,
  checkinClaimId: Schema.String,
  isFirst: Schema.Boolean,
});
export type CheckinCommit = typeof CheckinCommit.Type;

const CheckinMemberView = Schema.Struct({
  memberId: Schema.String,
  checkinAt: Schema.NullOr(Schema.Number),
});

export const CheckinView = Schema.Struct({
  context: AuthorizedCheckinRespondContext,
  members: Schema.Array(CheckinMemberView),
});
export type CheckinView = typeof CheckinView.Type;

export const CheckinCommittedExecution = Schema.Struct({
  ...CheckinRespondExecution.fields,
  committed: CheckinCommit,
});

export const CheckinViewExecution = Schema.Struct({
  ...CheckinCommittedExecution.fields,
  view: CheckinView,
});
