import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import { BotResponseExpired, ResponseReference, type SheetBotHttpClient } from "sheet-bot-api";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  AutonomousDeclaredFailure,
  InteractiveDeclaredFailure,
  SlotsDeliverList,
  SlotsOpen,
  SlotsPublishButton,
  SlotsRemoveButton,
  SlotsRefreshButton,
} from "sheet-workflow-contracts";
import { ZeroClient } from "typhoon-zero/client";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeTrustedSheetPersistenceMock, normalizePayloadText } from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import {
  makeRecordingWorkflowAuthorization,
  workflowTestAccountId as accountId,
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { SlotSheetWorkflowContracts } from "./catalog";
import {
  isSlotSheetWorkflowName,
  makeSlotDeliveryKey,
  makeSlotsPublishButtonWorkflowBody,
  materializeSlotWorkflowFailure,
  SlotSheetWorkflowDefinitions,
  SlotSheetWorkflows,
} from "./definitions";
import { SlotWorkflowOperations, slotWorkflowOperationsLayer } from "./operations";
import { SlotSheetWorkflowRegistrations } from "./registry";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const otherInvocationId = Schema.decodeUnknownSync(InvocationId)(
  "123e4567-e89b-42d3-a456-426614174001",
);
const input = Schema.decodeUnknownSync(SlotsPublishButton.input)({
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  day: 2,
  responseReference,
});
const publishKey = makeSlotDeliveryKey(SlotsPublishButton, invocationId, "publish-button");
const published = {
  deliveryKey: publishKey,
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
      messageId: "message-1",
    },
  },
};

const makeBot = (overrides: {
  readonly getConversation?: (request: {
    readonly params: Record<string, string>;
  }) => Effect.Effect<unknown, unknown>;
  readonly sendMessage?: (request: {
    readonly payload: Record<string, unknown>;
  }) => Effect.Effect<unknown, unknown>;
  readonly deleteMessage?: (request: {
    readonly payload: Record<string, unknown>;
  }) => Effect.Effect<unknown, unknown>;
  readonly respond?: (request: {
    readonly payload: Record<string, unknown>;
  }) => Effect.Effect<unknown, unknown>;
}): SheetBotHttpClient =>
  ({
    cache: {
      getConversation:
        overrides.getConversation ?? (() => Effect.die("Unexpected getConversation call")),
    },
    delivery: {
      sendMessage: overrides.sendMessage ?? (() => Effect.die("Unexpected sendMessage call")),
      deleteMessage: overrides.deleteMessage ?? (() => Effect.die("Unexpected deleteMessage call")),
      respond: overrides.respond ?? (() => Effect.die("Unexpected respond call")),
    },
  }) as unknown as SheetBotHttpClient;

const makeOperations = (
  slotState: TrustedSheetPersistence["Service"]["slotState"],
  bot: SheetBotHttpClient,
) => {
  const base = makeTrustedSheetPersistenceMock();
  return Effect.gen(function* () {
    return yield* SlotWorkflowOperations;
  }).pipe(
    Effect.provide(slotWorkflowOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, { ...base, slotState })),
    Effect.provide(Layer.succeed(SheetBotCacheClient, { get: () => bot })),
    Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => bot })),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ sheetBotClientId: "discord-main" })),
    ),
  );
};

const baseSlotState = () => makeTrustedSheetPersistenceMock().slotState;

