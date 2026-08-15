import { Context, Data, type Effect } from "effect";
import type {
  BotOutboundMessage,
  DeliveryKey,
  RespondReceipt,
  SetMemberRoleReceipt,
} from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type {
  MemberKickContext,
  MemberKickExecution,
  MemberKickResolvedExecution,
  MemberKickSchedule,
  MemberKickTargets,
} from "./schema";

export class MemberKickWorkflowOperationsError extends Data.TaggedError(
  "MemberKickWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type MemberKickResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | MemberKickWorkflowOperationsError
>;

interface MemberKickWorkflowOperationsShape {
  readonly resolve: (
    execution: typeof MemberKickExecution.Type,
  ) => MemberKickResult<MemberKickContext>;
  readonly loadSchedule: (
    execution: typeof MemberKickResolvedExecution.Type,
  ) => MemberKickResult<MemberKickSchedule>;
  readonly discoverTargets: (
    execution: typeof MemberKickResolvedExecution.Type,
    schedule: MemberKickSchedule,
  ) => MemberKickResult<MemberKickTargets>;
  readonly removeRole: (
    execution: typeof MemberKickResolvedExecution.Type,
    memberId: string,
    deliveryKey: typeof DeliveryKey.Type,
  ) => MemberKickResult<SetMemberRoleReceipt>;
  readonly respond: (
    execution: typeof MemberKickResolvedExecution.Type,
    message: typeof BotOutboundMessage.Type,
    deliveryKey: typeof DeliveryKey.Type,
    recoveryRequired: boolean,
  ) => MemberKickResult<RespondReceipt>;
}

export class MemberKickWorkflowOperations extends Context.Service<
  MemberKickWorkflowOperations,
  MemberKickWorkflowOperationsShape
>()("sheet-workflows/MemberKickWorkflowOperations") {}
