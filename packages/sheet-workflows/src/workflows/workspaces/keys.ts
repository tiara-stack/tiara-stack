import { createHash } from "node:crypto";
import { Predicate, Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey } from "sheet-bot-api";
import { WorkspacesDeliverWelcome } from "sheet-workflow-contracts";
import { workspaceSheetWorkflowDefinitionVersion } from "./catalog";

const welcomeDeliveryActionIdentity = "deliver-workspace-welcome";

export const makeWorkspaceWelcomeDeliveryKey = (
  invocationId: typeof InvocationId.Type,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    `${WorkspacesDeliverWelcome.identity}:${workspaceSheetWorkflowDefinitionVersion}:${invocationId}:${welcomeDeliveryActionIdentity}`,
  );

export const makeWorkspaceWelcomeSerializationKey = (clientId: string, workspaceId: string) =>
  JSON.stringify(["discord", clientId, workspaceId]);

const uuidFromStableIdentity = (identity: string): typeof InvocationId.Type => {
  const bytes = createHash("sha256").update(identity).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return Schema.decodeUnknownSync(InvocationId)(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};

export const makeWorkspaceWelcomeInvocationId = (
  clientId: string,
  workspaceId: string,
  joinedAt: Date | string,
): typeof InvocationId.Type => {
  const joinedAtDate = Predicate.isDate(joinedAt) ? joinedAt : new Date(joinedAt);
  if (!Number.isFinite(joinedAtDate.getTime())) {
    throw new RangeError("joinedAt must be a valid date");
  }
  const canonicalJoinedAt = joinedAtDate.toISOString();
  return uuidFromStableIdentity(
    JSON.stringify(["discord-guild-create", clientId, workspaceId, canonicalJoinedAt]),
  );
};
