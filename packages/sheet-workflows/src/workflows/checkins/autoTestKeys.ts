import { createHash } from "node:crypto";
import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { CheckinsTestAuto } from "sheet-workflow-contracts";
import { autoCheckinTestActionVersion, autoCheckinTestWorkflowDefinitionVersion } from "./catalog";

export const autoCheckinTestActionIdentities = Object.freeze({
  createAnchor: "create-provisional-anchor",
  discoverTargets: "discover-targets",
  prepareTarget: "prepare-target",
  deliverCheckin: "deliver-checkin-preview",
  deliverMonitor: "deliver-monitor-preview",
  deliverTentativeRoomOrder: "deliver-tentative-room-order-preview",
  updateSummary: "update-anchor-summary",
  cleanupAnchor: "cleanup-provisional-anchor",
} as const);

export type AutoCheckinTestActionIdentity =
  (typeof autoCheckinTestActionIdentities)[keyof typeof autoCheckinTestActionIdentities];

const stableActionIdentity = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: AutoCheckinTestActionIdentity,
  conversationName?: string,
) =>
  [
    CheckinsTestAuto.identity,
    autoCheckinTestWorkflowDefinitionVersion,
    actionIdentity,
    autoCheckinTestActionVersion,
    invocationId,
    ...(conversationName === undefined
      ? []
      : [
          createHash("sha256")
            .update(JSON.stringify(["running-conversation", conversationName]))
            .digest("base64url"),
        ]),
  ].join(":");

export const makeAutoCheckinTestActionKey = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: AutoCheckinTestActionIdentity,
  conversationName?: string,
): string => stableActionIdentity(invocationId, actionIdentity, conversationName);

export const makeAutoCheckinTestDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: AutoCheckinTestActionIdentity,
  conversationName?: string,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    stableActionIdentity(invocationId, actionIdentity, conversationName),
  );

// Keep deterministic invocation UUID construction identical across interaction workflow modules.
// fallow-ignore-next-line code-duplication
const uuidFromStableIdentity = (identity: string): typeof InvocationId.Type => {
  const bytes = createHash("sha256").update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return Schema.decodeUnknownSync(InvocationId)(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

export const makeAutoCheckinTestInvocationId = (
  clientId: string,
  interactionId: string,
): typeof InvocationId.Type =>
  uuidFromStableIdentity(
    JSON.stringify([
      "discord-interaction",
      clientId,
      interactionId,
      CheckinsTestAuto.identity,
      autoCheckinTestWorkflowDefinitionVersion,
    ]),
  );
