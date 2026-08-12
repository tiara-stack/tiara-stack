import { Schema } from "effect";
import { InvocationId, type AnyWorkflowContract } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { scheduleSheetWorkflowDefinitionVersion } from "./catalog";

/**
 * Delivery keys are pinned to the schedule Workflow Definition version. Drain in-flight schedule
 * invocations before changing that version so a replay cannot bypass delivery deduplication.
 */
export const makeScheduleDeliveryKey = (
  contract: AnyWorkflowContract,
  invocationId: typeof InvocationId.Type,
  kind: "respond",
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${contract.identity}:${scheduleSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );
