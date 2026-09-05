import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { SlotsRefreshButton } from "sheet-workflow-contracts";
import {
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import {
  makeSlotsRefreshButtonWorkflowBody,
  slotRefreshWorkflowDefinition,
} from "./slotRefreshDefinition";
import { makeSlotDeliveryKey } from "./keys";

const input = Schema.decodeUnknownSync(SlotsRefreshButton.input)({
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  triggerMessageId: "trigger-1",
});

const currentSlot = {
  clientPlatform: "discord",
  clientId: "discord-main",
  messageId: "old-button",
  day: 2,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  createdByUserId: "creator-1",
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
} as const;

const publishDeliveryKey = makeSlotDeliveryKey(SlotsRefreshButton, invocationId, "publish-button");
const replacedDeliveryKey = makeSlotDeliveryKey(
  SlotsRefreshButton,
  invocationId,
  "delete-replaced-button-published",
);

const published = {
  deliveryKey: publishDeliveryKey,
  operation: "sendMessage" as const,
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
      messageId: "new-button",
    },
  },
};

const replaced = {
  deliveryKey: replacedDeliveryKey,
  operation: "deleteMessage" as const,
  target: { _tag: "Message" as const, message: published.target.message },
};

describe("slot refresh workflow", () => {
  it.effect("skips channels without an active slot button", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const body = makeSlotsRefreshButtonWorkflowBody({
        load: () => {
          calls.push("load");
          return Effect.succeed(null);
        },
        publish: () => {
          calls.push("publish");
          return Effect.die("publish should not run");
        },
        bind: () => Effect.die("bind should not run"),
        cleanup: () => Effect.die("cleanup should not run"),
        deleteReplaced: () => Effect.die("delete should not run"),
      });

      const result = yield* body({ invocationId, principal, input });

      expect(result).toEqual({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: "skipped",
        messageId: null,
        day: null,
        deliveryReceipts: [],
      });
      expect(calls).toEqual(["load"]);
    }),
  );

  it.effect("reposts, rebinds, and removes the previous button", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const body = makeSlotsRefreshButtonWorkflowBody({
        load: () => {
          calls.push("load");
          return Effect.succeed(currentSlot);
        },
        publish: (execution) => {
          calls.push(`publish:${execution.currentSlot.messageId}`);
          return Effect.succeed(published);
        },
        bind: (execution) => {
          calls.push(`bind:${execution.published.target.message.messageId}`);
          return Effect.succeed({ _tag: "Bound" as const });
        },
        cleanup: () => Effect.die("cleanup should not run after a successful bind"),
        deleteReplaced: (execution) => {
          calls.push(`delete:${execution.currentSlot.messageId}`);
          return Effect.succeed({
            status: "authoritative" as const,
            authoritativeMessageId: "new-button",
            deliveryReceipts: [replaced],
          });
        },
      });

      const result = yield* body({ invocationId, principal, input });

      expect(result).toEqual({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: "refreshed",
        messageId: "new-button",
        day: 2,
        deliveryReceipts: [published, replaced],
      });
      expect(calls).toEqual(["load", "publish:old-button", "bind:new-button", "delete:old-button"]);
    }),
  );

  it.effect("reports a skipped refresh when another workflow owns the button", () =>
    Effect.gen(function* () {
      const body = makeSlotsRefreshButtonWorkflowBody({
        load: () => Effect.succeed(currentSlot),
        publish: () => Effect.succeed(published),
        bind: () => Effect.succeed({ _tag: "Bound" as const }),
        cleanup: () => Effect.die("cleanup should not run after a successful bind"),
        deleteReplaced: () =>
          Effect.succeed({
            status: "superseded" as const,
            authoritativeMessageId: "another-button",
            deliveryReceipts: [replaced],
          }),
      });

      expect(yield* body({ invocationId, principal, input })).toEqual({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: "skipped",
        messageId: null,
        day: null,
        deliveryReceipts: [published, replaced],
      });
    }),
  );

  it.effect("reports a skipped refresh when the authoritative binding disappears", () =>
    Effect.gen(function* () {
      const body = makeSlotsRefreshButtonWorkflowBody({
        load: () => Effect.succeed(currentSlot),
        publish: () => Effect.succeed(published),
        bind: () => Effect.succeed({ _tag: "Bound" as const }),
        cleanup: () => Effect.die("cleanup should not run after a successful bind"),
        deleteReplaced: () =>
          Effect.succeed({
            status: "missing" as const,
            authoritativeMessageId: null,
            deliveryReceipts: [replaced],
          }),
      });

      expect(yield* body({ invocationId, principal, input })).toEqual({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        status: "skipped",
        messageId: null,
        day: null,
        deliveryReceipts: [published, replaced],
      });
    }),
  );

  it.effect("cleans up and fails when binding cannot commit", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const body = makeSlotsRefreshButtonWorkflowBody({
        load: () => {
          calls.push("load");
          return Effect.succeed(currentSlot);
        },
        publish: () => {
          calls.push("publish");
          return Effect.succeed(published);
        },
        bind: () => {
          calls.push("bind");
          return Effect.succeed({
            _tag: "CleanupRequired" as const,
            failure: "SlotStateBindFailed" as const,
          });
        },
        cleanup: () => {
          calls.push("cleanup");
          return Effect.succeed(replaced);
        },
        deleteReplaced: () => Effect.die("delete should not run before a successful bind"),
      });

      const exit = yield* Effect.exit(body({ invocationId, principal, input }));

      expect(calls).toEqual(["load", "publish", "bind", "cleanup"]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SlotRefreshBindingFailed",
          cause: "SlotStateBindFailed",
        });
      }
    }),
  );

  it("registers as the autonomous slots refresh contract", () => {
    expect(slotRefreshWorkflowDefinition.contract).toBe(SlotsRefreshButton);
    expect(slotRefreshWorkflowDefinition.workflow.name).toContain("slots.refreshButton");
  });
});
