import { createHash } from "node:crypto";
import { Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey, SemanticFileIdentity } from "sheet-bot-api";
import { ScreenshotsCaptureAndDeliver } from "sheet-workflow-contracts";
import { screenshotActionVersion, screenshotWorkflowDefinitionVersion } from "./catalog";

const resolveActionIdentity = "resolve-screenshot-source";
const captureActionIdentity = "capture-and-deliver-screenshot";

export type ScreenshotActionIdentity = typeof resolveActionIdentity | typeof captureActionIdentity;

const stableActionIdentity = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: ScreenshotActionIdentity,
) =>
  [
    ScreenshotsCaptureAndDeliver.identity,
    screenshotWorkflowDefinitionVersion,
    actionIdentity,
    screenshotActionVersion,
    invocationId,
  ].join(":");

export const makeScreenshotActionKey = (
  invocationId: typeof InvocationId.Type,
  actionIdentity: ScreenshotActionIdentity,
): string => stableActionIdentity(invocationId, actionIdentity);

export const makeScreenshotDeliveryKey = (
  invocationId: typeof InvocationId.Type,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(stableActionIdentity(invocationId, captureActionIdentity));

export const makeScreenshotLogicalRequest = (
  workspaceId: string,
  conversationName: string,
  day: number,
): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([workspaceId, conversationName, day]))
    .digest("base64url");
  return `${ScreenshotsCaptureAndDeliver.identity}:${screenshotActionVersion}:${digest}`;
};

export const makeScreenshotSemanticFileIdentity = (
  invocationId: typeof InvocationId.Type,
  workspaceId: string,
  conversationName: string,
  day: number,
): typeof SemanticFileIdentity.Type => {
  const logicalRequest = makeScreenshotLogicalRequest(workspaceId, conversationName, day);
  const digest = createHash("sha256")
    .update(`${stableActionIdentity(invocationId, captureActionIdentity)}:${logicalRequest}`)
    .digest("base64url");
  return Schema.decodeUnknownSync(SemanticFileIdentity)(
    `${ScreenshotsCaptureAndDeliver.identity}:${screenshotActionVersion}:${digest}`,
  );
};

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

export const makeScreenshotInvocationId = (
  clientId: string,
  interactionId: string,
): typeof InvocationId.Type =>
  uuidFromStableIdentity(
    JSON.stringify([
      "discord-interaction",
      clientId,
      interactionId,
      ScreenshotsCaptureAndDeliver.identity,
      screenshotWorkflowDefinitionVersion,
    ]),
  );
