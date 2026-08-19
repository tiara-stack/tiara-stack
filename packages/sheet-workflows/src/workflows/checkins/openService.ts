import { Context, type Effect } from "effect";
import type {
  BotOutboundMessage,
  DeliveryKey,
  EditMessageReceipt,
  SendDirectMessageReceipt,
  SendMessageReceipt,
} from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type {
  CheckinsOpenCommit,
  CheckinsOpenContext,
  CheckinsOpenExecution,
  CheckinsOpenPrimaryDelivery,
  CheckinsOpenResolvedExecution,
} from "./openSchema";

type CheckinsOpenResult<A> = Effect.Effect<A, InteractiveDeclaredFailure>;

interface CheckinsOpenWorkflowOperationsShape {
  readonly resolve: (
    execution: typeof CheckinsOpenExecution.Type,
  ) => CheckinsOpenResult<CheckinsOpenContext>;
  readonly deliverCheckin: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
    cleanupKey: typeof DeliveryKey.Type,
  ) => CheckinsOpenResult<CheckinsOpenCommit>;
  readonly finalizeCheckin: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
    committed: CheckinsOpenCommit,
    deliveryKey: typeof DeliveryKey.Type,
  ) => CheckinsOpenResult<EditMessageReceipt>;
  readonly deliverPrimary: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
    finalizeKey: typeof DeliveryKey.Type,
    cleanupKey: typeof DeliveryKey.Type,
  ) => CheckinsOpenResult<CheckinsOpenPrimaryDelivery>;
  readonly deliverParticipantDm: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
    userId: string,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
  ) => CheckinsOpenResult<SendDirectMessageReceipt>;
  readonly deliverMonitorDm: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
    message: BotOutboundMessage,
    deliveryKey: typeof DeliveryKey.Type,
  ) => CheckinsOpenResult<SendDirectMessageReceipt>;
  readonly deliverTentativeRoomOrder: (
    execution: typeof CheckinsOpenResolvedExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
    finalizeKey: typeof DeliveryKey.Type,
    cleanupKey: typeof DeliveryKey.Type,
  ) => CheckinsOpenResult<EditMessageReceipt | SendMessageReceipt>;
}

export class CheckinsOpenWorkflowOperations extends Context.Service<
  CheckinsOpenWorkflowOperations,
  CheckinsOpenWorkflowOperationsShape
>()("sheet-workflows/CheckinsOpenWorkflowOperations") {}
