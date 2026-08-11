import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import { BotResponseExpired, ResponseReference, type SheetBotHttpClient } from "sheet-bot-api";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { InteractiveDeclaredFailure, SlotsPublishButton } from "sheet-workflow-contracts";
import { ZeroClient } from "typhoon-zero/client";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  makeSheetApisClient,
  makeTrustedSheetPersistenceMock,
  normalizePayloadText,
} from "@/services/testHelpers";
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
  const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
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

const baseSlotState = () => makeTrustedSheetPersistenceMock(makeSheetApisClient({})).slotState;

describe("slot-button publishing Workflow Definition slice", () => {
  it("registers the single pinned definition with the four approved Durable Actions", () => {
    expect(SlotSheetWorkflowContracts).toEqual([SlotsPublishButton]);
    expect(
      SlotSheetWorkflowDefinitions.map(({ contract, workflow }) => ({
        contract: workflowContractKey(contract),
        workflow: workflow.name,
      })),
    ).toEqual([
      {
        contract: workflowContractKey(SlotsPublishButton),
        workflow: workflowContractKey(SlotsPublishButton),
      },
    ]);
    expect(SlotSheetWorkflowDefinitions[0]!.actions.map(({ workflow }) => workflow.name)).toEqual([
      "slots.publishButton.publish-button",
      "slots.publishButton.bind-slot-state",
      "slots.publishButton.delete-provisional-button",
      "slots.publishButton.respond",
    ]);
    expect(SlotSheetWorkflowRegistrations[0]?.definitionVersion).toBe("1");
    expect(SlotSheetWorkflowDefinitions[0]?.contract.declaredFailure).toBe(
      InteractiveDeclaredFailure,
    );
    expect(isSlotSheetWorkflowName(SlotSheetWorkflows[0]!.name)).toBe(true);
    expect(isSlotSheetWorkflowName("slots.open")).toBe(false);
  });

  it.effect("uses deterministic Action Keys and operation-specific Delivery Keys", () =>
    Effect.gen(function* () {
      const payload = {
        invocationId,
        principal,
        input,
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
      expect(new Set(actionIds).size).toBe(4);
      const keys = [
        makeSlotDeliveryKey(SlotsPublishButton, invocationId, "publish-button"),
        makeSlotDeliveryKey(SlotsPublishButton, invocationId, "delete-provisional-button"),
        makeSlotDeliveryKey(SlotsPublishButton, invocationId, "respond"),
      ];
      expect(new Set(keys).size).toBe(3);
      expect(makeSlotDeliveryKey(SlotsPublishButton, invocationId, "publish-button")).toBe(
        `slots.publishButton:1:${invocationId}:publish-button`,
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

  it.effect("requests deterministic cleanup only after a definite pre-commit bind failure", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const slotState: TrustedSheetPersistence["Service"]["slotState"] = {
        getMessageSlotData: () => Effect.succeed(Option.none()),
        upsertMessageSlotData: () =>
          Effect.fail(
            new ZeroClient.ZeroClientExecutorError({
              operation: "upsert slot state",
              message: "definite bind failure",
            }),
          ),
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
        publish: () => {
          calls.push("publish-button");
          return Effect.succeed({ creatorAccountId: accountId, published });
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
        respond: () => {
          calls.push("respond");
          return Effect.die("response must not run after a pre-commit bind failure");
        },
      });

      const exit = yield* Effect.exit(workflowBody({ invocationId, principal, input }));
      expect(calls).toEqual(["publish-button", "bind-slot-state", "delete-provisional-button"]);
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
