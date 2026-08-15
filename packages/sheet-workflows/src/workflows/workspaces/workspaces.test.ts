import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  WorkflowInvocationUnauthorized,
  WorkflowTransportUnavailable,
} from "effect-zero-workflow/contract/transport";
import {
  BotCollectionCursor,
  type BotConversationPage,
  BotDependencyUnavailable,
  BotRequestRejected,
  BotResourceNotFound,
  DeliveryKey,
  type SendMessageReceipt,
  type SheetBotHttpClient,
  conversationRefFrom,
  messageRefFrom,
} from "sheet-bot-api";
import { EffectivePrincipal, ServicePrincipal } from "sheet-auth/identity";
import { AutonomousDeclaredFailure, WorkspacesDeliverWelcome } from "sheet-workflow-contracts";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  makeSheetApisClient,
  makeTrustedSheetPersistenceMock,
  normalizePayloadText,
} from "@/services/testHelpers";
import {
  ReadOnlyWorkflowAuthorization,
  readOnlyWorkflowAuthorizationLayer,
} from "../readOnly/authorization";
import { workflowTestInvocationId as invocationId } from "../shared/testHelpers";
import {
  executeDeliverWorkspaceWelcomeAction,
  executeSelectWelcomeConversationAction,
  makeWorkspacesDeliverWelcomeDefinition,
  makeWorkspacesDeliverWelcomeWorkflowBody,
  makeWorkspaceWelcomeMessage,
} from "./definition";
import {
  makeWorkspaceWelcomeDeliveryKey,
  makeWorkspaceWelcomeInvocationId,
  makeWorkspaceWelcomeSerializationKey,
} from "./keys";
import {
  selectWorkspaceWelcomeConversation,
  workspaceWelcomeWorkflowOperationsLayer,
} from "./operations";
import { WorkspaceSheetWorkflowRegistrations } from "./registry";
import { WorkspaceWelcomeWorkflowOperations } from "./service";

const input = Schema.decodeUnknownSync(WorkspacesDeliverWelcome.input)({
  workspaceId: "workspace-1",
  workspaceName: "Guild One",
  joinedAt: "2026-08-14T10:00:00.000Z",
  systemConversationId: "system-conversation",
});
const principal = Schema.decodeUnknownSync(ServicePrincipal)({
  kind: "service",
  serviceId: "sheet-bot.gateway",
  oauthClientId: "sheet-bot-client",
});
const context = { ownerKey: "service:sheet-bot.gateway", principal };
const actorProvenance = { actorServiceId: principal.serviceId, jobKind: "guild-create" };
const client = { platform: "discord" as const, clientId: "discord-main" };
const conversation = conversationRefFrom(client, input.workspaceId, "system-conversation");
const deliveryKey = makeWorkspaceWelcomeDeliveryKey(invocationId);
const receipt = {
  deliveryKey,
  operation: "sendMessage" as const,
  target: {
    _tag: "Message" as const,
    message: messageRefFrom(
      client,
      input.workspaceId,
      conversation.conversationId,
      "welcome-message",
    ),
  },
};
const nextCursor = Schema.decodeUnknownSync(BotCollectionCursor)("next-page");

type BotOverrides = {
  readonly listConversations?: (
    request: Parameters<SheetBotHttpClient["cache"]["listConversations"]>[0],
  ) => Effect.Effect<BotConversationPage, unknown>;
  readonly sendMessage?: (
    request: Parameters<SheetBotHttpClient["delivery"]["sendMessage"]>[0],
  ) => Effect.Effect<SendMessageReceipt, unknown>;
};

const makeBot = (overrides: BotOverrides): SheetBotHttpClient =>
  ({
    cache: {
      listConversations:
        overrides.listConversations ?? (() => Effect.die("unexpected conversation read")),
    },
    delivery: {
      sendMessage: overrides.sendMessage ?? (() => Effect.die("unexpected welcome delivery")),
    },
  }) as unknown as SheetBotHttpClient;

