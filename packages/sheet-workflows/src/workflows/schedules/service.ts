import { Context, Data, type Effect } from "effect";
import { type BotOutboundMessage, DeliveryKey, type RespondReceipt } from "sheet-bot-api";
import {
  type InteractiveDeclaredFailure,
  type SchedulesDeliverUserScheduleInput,
} from "sheet-workflow-contracts";
import type { UserScheduleView } from "./schema";

export class ScheduleWorkflowOperationsError extends Data.TaggedError(
  "ScheduleWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type ScheduleResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | ScheduleWorkflowOperationsError
>;

interface ScheduleWorkflowOperationsShape {
  readonly loadUserSchedule: (
    input: SchedulesDeliverUserScheduleInput,
  ) => ScheduleResult<UserScheduleView>;
  readonly respond: (
    input: SchedulesDeliverUserScheduleInput,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => ScheduleResult<RespondReceipt>;
}

export class ScheduleWorkflowOperations extends Context.Service<
  ScheduleWorkflowOperations,
  ScheduleWorkflowOperationsShape
>()("sheet-workflows/ScheduleWorkflowOperations") {}