describe("slot Workflow Definition slices", () => {
  it("keeps the existing slot definitions and appends the pinned slot-open definition", () => {
    expect(SlotSheetWorkflowContracts).toEqual([
      SlotsPublishButton,
      SlotsRefreshButton,
      SlotsDeliverList,
      SlotsOpen,
      SlotsRemoveButton,
    ]);
    expect(
      SlotSheetWorkflowDefinitions.map(({ contract, workflow }) => ({
        contract: workflowContractKey(contract),
        workflow: workflow.name,
      })),
    ).toEqual(
      [SlotsPublishButton, SlotsRefreshButton, SlotsDeliverList, SlotsOpen, SlotsRemoveButton].map(
        (contract) => ({
          contract: workflowContractKey(contract),
          workflow: workflowContractKey(contract),
        }),
      ),
    );
    expect(SlotSheetWorkflowDefinitions[0]!.actions.map(({ workflow }) => workflow.name)).toEqual([
      "slots.publishButton.load-current-slot",
      "slots.publishButton.publish-button",
      "slots.publishButton.bind-slot-state",
      "slots.publishButton.delete-provisional-button",
      "slots.publishButton.delete-replaced-button",
      "slots.publishButton.respond",
    ]);
    expect(SlotSheetWorkflowDefinitions[1]!.actions.map(({ workflow }) => workflow.name)).toEqual([
      "slots.refreshButton.load-current-slot",
      "slots.refreshButton.publish-button",
      "slots.refreshButton.bind-slot-state",
      "slots.refreshButton.delete-provisional-button",
      "slots.refreshButton.delete-replaced-button",
    ]);
    expect(SlotSheetWorkflowDefinitions[2]!.actions.map(({ workflow }) => workflow.name)).toEqual([
      "slots.deliverList.load-slot-view",
      "slots.deliverList.respond",
    ]);
    expect(SlotSheetWorkflowDefinitions[3]!.actions.map(({ workflow }) => workflow.name)).toEqual([
      "slots.open.load-slot-view",
      "slots.open.respond",
    ]);
    expect(
      SlotSheetWorkflowRegistrations.map(({ contract, definitionVersion }) => ({
        contract,
        definitionVersion,
      })),
    ).toEqual([
      { contract: SlotsPublishButton, definitionVersion: "5" },
      { contract: SlotsRefreshButton, definitionVersion: "5" },
      { contract: SlotsDeliverList, definitionVersion: "5" },
      { contract: SlotsOpen, definitionVersion: "5" },
      { contract: SlotsRemoveButton, definitionVersion: "5" },
    ]);
    expect(SlotSheetWorkflowDefinitions[0]!.contract.declaredFailure).toBe(
      InteractiveDeclaredFailure,
    );
    expect(SlotSheetWorkflowDefinitions[1]!.contract.declaredFailure).toBe(
      AutonomousDeclaredFailure,
    );
    expect(isSlotSheetWorkflowName(SlotSheetWorkflows[0]!.name)).toBe(true);
    expect(isSlotSheetWorkflowName(workflowContractKey(SlotsOpen))).toBe(true);
    expect(isSlotSheetWorkflowName("slots.unregistered:1")).toBe(false);
    expect(isSlotSheetWorkflowName(SlotsOpen.identity)).toBe(false);
  });

  it.effect("uses deterministic Action Keys and operation-specific Delivery Keys", () =>
    Effect.gen(function* () {
      const payload = {
        invocationId,
        principal,
        input,
        currentSlot: null,
        creatorAccountId: accountId,
        published,
        binding: { _tag: "CleanupRequired" as const, failure: "SlotStateBindFailed" as const },
      };
      const definition = SlotSheetWorkflowDefinitions[0]!;
      const actionIds = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      const replayIds = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      expect(replayIds).toEqual(actionIds);
      expect(new Set(actionIds).size).toBe(6);
      const keys = [
        makeSlotDeliveryKey(SlotsPublishButton, invocationId, "publish-button"),
        makeSlotDeliveryKey(SlotsPublishButton, invocationId, "delete-provisional-button"),
        makeSlotDeliveryKey(SlotsPublishButton, invocationId, "delete-replaced-button-current"),
        makeSlotDeliveryKey(SlotsPublishButton, invocationId, "delete-replaced-button-published"),
        makeSlotDeliveryKey(SlotsPublishButton, invocationId, "respond"),
      ];
      expect(new Set(keys).size).toBe(5);
      expect(makeSlotDeliveryKey(SlotsPublishButton, invocationId, "publish-button")).toBe(
        `slots.publishButton:5:${invocationId}:publish-button`,
      );
      expect(makeSlotDeliveryKey(SlotsPublishButton, otherInvocationId, "publish-button")).not.toBe(
        keys[0],
      );
    }),
  );

  it.effect("uses workspace-monitor authorization and preserves owner isolation", () => {
    const calls: Array<unknown> = [];
    const authorization = makeRecordingWorkflowAuthorization(calls);
    return Effect.gen(function* () {
      yield* SlotSheetWorkflowRegistrations[0]!.authorize(context, input);
      expect(calls).toEqual([{ contract: SlotsPublishButton, principal, input }]);
      const exit = yield* Effect.exit(
        SlotSheetWorkflowRegistrations[0]!.authorizeObservation({
          ...context,
          ownerKey: "user:other",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
          message: "Workflow owner does not match the effective principal",
        });
      }
    }).pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
  });

  it.effect("publishes exact legacy content after validating the target conversation", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const bot = makeBot({
        getConversation: ({ params }) => {
          calls.push({ method: "getConversation", params });
          return Effect.succeed({
            id: params.conversationId,
            type: 0,
            workspaceId: params.workspaceId,
          });
        },
        sendMessage: ({ payload }) => {
          calls.push({ method: "sendMessage", payload: normalizePayloadText(payload) });
          return Effect.succeed(published);
        },
      });
      const operations = yield* makeOperations(baseSlotState(), bot);
      expect(
        yield* operations.requireCreatorAccountId(
          principal,
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      ).toBe(accountId);
      expect(
        yield* operations.publishButton(
          input,
          publishKey,
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      ).toEqual(published);
      expect(calls).toEqual([
        {
          method: "getConversation",
          params: {
            platform: "discord",
            clientId: "discord-main",
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
          },
        },
        {
          method: "sendMessage",
          payload: {
            conversation: {
              workspace: {
                client: { platform: "discord", clientId: "discord-main" },
                workspaceId: "workspace-1",
              },
              conversationId: "conversation-1",
            },
            deliveryKey: publishKey,
            message: {
              content: "Press the button below to get the current open slots for day 2",
              components: [
                {
                  type: "actionRow",
                  components: [
                    {
                      type: "button",
                      actionId: "interaction:slot",
                      label: "Open slots",
                      style: "primary",
                      disabled: false,
                    },
                  ],
                },
              ],
            },
          },
        },
      ]);
    }),
  );

  it.effect("rejects missing Discord attribution and cross-workspace conversations", () =>
    Effect.gen(function* () {
      let sendCalls = 0;
      const bot = makeBot({
        getConversation: () =>
          Effect.succeed({ id: "conversation-1", type: 0, workspaceId: "workspace-2" }),
        sendMessage: () => {
          sendCalls += 1;
          return Effect.succeed(published);
        },
      });
      const operations = yield* makeOperations(baseSlotState(), bot);
      expect(
        yield* Effect.flip(
          operations.requireCreatorAccountId(
            { ...principal, discordAccount: undefined },
            SlotsPublishButton.authorizationPolicy.policy,
          ),
        ),
      ).toEqual({
        _tag: "AuthorizationRevoked",
        policy: SlotsPublishButton.authorizationPolicy.policy,
      });
      expect(
        yield* Effect.flip(
          operations.publishButton(
            input,
            publishKey,
            SlotsPublishButton.authorizationPolicy.policy,
          ),
        ),
      ).toEqual({
        _tag: "InvalidRequest",
        code: "ConversationWorkspaceMismatch",
        message: "The conversation must belong to the authorized workspace",
      });
      expect(sendCalls).toBe(0);
    }),
  );

  it.effect("binds idempotently and reconciles an ambiguous write by exact row identity", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const row = {
        clientPlatform: "discord",
        clientId: "discord-main",
        messageId: "message-1",
        day: 2,
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        createdByUserId: accountId,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      };
      let attempts = 0;
      const slotState: TrustedSheetPersistence["Service"]["slotState"] = {
        getMessageSlotData: (args) => {
          calls.push({ method: "get", args });
          return Effect.succeed(Option.some(row));
        },
        getMessageSlotDataByConversation: () => Effect.succeed(Option.some(row)),
        upsertMessageSlotData: (args) => {
          calls.push({ method: "upsert", args });
          attempts += 1;
          return attempts === 1
            ? Effect.fail(
                new ZeroClient.ZeroClientExecutorError({
                  operation: "upsert slot state",
                  message: "ambiguous commit",
                }),
              )
            : Effect.void;
        },
        removeMessageSlotData: () => Effect.void,
        replaceMessageSlotData: () => Effect.void,
      };
      const operations = yield* makeOperations(slotState, makeBot({}));
      expect(yield* operations.bindSlotState(input, published, accountId)).toEqual({
        _tag: "Bound",
      });
      expect(yield* operations.bindSlotState(input, published, accountId)).toEqual({
        _tag: "Bound",
      });
      expect(calls).toEqual([
        {
          method: "upsert",
          args: {
            clientPlatform: "discord",
            clientId: "discord-main",
            messageId: "message-1",
            day: 2,
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            createdByUserId: accountId,
          },
        },
        {
          method: "get",
          args: {
            clientPlatform: "discord",
            clientId: "discord-main",
            messageId: "message-1",
          },
        },
        {
          method: "upsert",
          args: {
            clientPlatform: "discord",
            clientId: "discord-main",
            messageId: "message-1",
            day: 2,
            workspaceId: "workspace-1",
            conversationId: "conversation-1",
            createdByUserId: accountId,
          },
        },
      ]);
    }),
  );

  it.effect("deletes the slot button before removing its state", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const currentSlot = {
        clientPlatform: "discord",
        clientId: "discord-main",
        messageId: "button-1",
        day: 2,
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        createdByUserId: accountId,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      } as const;
      const slotState: TrustedSheetPersistence["Service"]["slotState"] = {
        getMessageSlotData: () => Effect.succeed(Option.none()),
        getMessageSlotDataByConversation: () => Effect.succeed(Option.some(currentSlot)),
        upsertMessageSlotData: () => Effect.void,
        removeMessageSlotData: ({ expectedMessageId }) => {
          calls.push(`remove:${expectedMessageId}`);
          return Effect.void;
        },
        replaceMessageSlotData: () => Effect.void,
      };
      const operations = yield* makeOperations(
        slotState,
        makeBot({
          deleteMessage: ({ payload }) => {
            calls.push(`delete:${(payload.message as { messageId: string }).messageId}`);
            return Effect.succeed({
              deliveryKey: payload.deliveryKey,
              operation: "deleteMessage" as const,
              target: { _tag: "Message" as const, message: payload.message },
            });
          },
        }),
      );

      yield* operations.removeButton(
        currentSlot,
        makeSlotDeliveryKey(SlotsRemoveButton, invocationId, "remove-button"),
        SlotsRemoveButton.authorizationPolicy.policy,
      );

      expect(calls).toEqual(["delete:button-1", "remove:button-1"]);
    }),
  );

  it.effect("keeps slot state when button deletion fails", () =>
    Effect.gen(function* () {
      const removals: string[] = [];
      const currentSlot = {
        clientPlatform: "discord",
        clientId: "discord-main",
        messageId: "button-1",
        day: 2,
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        createdByUserId: accountId,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      } as const;
      const slotState: TrustedSheetPersistence["Service"]["slotState"] = {
        getMessageSlotData: () => Effect.succeed(Option.none()),
        getMessageSlotDataByConversation: () => Effect.succeed(Option.some(currentSlot)),
        upsertMessageSlotData: () => Effect.void,
        removeMessageSlotData: () => {
          removals.push("removed");
          return Effect.void;
        },
        replaceMessageSlotData: () => Effect.void,
      };
      const operations = yield* makeOperations(
        slotState,
        makeBot({ deleteMessage: () => Effect.fail("delete failed") }),
      );

      const exit = yield* Effect.exit(
        operations.removeButton(
          currentSlot,
          makeSlotDeliveryKey(SlotsRemoveButton, invocationId, "remove-button"),
          SlotsRemoveButton.authorizationPolicy.policy,
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(removals).toEqual([]);
    }),
  );

  it.effect("removes both stale buttons during an A-to-B-to-C refresh interleaving", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const currentSlotA = {
        clientPlatform: "discord",
        clientId: "discord-main",
        messageId: "slot-a",
        day: 2,
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        createdByUserId: accountId,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      };
      const currentSlotB = { ...currentSlotA, messageId: "slot-b" };
      const authoritativeSlotC = { ...currentSlotA, messageId: "slot-c" };
      const publishedB = {
        ...published,
        target: {
          ...published.target,
          message: { ...published.target.message, messageId: "slot-b" },
        },
      };
      const publishedC = {
        ...published,
        target: {
          ...published.target,
          message: { ...published.target.message, messageId: "slot-c" },
        },
      };
      const slotState: TrustedSheetPersistence["Service"]["slotState"] = {
        getMessageSlotData: () => Effect.succeed(Option.none()),
        getMessageSlotDataByConversation: () => Effect.succeed(Option.some(authoritativeSlotC)),
        upsertMessageSlotData: () => Effect.void,
        removeMessageSlotData: () => Effect.void,
        replaceMessageSlotData: () => Effect.void,
      };
      const operations = yield* makeOperations(
        slotState,
        makeBot({
          deleteMessage: ({ payload }) => {
            calls.push(payload);
            return Effect.succeed({
              deliveryKey: payload.deliveryKey,
              operation: "deleteMessage" as const,
              target: { _tag: "Message" as const, message: payload.message },
            });
          },
        }),
      );
      const replacementKeys = {
        current: makeSlotDeliveryKey(
          SlotsPublishButton,
          invocationId,
          "delete-replaced-button-current",
        ),
        published: makeSlotDeliveryKey(
          SlotsPublishButton,
          invocationId,
          "delete-replaced-button-published",
        ),
      };

      const firstCleanup = yield* operations.deleteReplacedButton(
        currentSlotA,
        publishedB,
        replacementKeys,
        SlotsPublishButton.authorizationPolicy.policy,
      );
      const secondCleanup = yield* operations.deleteReplacedButton(
        currentSlotA,
        publishedC,
        replacementKeys,
        SlotsPublishButton.authorizationPolicy.policy,
      );
      const thirdCleanup = yield* operations.deleteReplacedButton(
        currentSlotB,
        publishedC,
        replacementKeys,
        SlotsPublishButton.authorizationPolicy.policy,
      );

      expect(firstCleanup.status).toBe("superseded");
      expect(secondCleanup.status).toBe("authoritative");
      expect(thirdCleanup.status).toBe("authoritative");
      expect(calls).toHaveLength(4);
      expect(calls[0]).toMatchObject({ message: { messageId: "slot-a" } });
      expect(calls[1]).toMatchObject({ message: { messageId: "slot-b" } });
      expect(calls[2]).toMatchObject({ message: { messageId: "slot-a" } });
      expect(calls[3]).toMatchObject({ message: { messageId: "slot-b" } });
    }),
  );

  it.effect("reports the surviving button when a concurrent publish supersedes this one", () =>
    Effect.gen(function* () {
      const currentSlot = {
        clientPlatform: "discord",
        clientId: "discord-main",
        messageId: "old-button",
        day: 2,
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        createdByUserId: accountId,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      } as const;
      const responseKey = makeSlotDeliveryKey(SlotsPublishButton, invocationId, "respond");
      const response = {
        deliveryKey: responseKey,
        operation: "respond" as const,
        target: { _tag: "Response" as const, responseReference },
      };
      const replacedReceipt = {
        deliveryKey: makeSlotDeliveryKey(
          SlotsPublishButton,
          invocationId,
          "delete-replaced-button-published",
        ),
        operation: "deleteMessage" as const,
        target: { _tag: "Message" as const, message: published.target.message },
      };
      const workflowBody = makeSlotsPublishButtonWorkflowBody({
        load: () => Effect.succeed(currentSlot),
        publish: () => Effect.succeed({ currentSlot, creatorAccountId: accountId, published }),
        bind: () => Effect.succeed({ _tag: "Bound" as const }),
        cleanup: () => Effect.die("cleanup should not run after a successful bind"),
        deleteReplaced: () =>
          Effect.succeed({
            status: "superseded" as const,
            authoritativeMessageId: "concurrent-button",
            deliveryReceipts: [replacedReceipt],
          }),
        respond: () => Effect.succeed(response),
      });

      expect(yield* workflowBody({ invocationId, principal, input })).toEqual({
        messageId: "concurrent-button",
        messageConversationId: "conversation-1",
        day: 2,
        deliveryReceipts: [published, replacedReceipt, response],
      });
    }),
  );

  it.effect("attempts every stale deletion before surfacing a delivery failure", () =>
    Effect.gen(function* () {
      const deletedPayloads: unknown[] = [];
      const currentSlot = {
        clientPlatform: "discord",
        clientId: "discord-main",
        messageId: "old-button",
        day: 2,
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        createdByUserId: accountId,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      } as const;
      const authoritativeSlot = { ...currentSlot, messageId: "authoritative-button" };
      const replacement = {
        ...published,
        target: {
          ...published.target,
          message: { ...published.target.message, messageId: "new-button" },
        },
      };
      const slotState: TrustedSheetPersistence["Service"]["slotState"] = {
        getMessageSlotData: () => Effect.succeed(Option.none()),
        getMessageSlotDataByConversation: () => Effect.succeed(Option.some(authoritativeSlot)),
        upsertMessageSlotData: () => Effect.void,
        removeMessageSlotData: () => Effect.void,
        replaceMessageSlotData: () => Effect.void,
      };
      const operations = yield* makeOperations(
        slotState,
        makeBot({
          deleteMessage: ({ payload }) => {
            deletedPayloads.push(payload);
            return Effect.fail("delete failed");
          },
        }),
      );
      const replacementKeys = {
        current: makeSlotDeliveryKey(
          SlotsPublishButton,
          invocationId,
          "delete-replaced-button-current",
        ),
        published: makeSlotDeliveryKey(
          SlotsPublishButton,
          invocationId,
          "delete-replaced-button-published",
        ),
      };

      const exit = yield* Effect.exit(
        operations.deleteReplacedButton(
          currentSlot,
          replacement,
          replacementKeys,
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      );

      expect(deletedPayloads).toEqual([
        expect.objectContaining({ message: expect.objectContaining({ messageId: "old-button" }) }),
        expect.objectContaining({ message: expect.objectContaining({ messageId: "new-button" }) }),
      ]);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("fails without responding when a published button loses its binding", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const workflowBody = makeSlotsPublishButtonWorkflowBody({
        load: () => {
          calls.push("load");
          return Effect.succeed(null);
        },
        publish: () => {
          calls.push("publish");
          return Effect.succeed({ currentSlot: null, creatorAccountId: accountId, published });
        },
        bind: () => {
          calls.push("bind");
          return Effect.succeed({ _tag: "Bound" as const });
        },
        cleanup: () => Effect.die("cleanup should not run after a successful bind"),
        deleteReplaced: () => {
          calls.push("delete-replaced");
          return Effect.succeed({
            status: "missing" as const,
            authoritativeMessageId: null,
            deliveryReceipts: [],
          });
        },
        respond: () => {
          calls.push("respond");
          return Effect.die("respond should not run without an authoritative button");
        },
      });

      const exit = yield* Effect.exit(workflowBody({ invocationId, principal, input }));

      expect(calls).toEqual(["load", "publish", "bind", "delete-replaced"]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SlotBindingFailed",
          cause: "SlotStateMissingAfterBind",
        });
      }
    }),
  );

  it.effect("requests deterministic cleanup only after a definite pre-commit bind failure", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const slotState: TrustedSheetPersistence["Service"]["slotState"] = {
        getMessageSlotData: () => Effect.succeed(Option.none()),
        getMessageSlotDataByConversation: () => Effect.succeed(Option.none()),
        upsertMessageSlotData: () =>
          Effect.fail(
            new ZeroClient.ZeroClientExecutorError({
              operation: "upsert slot state",
              message: "definite bind failure",
            }),
          ),
        removeMessageSlotData: () => Effect.void,
        replaceMessageSlotData: () => Effect.void,
      };
      const cleanupKey = makeSlotDeliveryKey(
        SlotsPublishButton,
        invocationId,
        "delete-provisional-button",
      );
      const bot = makeBot({
        deleteMessage: ({ payload }) => {
          calls.push(payload);
          return Effect.succeed({
            deliveryKey: payload.deliveryKey,
            operation: "deleteMessage" as const,
            target: { _tag: "Message" as const, message: payload.message },
          });
        },
      });
      const operations = yield* makeOperations(slotState, bot);
      const binding = yield* operations.bindSlotState(input, published, accountId);
      expect(binding).toEqual({
        _tag: "CleanupRequired",
        failure: "SlotStateBindFailed",
      });
      expect(
        yield* operations.deleteProvisionalButton(
          published,
          cleanupKey,
          SlotsPublishButton.authorizationPolicy.policy,
        ),
      ).toMatchObject({ operation: "deleteMessage", deliveryKey: cleanupKey });
      expect(calls).toEqual([{ message: published.target.message, deliveryKey: cleanupKey }]);
    }),
  );

  it.effect("cleans up before failing the workflow when slot binding cannot commit", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const cleanupKey = makeSlotDeliveryKey(
        SlotsPublishButton,
        invocationId,
        "delete-provisional-button",
      );
      const workflowBody = makeSlotsPublishButtonWorkflowBody({
        load: () => {
          calls.push("load-current-slot");
          return Effect.succeed(null);
        },
        publish: () => {
          calls.push("publish-button");
          return Effect.succeed({ currentSlot: null, creatorAccountId: accountId, published });
        },
        bind: () => {
          calls.push("bind-slot-state");
          return Effect.succeed({
            _tag: "CleanupRequired" as const,
            failure: "SlotStateBindFailed" as const,
          });
        },
        cleanup: () => {
          calls.push("delete-provisional-button");
          return Effect.succeed({
            deliveryKey: cleanupKey,
            operation: "deleteMessage" as const,
            target: { _tag: "Message" as const, message: published.target.message },
          });
        },
        deleteReplaced: () => {
          calls.push("delete-replaced-button");
          return Effect.succeed({
            status: "authoritative" as const,
            authoritativeMessageId: published.target.message.messageId,
            deliveryReceipts: [],
          });
        },
        respond: () => {
          calls.push("respond");
          return Effect.die("response must not run after a pre-commit bind failure");
        },
      });

      const exit = yield* Effect.exit(workflowBody({ invocationId, principal, input }));
      expect(calls).toEqual([
        "load-current-slot",
        "publish-button",
        "bind-slot-state",
        "delete-provisional-button",
      ]);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SlotBindingFailed",
          cause: "SlotStateBindFailed",
        });
      }
    }),
  );

  it.effect("preserves committed state and marks post-commit response rejection for recovery", () =>
    Effect.gen(function* () {
      let cleanupCalls = 0;
      let responsePayload: unknown;
      const bot = makeBot({
        deleteMessage: () => {
          cleanupCalls += 1;
          return Effect.die("cleanup must not run after the Commit Point");
        },
        respond: ({ payload }) => {
          responsePayload = normalizePayloadText(payload);
          return Effect.fail(new BotResponseExpired({ message: "expired secret" }));
        },
      });
      const operations = yield* makeOperations(baseSlotState(), bot);
      const responseKey = makeSlotDeliveryKey(SlotsPublishButton, invocationId, "respond");
      expect(
        yield* Effect.flip(
          operations.respond(input, responseKey, SlotsPublishButton.authorizationPolicy.policy),
        ),
      ).toEqual({
        _tag: "DeliveryRejected",
        operation: "slots.respond",
        message: "The response is no longer available",
        recoveryRequired: true,
      });
      expect(responsePayload).toEqual({
        responseReference,
        deliveryKey: responseKey,
        message: { content: "Slot button sent!", visibility: "ephemeral" },
      });
      expect(cleanupCalls).toBe(0);
    }),
  );

  it("materializes typed failures and redacts system failure details", () => {
    const declared = {
      _tag: "DeliveryRejected" as const,
      operation: "slots.respond",
      message: "The response is no longer available",
      recoveryRequired: true,
    };
    expect(materializeSlotWorkflowFailure(SlotSheetWorkflows[0]!, Cause.fail(declared))).toEqual({
      _tag: "Declared",
      error: declared,
    });
    expect(
      materializeSlotWorkflowFailure(
        SlotSheetWorkflows[0]!,
        Cause.die("postgres://secret@internal/slot-state"),
      ),
    ).toEqual({ _tag: "System", code: "UnexpectedFailure", retryable: false });
  });
});
