import { Context, Data, type Effect } from "effect";
import type {
  DeleteMessageReceipt,
  DeliveryKey,
  EditMessageReceipt,
  RespondReceipt,
} from "sheet-bot-api";
import type { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import type {
  AutoCheckinTestAnchorExecution,
  AutoCheckinTestDiscovery,
  AutoCheckinTestExecution,
  AutoCheckinTestPreparation,
  AutoCheckinTestPreparedExecution,
  AutoCheckinTestPreviewDeliveryOutcome,
  AutoCheckinTestSummaryExecution,
  AutoCheckinTestTargetExecution,
} from "./autoTestSchema";

export class AutoCheckinTestWorkflowOperationsError extends Data.TaggedError(
  "AutoCheckinTestWorkflowOperationsError",
)<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type AutoCheckinTestResult<A> = Effect.Effect<
  A,
  InteractiveDeclaredFailure | AutoCheckinTestWorkflowOperationsError
>;

interface AutoCheckinTestWorkflowOperationsShape {
  readonly createAnchor: (
    execution: typeof AutoCheckinTestExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
  ) => AutoCheckinTestResult<RespondReceipt>;
  readonly discoverTargets: (
    execution: typeof AutoCheckinTestExecution.Type,
  ) => AutoCheckinTestResult<typeof AutoCheckinTestDiscovery.Type>;
  readonly prepareTarget: (
    execution: typeof AutoCheckinTestTargetExecution.Type,
  ) => AutoCheckinTestResult<AutoCheckinTestPreparation>;
  readonly deliverCheckinPreview: (
    execution: typeof AutoCheckinTestPreparedExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
  ) => AutoCheckinTestResult<AutoCheckinTestPreviewDeliveryOutcome>;
  readonly deliverMonitorPreview: (
    execution: typeof AutoCheckinTestPreparedExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
  ) => AutoCheckinTestResult<AutoCheckinTestPreviewDeliveryOutcome>;
  readonly deliverTentativeRoomOrderPreview: (
    execution: typeof AutoCheckinTestPreparedExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
  ) => AutoCheckinTestResult<AutoCheckinTestPreviewDeliveryOutcome>;
  readonly updateAnchorSummary: (
    execution: typeof AutoCheckinTestSummaryExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
  ) => AutoCheckinTestResult<EditMessageReceipt>;
  readonly cleanupAnchor: (
    execution: typeof AutoCheckinTestAnchorExecution.Type,
    deliveryKey: typeof DeliveryKey.Type,
  ) => AutoCheckinTestResult<DeleteMessageReceipt>;
}

export class AutoCheckinTestWorkflowOperations extends Context.Service<
  AutoCheckinTestWorkflowOperations,
  AutoCheckinTestWorkflowOperationsShape
>()("sheet-workflows/AutoCheckinTestWorkflowOperations") {}
