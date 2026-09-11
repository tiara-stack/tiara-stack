import { Context, Data, type Effect, Layer } from "effect";
import { type BotOutboundMessage, DeliveryKey, type RespondReceipt } from "sheet-bot-api";
import {
  type InteractiveDeclaredFailure,
  type SchedulesDeliverChannelFillersInput,
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

export type ScheduleWorkflowActions<Execution, ResponseExecution, E, R> = {
  readonly load: (execution: Execution) => Effect.Effect<UserScheduleView, E, R>;
  readonly respond: (
    execution: ResponseExecution,
  ) => Effect.Effect<typeof RespondReceipt.Type, E, R>;
};

interface ScheduleWorkflowOperationsShape {
  readonly loadUserSchedule: (
    input: SchedulesDeliverUserScheduleInput,
  ) => ScheduleResult<UserScheduleView>;
  readonly loadChannelFillers: (
    input: SchedulesDeliverChannelFillersInput,
  ) => ScheduleResult<UserScheduleView>;
  readonly respond: (
    input: SchedulesDeliverUserScheduleInput,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => ScheduleResult<RespondReceipt>;
  readonly respondChannelFillers: (
    input: SchedulesDeliverChannelFillersInput,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => ScheduleResult<RespondReceipt>;
}

export class ScheduleWorkflowOperations extends Context.Service<
  ScheduleWorkflowOperations,
  ScheduleWorkflowOperationsShape
>()("sheet-workflows/ScheduleWorkflowOperations") {
  static readonly testLayer = (service: ScheduleWorkflowOperations["Service"]) =>
    Layer.succeed(ScheduleWorkflowOperations, service);
}
