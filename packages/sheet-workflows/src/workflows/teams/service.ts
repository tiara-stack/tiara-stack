import { Context, Data, type Effect } from "effect";
import { type BotOutboundMessage, DeliveryKey, type RespondReceipt } from "sheet-bot-api";
import {
  TeamsDeliverList,
  type InteractiveDeclaredFailure,
  type TeamsDeliverListInput,
} from "sheet-workflow-contracts";
import type { UserTeamsView } from "./schema";

export class TeamWorkflowOperationsError extends Data.TaggedError("TeamWorkflowOperationsError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type TeamResult<A> = Effect.Effect<A, InteractiveDeclaredFailure | TeamWorkflowOperationsError>;

interface TeamWorkflowOperationsShape {
  readonly loadUserTeams: (input: TeamsDeliverListInput) => TeamResult<UserTeamsView>;
  readonly respond: (
    input: TeamsDeliverListInput,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
    policy: typeof TeamsDeliverList.authorizationPolicy.policy,
  ) => TeamResult<RespondReceipt>;
}

export class TeamWorkflowOperations extends Context.Service<
  TeamWorkflowOperations,
  TeamWorkflowOperationsShape
>()("sheet-workflows/TeamWorkflowOperations") {}