const makeOperations = (bot: SheetBotHttpClient, config: Record<string, unknown> = {}) =>
  WorkspaceWelcomeWorkflowOperations.pipe(
    Effect.provide(workspaceWelcomeWorkflowOperationsLayer),
    Effect.provideService(SheetBotCacheClient, { get: () => bot }),
    Effect.provideService(SheetBotDeliveryClient, { get: () => bot }),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
  );

const assertReceiptTargetRejected = (forgedReceipt: SendMessageReceipt) =>
  Effect.gen(function* () {
    const operations = yield* makeOperations(
      makeBot({ sendMessage: () => Effect.succeed(forgedReceipt) }),
    );
    const exit = yield* Effect.exit(
      operations.deliverWelcome(
        input,
        conversation,
        makeWorkspaceWelcomeMessage(),
        deliveryKey,
        WorkspacesDeliverWelcome.authorizationPolicy.policy,
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
        _tag: "WorkspaceWelcomeWorkflowOperationsError",
        operation: "workspaces.deliverWelcome.deliver-workspace-welcome",
        cause: "The bot returned a delivery receipt for a different welcome target",
      });
    }
  });

const authorizationProgram = <A, E>(
  use: (
    authorization: ReadOnlyWorkflowAuthorization["Service"],
  ) => Effect.Effect<A, E, ReadOnlyWorkflowAuthorization>,
  environment: Record<string, unknown>,
) => {
  const bot = makeBot({});
  const persistence = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
  return Effect.gen(function* () {
    return yield* use(yield* ReadOnlyWorkflowAuthorization);
  }).pipe(
    Effect.provide(readOnlyWorkflowAuthorizationLayer),
    Effect.provide(Layer.succeed(SheetBotCacheClient, { get: () => bot })),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
  );
};

const gatewayEnvironment = {
  SHEET_BOT_GATEWAY_SERVICE_ID: principal.serviceId,
  SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: principal.oauthClientId,
};
const definition = makeWorkspacesDeliverWelcomeDefinition();
const registration = WorkspaceSheetWorkflowRegistrations[0]!;

