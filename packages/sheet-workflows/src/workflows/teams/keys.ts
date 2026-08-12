import { Schema } from "effect";
import { InvocationId, type AnyWorkflowContract } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { teamSheetWorkflowDefinitionVersion } from "./catalog";

export const makeTeamDeliveryKey = (
  contract: AnyWorkflowContract,
  invocationId: typeof InvocationId.Type,
  kind: "respond",
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${contract.identity}:${teamSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );
