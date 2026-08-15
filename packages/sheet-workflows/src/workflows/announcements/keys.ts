import { createHash } from "node:crypto";
import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { AnnouncementsDeliverUpdate } from "sheet-workflow-contracts";
import { announcementSheetWorkflowDefinitionVersion } from "./catalog";

const updateAnnouncementActionIdentities = [
  "claim-update-announcement-delivery",
  "select-update-announcement-conversation",
  "deliver-update-announcement",
  "record-update-announcement-delivery",
  "release-update-announcement-claim",
] as const;

type UpdateAnnouncementActionIdentity = (typeof updateAnnouncementActionIdentities)[number];

const stableActionIdentity = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: UpdateAnnouncementActionIdentity,
) =>
  `${AnnouncementsDeliverUpdate.identity}:${announcementSheetWorkflowDefinitionVersion}:${invocationId}:${actionIdentity}`;

export const makeUpdateAnnouncementActionKey = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: UpdateAnnouncementActionIdentity,
): string => stableActionIdentity(invocationId, actionIdentity);

export const makeUpdateAnnouncementClaimId = (invocationId: typeof InvocationId.Type): string =>
  stableActionIdentity(invocationId, "claim-update-announcement-delivery");

export const makeUpdateAnnouncementDeliveryKey = (
  invocationId: typeof InvocationId.Type,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    stableActionIdentity(invocationId, "deliver-update-announcement"),
  );

export const makeUpdateAnnouncementSerializationKey = (
  clientId: string,
  workspaceId: string,
  announcementId: string,
): string => JSON.stringify(["discord", clientId, workspaceId, announcementId]);

// Keep deterministic invocation UUID construction identical across autonomous gateway workflows.
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

export const makeUpdateAnnouncementInvocationId = (
  clientId: string,
  workspaceId: string,
  announcementId: string,
): typeof InvocationId.Type =>
  uuidFromStableIdentity(
    JSON.stringify(["discord-update-announcement", clientId, workspaceId, announcementId]),
  );
