import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { CheckinsRespond } from "sheet-workflow-contracts";
import type { AuthorizedCheckinRespondContext } from "../readOnly/authorization";
import { checkinSheetWorkflowDefinitionVersion } from "./catalog";

export type CheckinDeliveryKind =
  | "respond"
  | "set-member-role"
  | "edit-check-in-message"
  | "announce-first-check-in";

export const makeCheckinClaimId = (invocationId: typeof InvocationId.Type): string =>
  `${CheckinsRespond.identity}:${checkinSheetWorkflowDefinitionVersion}:${invocationId}:commit-check-in`;

export const makeCheckinDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  kind: CheckinDeliveryKind,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${CheckinsRespond.identity}:${checkinSheetWorkflowDefinitionVersion}:${invocationId}:${kind}`,
  );

export const checkinProjectionKey = (
  context: Pick<AuthorizedCheckinRespondContext, "clientPlatform" | "clientId" | "messageId">,
): string => `${context.clientPlatform}:${context.clientId}:${context.messageId}`;
