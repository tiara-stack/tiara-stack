import { createHash } from "node:crypto";
import { Predicate, Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { MembersKick } from "sheet-workflow-contracts";
import { memberSheetWorkflowDefinitionVersion } from "./catalog";

const memberKickActionIdentities = [
  "resolve-member-kick-context",
  "load-member-kick-schedule",
  "discover-member-kick-targets",
  "remove-member-role",
  "deliver-member-kick-result",
] as const;

export type MemberKickActionIdentity = (typeof memberKickActionIdentities)[number];

const stableActionIdentity = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: MemberKickActionIdentity,
  memberId?: string,
) =>
  [
    MembersKick.identity,
    memberSheetWorkflowDefinitionVersion,
    invocationId,
    actionIdentity,
    ...(Predicate.isUndefined(memberId) ? [] : [memberId]),
  ].join(":");

export const makeMemberKickActionKey = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: MemberKickActionIdentity,
  memberId?: string,
): string => stableActionIdentity(invocationId, actionIdentity, memberId);

export const makeMemberKickRemovalDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  memberId: string,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    stableActionIdentity(invocationId, "remove-member-role", memberId),
  );

export const makeMemberKickResponseDeliveryKey = (
  invocationId: typeof InvocationId.Type,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    stableActionIdentity(invocationId, "deliver-member-kick-result"),
  );

export const makeMemberKickSerializationKey = (
  clientId: string,
  workspaceId: string,
  conversationId: string,
  hour: number,
  roleId: string | null,
): string => JSON.stringify(["discord", clientId, workspaceId, conversationId, hour, roleId]);

// This duplicates the version-5 UUID encoding used by other workflow identity modules on purpose.
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

export const makeMemberKickUserInvocationId = (
  clientId: string,
  interactionId: string,
): typeof InvocationId.Type =>
  uuidFromStableIdentity(
    JSON.stringify([
      "discord-interaction",
      clientId,
      interactionId,
      MembersKick.identity,
      memberSheetWorkflowDefinitionVersion,
    ]),
  );

export const makeMemberKickAutonomousInvocationId = (
  scheduledHourBucketEpochMs: number,
  clientId: string,
  workspaceId: string,
  conversationId: string,
  eventHour: number,
): typeof InvocationId.Type => {
  if (!Number.isFinite(scheduledHourBucketEpochMs)) {
    throw new RangeError("scheduledHourBucketEpochMs must be finite");
  }
  const canonicalBucket = Math.floor(scheduledHourBucketEpochMs / 3_600_000) * 3_600_000;
  return uuidFromStableIdentity(
    JSON.stringify([
      "auto-role-cleanup",
      canonicalBucket,
      clientId,
      workspaceId,
      conversationId,
      eventHour,
      MembersKick.identity,
      memberSheetWorkflowDefinitionVersion,
    ]),
  );
};
