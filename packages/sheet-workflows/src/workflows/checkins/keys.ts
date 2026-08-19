import { createHash } from "node:crypto";
import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { CheckinsOpen, CheckinsRespond } from "sheet-workflow-contracts";
import type { AuthorizedCheckinRespondContext } from "../readOnly/authorization";
import { checkinSheetWorkflowDefinitionVersion, checkinsOpenActionVersion } from "./catalog";

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

export const checkinsOpenActionIdentities = Object.freeze({
  resolveContext: "resolve-context",
  deliverCheckin: "deliver-checkin",
  finalizeCheckin: "finalize-checkin",
  deliverPrimary: "deliver-primary",
  finalizePrimary: "finalize-primary",
  deliverParticipantDm: "deliver-participant-dm",
  deliverMonitorDm: "deliver-monitor-dm",
  deliverTentativeRoomOrder: "deliver-tentative-room-order",
  cleanupCheckin: "cleanup-checkin",
  cleanupTentativeRoomOrder: "cleanup-tentative-room-order",
} as const);

export type CheckinsOpenActionIdentity =
  (typeof checkinsOpenActionIdentities)[keyof typeof checkinsOpenActionIdentities];

const makeOpenStableIdentity = (
  invocationId: typeof InvocationId.Type,
  action: CheckinsOpenActionIdentity,
  suffix?: string,
) =>
  [
    CheckinsOpen.identity,
    checkinSheetWorkflowDefinitionVersion,
    action,
    checkinsOpenActionVersion,
    invocationId,
    ...(suffix === undefined
      ? []
      : [
          createHash("sha256")
            .update(JSON.stringify(["suffix", suffix]))
            .digest("base64url"),
        ]),
  ].join(":");

export const makeCheckinsOpenActionKey = (
  invocationId: typeof InvocationId.Type,
  action: CheckinsOpenActionIdentity,
  suffix?: string,
): string => makeOpenStableIdentity(invocationId, action, suffix);

export const makeCheckinsOpenDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  action: CheckinsOpenActionIdentity,
  suffix?: string,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(makeOpenStableIdentity(invocationId, action, suffix));

export const makeCheckinsOpenSerializationKey = (
  clientId: string,
  workspaceId: string,
  runningConversationId: string,
  hour: number,
): string => JSON.stringify(["discord", clientId, workspaceId, runningConversationId, hour]);

// Stable UUID derivation intentionally follows the existing workflow key implementations.
// fallow-ignore-next-line code-duplication
const invocationIdFromIdentity = (identity: string): typeof InvocationId.Type => {
  const bytes = createHash("sha256").update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return Schema.decodeUnknownSync(InvocationId)(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

export const makeCheckinsOpenUserInvocationId = (
  clientId: string,
  interactionId: string,
): typeof InvocationId.Type =>
  invocationIdFromIdentity(
    JSON.stringify([
      "discord-interaction",
      clientId,
      interactionId,
      CheckinsOpen.identity,
      checkinSheetWorkflowDefinitionVersion,
    ]),
  );

export const makeCheckinsOpenAutonomousInvocationId = ({
  workspaceId,
  eventStartEpochMs,
  hour,
  conversationName,
}: {
  readonly workspaceId: string;
  readonly eventStartEpochMs: number;
  readonly hour: number;
  readonly conversationName: string;
}): typeof InvocationId.Type =>
  invocationIdFromIdentity(
    JSON.stringify([
      "auto-checkin",
      workspaceId,
      eventStartEpochMs,
      hour,
      conversationName,
      CheckinsOpen.identity,
      checkinSheetWorkflowDefinitionVersion,
    ]),
  );
