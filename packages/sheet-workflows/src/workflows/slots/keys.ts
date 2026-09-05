import { Schema } from "effect";
import { InvocationId, type AnyWorkflowContract } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { slotSheetWorkflowDefinitionVersion } from "./catalog";

type SlotDeliveryKind =
  | "publish-button"
  | "remove-button"
  | "delete-provisional-button"
  | "delete-replaced-button-current"
  | "delete-replaced-button-published"
  | "respond";

/**
 * Delivery keys are pinned to the slot Workflow Definition version. Drain in-flight slot
 * invocations before changing that version so a replay cannot bypass delivery deduplication.
 */
export const makeSlotDeliveryKey = (
  contract: AnyWorkflowContract,
  invocationId: typeof InvocationId.Type,
  kind: SlotDeliveryKind,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${contract.identity}:${slotSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );
