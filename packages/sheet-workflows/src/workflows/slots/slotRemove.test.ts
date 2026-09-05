import { Effect, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { ResponseReference } from "sheet-bot-api";
import { SlotsRemoveButton } from "sheet-workflow-contracts";
import {
  makeSlotsRemoveButtonWorkflowBody,
  makeSlotRemoveWorkflowDefinition,
} from "./slotRemoveDefinition";
import { makeSlotDeliveryKey } from "./keys";
import {
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-remove");
const input = Schema.decodeUnknownSync(SlotsRemoveButton.input)({
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  responseReference,
});
const currentSlot = {
  clientPlatform: "discord",
  clientId: "discord-main",
  messageId: "button-1",
  day: 2,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  createdByUserId: "creator-1",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
} as const;
const removeKey = makeSlotDeliveryKey(SlotsRemoveButton, invocationId, "remove-button");
const responseKey = makeSlotDeliveryKey(SlotsRemoveButton, invocationId, "respond");
const removal = {
  deliveryKey: removeKey,
  operation: "deleteMessage" as const,
  target: {
    _tag: "Message" as const,
    message: {
      conversation: {
        workspace: {
          client: { platform: "discord", clientId: "discord-main" },
          workspaceId: "workspace-1",
        },
        conversationId: "conversation-1",
      },
      messageId: "button-1",
    },
  },
};
const response = {
  deliveryKey: responseKey,
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};

describe("slot button removal workflow", () => {
  it.effect("removes the active button and acknowledges the command", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const body = makeSlotsRemoveButtonWorkflowBody({
        load: () => Effect.succeed(currentSlot),
        remove: (execution) => {
          calls.push(`remove:${execution.currentSlot.messageId}`);
          return Effect.succeed(removal);
        },
        respond: (execution) => {
          calls.push(`${execution.status}:${execution.messageId}`);
          return Effect.succeed(response);
        },
      });

      expect(yield* body({ invocationId, principal, input })).toEqual({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: "removed",
        messageId: "button-1",
        deliveryReceipts: [removal, response],
      });
      expect(calls).toEqual(["remove:button-1", "removed:button-1"]);
    }),
  );

  it.effect("skips deletion when the channel has no active button", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const body = makeSlotsRemoveButtonWorkflowBody({
        load: () => Effect.succeed(null),
        remove: () => Effect.die("remove should not run"),
        respond: (execution) => {
          calls.push(`${execution.status}:${execution.messageId}`);
          return Effect.succeed(response);
        },
      });

      expect(yield* body({ invocationId, principal, input })).toEqual({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: "skipped",
        messageId: null,
        deliveryReceipts: [response],
      });
      expect(calls).toEqual(["skipped:null"]);
    }),
  );

  it("registers as a workspace-monitor interactive workflow", () => {
    const definition = makeSlotRemoveWorkflowDefinition();
    expect(definition.contract).toBe(SlotsRemoveButton);
    expect(definition.workflow.name).toContain("slots.removeButton");
    expect(SlotsRemoveButton.authorizationPolicy.requiredCapabilities).toEqual([
      "workspace.monitor",
    ]);
  });
});
