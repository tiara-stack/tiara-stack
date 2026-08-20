import { createHash } from "node:crypto";
import { Predicate, Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { DeliveryKey, type MessageRef } from "sheet-bot-api";
import {
  teamSubmissionsSheetWorkflowActionVersion,
  teamSubmissionsSheetWorkflowDefinitionVersion,
} from "./catalog";

export const teamSubmissionActionIdentities = Object.freeze({
  process: "process",
  decide: "decide",
  progress: "progress",
  reaction: "reaction",
  confirmation: "confirmation",
  writeFailure: "write-failure",
  confirmationControls: "confirmation-controls",
  cleanup: "cleanup",
  rollback: "rollback",
} as const);

export type TeamSubmissionActionIdentity =
  (typeof teamSubmissionActionIdentities)[keyof typeof teamSubmissionActionIdentities];

// Drain in-flight invocations before changing either version constant so retries cannot switch
// to a new deduplication key mid-flight.
export const makeTeamSubmissionsDeliveryKey = (
  invocationId: typeof InvocationId.Type,
  action: TeamSubmissionActionIdentity,
  suffix?: string,
): typeof DeliveryKey.Type =>
  Schema.decodeUnknownSync(DeliveryKey)(
    [
      "teamSubmissions",
      teamSubmissionsSheetWorkflowDefinitionVersion,
      teamSubmissionsSheetWorkflowActionVersion,
      invocationId,
      action,
      ...(Predicate.isUndefined(suffix)
        ? []
        : [
            createHash("sha256")
              .update(JSON.stringify(["suffix", suffix]))
              .digest("base64url"),
          ]),
    ].join(":"),
  );

// This field order, JSON encoding, 255-byte threshold, and raw-versus-hashed format are a frozen
// durability contract. Change them only with an explicit serialization-key migration.
export const makeTeamSubmissionsSerializationKey = (sourceMessage: MessageRef): string => {
  const canonical = JSON.stringify([
    sourceMessage.conversation.workspace.client.platform,
    sourceMessage.conversation.workspace.client.clientId,
    sourceMessage.conversation.workspace.workspaceId,
    sourceMessage.conversation.conversationId,
    sourceMessage.messageId,
  ]);
  return Buffer.byteLength(canonical, "utf8") <= 255
    ? canonical
    : `teamSubmissions:${createHash("sha256").update(canonical).digest("base64url")}`;
};
