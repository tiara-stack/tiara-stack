import { Context, Data, type Effect } from "effect";
import { type BotOutboundMessage, DeliveryKey, type RespondReceipt } from "sheet-bot-api";
import {
  type InteractiveDeclaredFailure,
  type SlotsDeliverListInput,
} from "sheet-workflow-contracts";
import type { SlotView } from "./slotListSchema";

export class SlotListWorkflowOperationsError extends Data.TaggedError(
  "SlotListWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type SlotListResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | SlotListWorkflowOperationsError
>;

interface SlotListWorkflowOperationsShape {
  readonly loadSlotView: (input: SlotsDeliverListInput) => SlotListResult<SlotView>;
  readonly respond: (
    input: SlotsDeliverListInput,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SlotListResult<RespondReceipt>;
}

export class SlotListWorkflowOperations extends Context.Service<
  SlotListWorkflowOperations,
  SlotListWorkflowOperationsShape
>()("sheet-workflows/SlotListWorkflowOperations") {}
