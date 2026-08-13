import { Context, Data, type Effect } from "effect";
import { type BotOutboundMessage, DeliveryKey, type RespondReceipt } from "sheet-bot-api";
import type { InteractiveDeclaredFailure, SlotsOpenInput } from "sheet-workflow-contracts";
import type { AuthorizedSlotOpenContext } from "../readOnly/authorization";
import type { SlotView } from "./slotListSchema";

export class SlotOpenWorkflowOperationsError extends Data.TaggedError(
  "SlotOpenWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type SlotOpenResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | SlotOpenWorkflowOperationsError
>;

interface SlotOpenWorkflowOperationsShape {
  readonly loadSlotView: (context: AuthorizedSlotOpenContext) => SlotOpenResult<SlotView>;
  readonly respond: (
    input: SlotsOpenInput,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => SlotOpenResult<RespondReceipt>;
}

export class SlotOpenWorkflowOperations extends Context.Service<
  SlotOpenWorkflowOperations,
  SlotOpenWorkflowOperationsShape
>()("sheet-workflows/SlotOpenWorkflowOperations") {}
