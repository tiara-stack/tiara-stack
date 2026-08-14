import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { ServicesDeliverStatus } from "sheet-workflow-contracts";
import { serviceSheetWorkflowDefinitionVersion } from "./catalog";

export const makeServiceStatusDeliveryKey = (
  invocationId: typeof InvocationId.Type,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${ServicesDeliverStatus.identity}:${serviceSheetWorkflowDefinitionVersion}:${invocationId}:deliver-service-status`,
  );
