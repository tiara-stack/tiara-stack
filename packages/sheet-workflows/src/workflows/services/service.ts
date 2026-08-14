import { Context, Data, Effect } from "effect";
import type { BotOutboundMessage, DeliveryKey, RespondReceipt } from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type { ServicesDeliverStatusInput } from "sheet-workflow-contracts/values";
import type { ServiceReadinessSnapshot } from "./schema";

export class ServiceStatusWorkflowOperationsError extends Data.TaggedError(
  "ServiceStatusWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

interface ServiceStatusWorkflowOperationsShape {
  readonly collectReadiness: () => Effect.Effect<
    ServiceReadinessSnapshot,
    ServiceStatusWorkflowOperationsError
  >;
  readonly respond: (
    input: ServicesDeliverStatusInput,
    message: typeof BotOutboundMessage.Type,
    deliveryKey: typeof DeliveryKey.Type,
    policy: string,
  ) => Effect.Effect<
    typeof RespondReceipt.Type,
    ServiceStatusWorkflowOperationsError | InteractiveDeclaredFailure
  >;
}

export class ServiceStatusWorkflowOperations extends Context.Service<
  ServiceStatusWorkflowOperations,
  ServiceStatusWorkflowOperationsShape
>()("sheet-workflows/ServiceStatusWorkflowOperations") {}