describe("workspace-welcome Workflow Definition slice", () => {
  it("registers the pinned autonomous v1 two-action graph", () => {
    expect(definition.contract).toBe(WorkspacesDeliverWelcome);
    expect(definition.workflow.name).toBe(workflowContractKey(WorkspacesDeliverWelcome));
    expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
      ["workspaces.deliverWelcome.select-welcome-conversation", "1"],
      ["workspaces.deliverWelcome.deliver-workspace-welcome", "1"],
    ]);
    expect(WorkspacesDeliverWelcome.declaredFailure).toBe(AutonomousDeclaredFailure);
    expect(WorkspaceSheetWorkflowRegistrations).toHaveLength(2);
    expect(registration.definitionVersion).toBe("1");
    expect(WorkspacesDeliverWelcome.authorizationPolicy).toMatchObject({
      version: "1",
      principalKinds: ["service"],
      requiredCapabilities: ["service.allowed"],
      resource: "workspace",
      resourceField: "workspaceId",
      serviceRule: "sheet-bot.gateway",
      revalidateBeforeEffects: true,
    });
  });

  it.effect("durably fixes one selected conversation and returns exactly one receipt", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const body = makeWorkspacesDeliverWelcomeWorkflowBody({
        select: () => {
          calls.push("select");
          return Effect.succeed(conversation);
        },
        deliver: (execution) => {
          calls.push({ conversation: execution.conversation, message: execution.message });
          return Effect.succeed(receipt);
        },
      });
      expect(yield* body({ invocationId, principal, actorProvenance, input })).toEqual({
        workspaceId: input.workspaceId,
        conversationId: conversation.conversationId,
        messageId: "welcome-message",
        deliveryReceipts: [receipt],
      });
      expect(calls).toEqual(["select", { conversation, message: makeWorkspaceWelcomeMessage() }]);
    }),
  );

  it("renders the exact legacy welcome with mentions disabled", () => {
    expect(normalizePayloadText(makeWorkspaceWelcomeMessage())).toEqual({
      embeds: [
        {
          title: "Thanks for adding Tiara",
          description:
            "I help manage and monitor Project SEKAI tiering runs: schedules, check-ins, slots, room order, and run status from your team's Google Sheet.",
          color: 0x5865f2,
          fields: [
            {
              name: "Google Sheet adapter required",
              value:
                "This bot needs a compatible Google Sheet adapter before it can do useful work. For now, message @394295776655966219 (Theerie) to get one.",
            },
            {
              name: "Run your own bot",
              value:
                "If you would rather not give the hosted bot your sheet ID, you can run your own bot from https://github.com/tiara-stack/tiara-stack with the Docker Compose file or Helm chart.",
            },
            {
              name: "Self-hosting requirements",
              value:
                "You will need a client application and bot token, a Google Cloud service account with Sheets access, Postgres, Redis, and either Docker Compose or a Kubernetes cluster. Optional pieces include Infisical for secret sync and an OTLP endpoint for traces/metrics.",
            },
          ],
          footer: { text: "happy mana/moniing~" },
        },
      ],
      allowedMentions: "none",
    });
  });

  it("preserves every deterministic ranking and fallback case", () => {
    const candidates = [
      { id: "voice", type: 2, name: "general", position: 0 },
      { id: "late", type: 0, name: "late", position: 10 },
      { id: "general-late", type: 0, name: "general", position: 40 },
      { id: "general", type: 5, name: "GeNeRaL", position: 20 },
      { id: "system", type: 0, name: "welcome", position: 30 },
      { id: "a", type: 0, name: "a", position: 1 },
      { id: "b", type: 0, name: "b", position: 1 },
    ];
    expect(selectWorkspaceWelcomeConversation(candidates, "system")?.id).toBe("system");
    expect(selectWorkspaceWelcomeConversation(candidates, "missing")?.id).toBe("general");
    expect(
      selectWorkspaceWelcomeConversation(
        candidates.filter(({ id }) => !["general", "general-late"].includes(id)),
        "voice",
      )?.id,
    ).toBe("a");
    expect(
      selectWorkspaceWelcomeConversation(
        candidates.filter(({ id }) => !["general", "general-late", "a"].includes(id)),
        undefined,
      )?.id,
    ).toBe("b");
    expect(
      selectWorkspaceWelcomeConversation(
        [
          { id: "missing-position", type: 0 },
          { id: "positioned", type: 5, position: 99 },
        ],
        undefined,
      )?.id,
    ).toBe("positioned");
    expect(
      selectWorkspaceWelcomeConversation([{ id: "voice", type: 2 }], undefined),
    ).toBeUndefined();
  });

  it.effect("follows bounded pages to exhaustion using only configured client and workspace", () =>
    Effect.gen(function* () {
      const requests: Array<Parameters<SheetBotHttpClient["cache"]["listConversations"]>[0]> = [];
      const operations = yield* makeOperations(
        makeBot({
          listConversations: (request) => {
            requests.push(request);
            return Effect.succeed(
              requests.length === 1
                ? {
                    items: [{ id: "first", type: 0, name: "first", position: 1 }],
                    nextCursor,
                  }
                : {
                    items: [
                      {
                        id: "system-conversation",
                        type: 5,
                        workspaceId: input.workspaceId,
                        name: "welcome",
                        position: 50,
                      },
                    ],
                  },
            );
          },
        }),
      );
      expect(
        yield* operations.selectConversation(
          input,
          WorkspacesDeliverWelcome.authorizationPolicy.policy,
        ),
      ).toEqual(conversation);
      expect(requests).toEqual([
        {
          params: { ...client, workspaceId: input.workspaceId },
          query: { limit: 100 },
        },
        {
          params: { ...client, workspaceId: input.workspaceId },
          query: { limit: 100, cursor: nextCursor },
        },
      ]);
    }),
  );

  it.effect("maps a conversation-list timeout to the select operation", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations(makeBot({ listConversations: () => Effect.never }));
      const fiber = yield* operations
        .selectConversation(input, WorkspacesDeliverWelcome.authorizationPolicy.policy)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("30 seconds");
      const exit = yield* Effect.exit(Fiber.join(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "WorkspaceWelcomeWorkflowOperationsError",
          operation: "workspaces.deliverWelcome.select-welcome-conversation",
        });
      }
    }),
  );

  it.effect("fails closed for cursor cycles and inconsistent cache pages", () =>
    Effect.gen(function* () {
      for (const pages of [
        [
          {
            items: Array.from({ length: 101 }, (_, index) => ({
              id: `oversized-${index}`,
              type: 0,
            })),
          },
        ],
        [
          { items: [{ id: "one", type: 0 }], nextCursor },
          { items: [{ id: "two", type: 0 }], nextCursor },
        ],
        [{ items: [{ id: "same", type: 0 }], nextCursor }, { items: [{ id: "same", type: 0 }] }],
        [{ items: [{ id: "foreign", type: 0, workspaceId: "workspace-2" }] }],
      ]) {
        let page = 0;
        const operations = yield* makeOperations(
          makeBot({
            listConversations: () => Effect.succeed(pages[page++]!),
          }),
        );
        expect(
          yield* Effect.flip(
            operations.selectConversation(
              { ...input, systemConversationId: undefined },
              WorkspacesDeliverWelcome.authorizationPolicy.policy,
            ),
          ),
        ).toMatchObject({
          _tag: "WorkspaceWelcomeWorkflowOperationsError",
          operation: "workspaces.deliverWelcome.select-welcome-conversation",
        });
      }
    }),
  );

  it.effect("fails closed when distinct conversation cursors exceed the workspace ceiling", () =>
    Effect.gen(function* () {
      let pageCount = 0;
      const operations = yield* makeOperations(
        makeBot({
          listConversations: () => {
            pageCount += 1;
            return Effect.succeed({
              items: [],
              nextCursor: Schema.decodeUnknownSync(BotCollectionCursor)(`page-${pageCount}`),
            });
          },
        }),
      );

      expect(
        yield* Effect.flip(
          operations.selectConversation(
            { ...input, systemConversationId: undefined },
            WorkspacesDeliverWelcome.authorizationPolicy.policy,
          ),
        ),
      ).toMatchObject({
        _tag: "WorkspaceWelcomeWorkflowOperationsError",
        operation: "workspaces.deliverWelcome.select-welcome-conversation",
        cause: "The bot cache returned too many conversation pages",
      });
      expect(pageCount).toBe(15);
    }),
  );

  it.effect("materializes no sendable conversation as a typed pre-commit failure", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations(
        makeBot({
          listConversations: () =>
            Effect.succeed({ items: [{ id: "voice", type: 2, name: "general" }] }),
        }),
      );
      expect(
        yield* Effect.flip(
          operations.selectConversation(input, WorkspacesDeliverWelcome.authorizationPolicy.policy),
        ),
      ).toEqual({ _tag: "ResourceNotFound", resource: "sendable workspace conversation" });
    }),
  );

  it.effect("admits only the exact configured gateway Effective Principal", () =>
    Effect.gen(function* () {
      yield* authorizationProgram(
        (authorization) => authorization.authorize(WorkspacesDeliverWelcome, principal, input),
        gatewayEnvironment,
      );
      const candidates = [
        Schema.decodeUnknownSync(EffectivePrincipal)({ kind: "user", userId: "user-1" }),
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "other-service",
          oauthClientId: principal.oauthClientId,
        }),
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: principal.serviceId,
          oauthClientId: "other-client",
        }),
      ];
      for (const candidate of candidates) {
        const exit = yield* Effect.exit(
          authorizationProgram(
            (authorization) => authorization.authorize(WorkspacesDeliverWelcome, candidate, input),
            gatewayEnvironment,
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "WorkflowInvocationUnauthorized",
          });
        }
      }
      const forgedInput = { ...input, workspaceId: undefined };
      const forgedExit = yield* Effect.exit(
        authorizationProgram(
          (authorization) =>
            authorization.authorize(WorkspacesDeliverWelcome, principal, forgedInput),
          gatewayEnvironment,
        ),
      );
      expect(Exit.isFailure(forgedExit)).toBe(true);
      if (Exit.isFailure(forgedExit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(forgedExit.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
        });
      }
    }),
  );

  it.effect("fails invalid gateway configuration at layer construction", () =>
    Effect.gen(function* () {
      const invalidConfiguration = yield* Effect.exit(
        authorizationProgram(() => Effect.void, {
          SHEET_BOT_GATEWAY_SERVICE_ID: principal.serviceId,
        }),
      );
      expect(Exit.isFailure(invalidConfiguration)).toBe(true);
      if (Exit.isFailure(invalidConfiguration)) {
        expect(Option.getOrThrow(Cause.findErrorOption(invalidConfiguration.cause))).toMatchObject({
          _tag: "ConfigError",
        });
      }
    }),
  );

  it.effect("keeps authorization dependency failure retryable and owner checks fail closed", () =>
    Effect.gen(function* () {
      const authorization = yield* authorizationProgram(
        (service) => Effect.succeed(service),
        gatewayEnvironment,
      );
      const unavailable = yield* Effect.flip(
        registration.authorize(context, input).pipe(
          Effect.provideService(ReadOnlyWorkflowAuthorization, {
            ...authorization,
            authorize: () =>
              Effect.fail(new BotDependencyUnavailable({ message: "cache unavailable" })),
          }),
        ),
      );
      expect(unavailable).toEqual(
        new WorkflowTransportUnavailable({
          operation: "Enqueue",
          retryable: true,
          message: "Workflow enqueue transport is unavailable",
        }),
      );
      const wrongOwner = yield* Effect.exit(
        authorizationProgram(
          (authorization) =>
            registration
              .authorizeObservation({ ...context, ownerKey: "service:forged" })
              .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization)),
          gatewayEnvironment,
        ),
      );
      expect(Exit.isFailure(wrongOwner)).toBe(true);
      if (Exit.isFailure(wrongOwner)) {
        expect(Option.getOrThrow(Cause.findErrorOption(wrongOwner.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
        });
      }
    }),
  );

  it.effect("reauthorizes before both actions and Actor Provenance grants no authority", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let allowed = true;
      const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
        authorize: (_contract, effectivePrincipal) => {
          calls.push("authorize");
          return allowed && effectivePrincipal === principal
            ? Effect.void
            : Effect.fail(new WorkflowInvocationUnauthorized({ message: "revoked" }));
        },
        authorizeSlotOpen: () => Effect.die("unused"),
        authorizeCheckinRespond: () => Effect.die("unused"),
        authorizeRoomOrdersNavigate: () => Effect.die("unused"),
        authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
        authorizeRoomOrdersSend: () => Effect.die("unused"),
        workspaceCapabilities: () => Effect.die("unused"),
      };
      const operations: WorkspaceWelcomeWorkflowOperations["Service"] = {
        selectConversation: () => {
          calls.push("select");
          return Effect.succeed(conversation);
        },
        deliverWelcome: () => {
          calls.push("deliver");
          return Effect.succeed(receipt);
        },
      };
      const services = Layer.mergeAll(
        Layer.succeed(ReadOnlyWorkflowAuthorization, authorization),
        Layer.succeed(WorkspaceWelcomeWorkflowOperations, operations),
      );
      yield* executeSelectWelcomeConversationAction({
        invocationId,
        principal,
        actorProvenance,
        input,
      }).pipe(Effect.provide(services));
      yield* executeDeliverWorkspaceWelcomeAction({
        invocationId,
        principal,
        actorProvenance,
        input,
        conversation,
        message: makeWorkspaceWelcomeMessage(),
      }).pipe(Effect.provide(services));
      expect(calls).toEqual(["authorize", "select", "authorize", "deliver"]);
      allowed = false;
      expect(
        yield* Effect.flip(
          executeDeliverWorkspaceWelcomeAction({
            invocationId,
            principal,
            actorProvenance,
            input,
            conversation,
            message: makeWorkspaceWelcomeMessage(),
          }).pipe(Effect.provide(services)),
        ),
      ).toEqual({
        _tag: "AuthorizationRevoked",
        policy: WorkspacesDeliverWelcome.authorizationPolicy.policy,
      });
      const forgedPrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "service",
        serviceId: "forged",
        oauthClientId: "forged",
      });
      expect(
        yield* Effect.flip(
          executeSelectWelcomeConversationAction({
            invocationId,
            principal: forgedPrincipal,
            actorProvenance,
            input,
          }).pipe(Effect.provide(services)),
        ),
      ).toMatchObject({ _tag: "AuthorizationRevoked" });
      expect(calls).toEqual([
        "authorize",
        "select",
        "authorize",
        "deliver",
        "authorize",
        "authorize",
      ]);
    }),
  );

  it.effect("uses stable invocation, Action, serialization, and Delivery identities", () =>
    Effect.gen(function* () {
      const base = { invocationId, principal, actorProvenance, input };
      const selectionId = yield* definition.actions[0]!.workflow.executionId(base);
      const deliveryId = yield* definition.actions[1]!.workflow.executionId({
        ...base,
        conversation,
        message: makeWorkspaceWelcomeMessage(),
      });
      expect(
        yield* definition.actions[1]!.workflow.executionId({
          ...base,
          conversation: conversationRefFrom(client, input.workspaceId, "changed"),
          message: { content: "changed" },
        }),
      ).toBe(deliveryId);
      expect(selectionId).not.toBe(deliveryId);
      expect(deliveryKey).toBe(
        `workspaces.deliverWelcome:1:${invocationId}:deliver-workspace-welcome`,
      );
      const stableInvocation = makeWorkspaceWelcomeInvocationId(
        client.clientId,
        input.workspaceId,
        input.joinedAt,
      );
      expect(
        makeWorkspaceWelcomeInvocationId(
          client.clientId,
          input.workspaceId,
          input.joinedAt.toISOString(),
        ),
      ).toBe(stableInvocation);
      expect(
        makeWorkspaceWelcomeInvocationId(
          client.clientId,
          input.workspaceId,
          "2026-08-14T10:01:00.000Z",
        ),
      ).not.toBe(stableInvocation);
      expect(
        makeWorkspaceWelcomeInvocationId("other-client", input.workspaceId, input.joinedAt),
      ).not.toBe(stableInvocation);
      expect(() =>
        makeWorkspaceWelcomeInvocationId(client.clientId, input.workspaceId, "not-a-date"),
      ).toThrow("joinedAt must be a valid date");
      expect(() =>
        makeWorkspaceWelcomeInvocationId(client.clientId, input.workspaceId, new Date(Number.NaN)),
      ).toThrow("joinedAt must be a valid date");
      expect(makeWorkspaceWelcomeSerializationKey(client.clientId, input.workspaceId)).toBe(
        '["discord","discord-main","workspace-1"]',
      );
      expect(makeWorkspaceWelcomeSerializationKey(client.clientId, "workspace-2")).not.toBe(
        makeWorkspaceWelcomeSerializationKey(client.clientId, input.workspaceId),
      );
    }),
  );

  it.effect("sends once to the durably selected configured-client conversation", () =>
    Effect.gen(function* () {
      const requests: Array<Parameters<SheetBotHttpClient["delivery"]["sendMessage"]>[0]> = [];
      const operations = yield* makeOperations(
        makeBot({
          sendMessage: (request) => {
            requests.push(request);
            return Effect.succeed(receipt);
          },
        }),
      );
      expect(
        yield* operations.deliverWelcome(
          input,
          conversation,
          makeWorkspaceWelcomeMessage(),
          deliveryKey,
          WorkspacesDeliverWelcome.authorizationPolicy.policy,
        ),
      ).toEqual(receipt);
      expect(requests).toEqual([
        {
          payload: {
            conversation,
            deliveryKey,
            message: makeWorkspaceWelcomeMessage(),
          },
        },
      ]);

      const foreignConversation = conversationRefFrom(client, "workspace-2", "general");
      expect(
        yield* Effect.flip(
          operations.deliverWelcome(
            input,
            foreignConversation,
            makeWorkspaceWelcomeMessage(),
            deliveryKey,
            WorkspacesDeliverWelcome.authorizationPolicy.policy,
          ),
        ),
      ).toMatchObject({ _tag: "InvalidRequest", code: "ConversationWorkspaceMismatch" });
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect("rejects a delivery receipt with a different delivery key", () =>
    assertReceiptTargetRejected({
      ...receipt,
      deliveryKey: Schema.decodeUnknownSync(DeliveryKey)("forged-delivery-key"),
    }),
  );

  it.effect("rejects a delivery receipt with a different message target", () =>
    assertReceiptTargetRejected({
      ...receipt,
      target: {
        _tag: "Message" as const,
        message: messageRefFrom(client, input.workspaceId, "forged-conversation", "forged-message"),
      },
    }),
  );

  it.effect("maps a message-delivery timeout to the delivery operation", () =>
    Effect.gen(function* () {
      const operations = yield* makeOperations(makeBot({ sendMessage: () => Effect.never }));
      const fiber = yield* operations
        .deliverWelcome(
          input,
          conversation,
          makeWorkspaceWelcomeMessage(),
          deliveryKey,
          WorkspacesDeliverWelcome.authorizationPolicy.policy,
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("30 seconds");
      const exit = yield* Effect.exit(Fiber.join(fiber));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "WorkspaceWelcomeWorkflowOperationsError",
          operation: "workspaces.deliverWelcome.deliver-workspace-welcome",
        });
      }
    }),
  );

  it.effect("reconciles ambiguity by Delivery Key and materializes definitive rejection", () =>
    Effect.gen(function* () {
      const keys: Array<typeof DeliveryKey.Type> = [];
      let attempt = 0;
      const operations = yield* makeOperations(
        makeBot({
          sendMessage: ({ payload }) => {
            keys.push(payload.deliveryKey);
            attempt += 1;
            return attempt === 1
              ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous" }))
              : Effect.succeed(receipt);
          },
        }),
      );
      const deliver = () =>
        operations.deliverWelcome(
          input,
          conversation,
          makeWorkspaceWelcomeMessage(),
          deliveryKey,
          WorkspacesDeliverWelcome.authorizationPolicy.policy,
        );
      expect(yield* Effect.flip(deliver())).toMatchObject({
        _tag: "WorkspaceWelcomeWorkflowOperationsError",
        cause: { _tag: "BotDependencyUnavailable" },
      });
      expect(yield* deliver()).toEqual(receipt);
      expect(keys).toEqual([deliveryKey, deliveryKey]);

      for (const error of [
        new BotRequestRejected({ message: "definitive" }),
        new BotResourceNotFound({ resource: "conversation", message: "missing" }),
      ]) {
        const rejecting = yield* makeOperations(makeBot({ sendMessage: () => Effect.fail(error) }));
        expect(
          yield* Effect.flip(
            rejecting.deliverWelcome(
              input,
              conversation,
              makeWorkspaceWelcomeMessage(),
              deliveryKey,
              WorkspacesDeliverWelcome.authorizationPolicy.policy,
            ),
          ),
        ).toEqual({
          _tag: "DeliveryRejected",
          operation: "workspaces.deliverWelcome.deliver-workspace-welcome",
          message: "The workspace welcome message was rejected",
          recoveryRequired: false,
        });
      }
    }),
  );

  it.effect("never selects or falls back again after the first delivery attempt", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const body = makeWorkspacesDeliverWelcomeWorkflowBody({
        select: () => Effect.sync(() => (calls.push("select"), conversation)),
        deliver: () =>
          Effect.sync(() => calls.push("deliver")).pipe(
            Effect.andThen(Effect.fail(new BotDependencyUnavailable({ message: "ambiguous" }))),
          ),
      });
      const exit = yield* Effect.exit(body({ invocationId, principal, input }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual(["select", "deliver"]);
    }),
  );
});
