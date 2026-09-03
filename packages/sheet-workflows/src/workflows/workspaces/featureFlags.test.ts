import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";
import { Entity, ShardingConfig } from "effect/unstable/cluster";
import { InvocationId, workflowContractKey } from "effect-zero-workflow/contract";
import { WorkflowInvocationUnauthorized } from "effect-zero-workflow/contract/transport";
import {
  type BotApplication,
  BotCollectionCursor,
  type BotConversationPage,
  BotDependencyUnavailable,
  type BotMember,
  BotRequestRejected,
  type BotRoles,
  type BotWorkspace,
  DeliveryKey,
  ResponseReference,
  type RespondReceipt,
  type SendMessageReceipt,
  type SheetBotHttpClient,
  conversationRefFrom,
  messageRefFrom,
} from "sheet-bot-api";
import { ActorProvenance, EffectivePrincipal, ServicePrincipal } from "sheet-auth/identity";
import {
  InteractiveDeclaredFailure,
  WorkspacesDeliverWelcome,
  WorkspacesFeatureFlagsSetAndDeliver,
} from "sheet-workflow-contracts";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  makeWorkspaceFeatureFlagEntityLayer,
  WorkspaceFeatureFlagEntity,
} from "@/entities/workspaceFeatureFlag";
import { ZeroApiError } from "typhoon-zero/zeroApi";
import { makeTrustedSheetPersistenceMock, normalizePayloadText } from "@/services/testHelpers";
import {
  ReadOnlyWorkflowAuthorization,
  readOnlyWorkflowAuthorizationLayer,
} from "../readOnly/authorization";
import { workflowTestInvocationId as invocationId } from "../shared/testHelpers";
import {
  executeDeliverFeatureFlagAnnouncementAction,
  executeDeliverFeatureFlagResponseAction,
  executeSelectFeatureFlagAnnouncementConversationAction,
  executeSetWorkspaceFeatureFlagAction,
  makeWorkspaceFeatureFlagMessage,
  makeWorkspacesFeatureFlagsSetAndDeliverDefinition,
  makeWorkspacesFeatureFlagsSetAndDeliverWorkflowBody,
} from "./featureFlagDefinition";
import { workspaceFeatureFlagWorkflowOperationsLayer } from "./featureFlagOperations";
import type { WorkspaceFeatureFlagState } from "./featureFlagSchema";
import { WorkspaceFeatureFlagWorkflowOperations } from "./featureFlagService";
import {
  makeWorkspaceFeatureFlagCommittedReference,
  makeWorkspaceFeatureFlagDeliveryKey,
  makeWorkspaceFeatureFlagSerializationKey,
  normalizeWorkspaceFeatureFlagName,
} from "./keys";
import { WorkspaceSheetWorkflowContracts } from "./catalog";
import { WorkspaceSheetWorkflowRegistrations } from "./registry";

const client = { platform: "discord" as const, clientId: "discord-main" };
const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100,
});
const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const announcementInput = Schema.decodeUnknownSync(WorkspacesFeatureFlagsSetAndDeliver.input)({
  workspaceId: "workspace-1",
  flagName: "feature`one\\two",
  enabled: true,
  systemConversationId: "system-conversation",
});
const responseInput = Schema.decodeUnknownSync(WorkspacesFeatureFlagsSetAndDeliver.input)({
  ...announcementInput,
  responseReference,
});
const servicePrincipal = Schema.decodeUnknownSync(ServicePrincipal)({
  kind: "service",
  serviceId: "sheet-bot.gateway",
  oauthClientId: "sheet-bot-client",
});
const userPrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "user",
  userId: "user-1",
  discordAccount: { accountId: "discord-user-1" },
});
const actorProvenance = Schema.decodeUnknownSync(ActorProvenance)({
  actorServiceId: "audit-only",
  jobKind: "feature-flag",
});
const conversation = conversationRefFrom(
  client,
  announcementInput.workspaceId,
  "system-conversation",
);
const responseDeliveryKey = makeWorkspaceFeatureFlagDeliveryKey(
  invocationId,
  "deliver-feature-flag-response",
);
const announcementDeliveryKey = makeWorkspaceFeatureFlagDeliveryKey(
  invocationId,
  "deliver-feature-flag-announcement",
);
const state: WorkspaceFeatureFlagState = {
  workspaceId: announcementInput.workspaceId,
  flagName: announcementInput.flagName,
  enabled: true,
  committedReference: makeWorkspaceFeatureFlagCommittedReference(
    client.clientId,
    announcementInput.workspaceId,
    announcementInput.flagName,
  ),
};
const responseReceipt: RespondReceipt = {
  deliveryKey: responseDeliveryKey,
  operation: "respond",
  target: { _tag: "Response", responseReference },
};
const announcementReceipt: SendMessageReceipt = {
  deliveryKey: announcementDeliveryKey,
  operation: "sendMessage",
  target: {
    _tag: "Message",
    message: messageRefFrom(
      client,
      announcementInput.workspaceId,
      conversation.conversationId,
      "announcement-message",
    ),
  },
};

type BotOverrides = {
  readonly listConversations?: (
    request: Parameters<SheetBotHttpClient["cache"]["listConversations"]>[0],
  ) => Effect.Effect<BotConversationPage, unknown>;
  readonly respond?: (
    request: Parameters<SheetBotHttpClient["delivery"]["respond"]>[0],
  ) => Effect.Effect<RespondReceipt, unknown>;
  readonly sendMessage?: (
    request: Parameters<SheetBotHttpClient["delivery"]["sendMessage"]>[0],
  ) => Effect.Effect<SendMessageReceipt, unknown>;
  readonly getApplication?: (
    request: Parameters<SheetBotHttpClient["cache"]["getApplication"]>[0],
  ) => Effect.Effect<BotApplication, unknown>;
  readonly getMember?: (
    request: Parameters<SheetBotHttpClient["cache"]["getMember"]>[0],
  ) => Effect.Effect<BotMember, unknown>;
  readonly listRoles?: (
    request: Parameters<SheetBotHttpClient["cache"]["listRoles"]>[0],
  ) => Effect.Effect<BotRoles, unknown>;
  readonly getWorkspace?: (
    request: Parameters<SheetBotHttpClient["cache"]["getWorkspace"]>[0],
  ) => Effect.Effect<BotWorkspace, unknown>;
};

const makeBot = (overrides: BotOverrides = {}): SheetBotHttpClient =>
  ({
    cache: {
      listConversations:
        overrides.listConversations ?? (() => Effect.die("unexpected conversation read")),
      getApplication:
        overrides.getApplication ?? (() => Effect.succeed({ ownerId: "application-owner" })),
      getMember:
        overrides.getMember ??
        (() => Effect.succeed({ userId: "discord-user-1", roleIds: ["manager"] })),
      listRoles:
        overrides.listRoles ??
        (() =>
          Effect.succeed([
            {
              id: "manager",
              name: "Manager",
              color: 0,
              permissions: "32",
              position: 1,
              managed: false,
            },
          ])),
      getWorkspace:
        overrides.getWorkspace ??
        (() =>
          Effect.succeed({
            id: "workspace-1",
            name: "Workspace One",
            icon: null,
            ownerId: "workspace-owner",
          })),
    },
    delivery: {
      respond: overrides.respond ?? (() => Effect.die("unexpected response delivery")),
      sendMessage: overrides.sendMessage ?? (() => Effect.die("unexpected announcement delivery")),
    },
  }) as unknown as SheetBotHttpClient;

const basePersistence = () => makeTrustedSheetPersistenceMock() as TrustedSheetPersistenceShape;

const makeOperations = (
  workspaces: TrustedSheetPersistenceShape["workspaces"],
  bot: SheetBotHttpClient,
) =>
  WorkspaceFeatureFlagWorkflowOperations.pipe(
    Effect.provide(workspaceFeatureFlagWorkflowOperationsLayer),
    Effect.provideService(TrustedSheetPersistence, { ...basePersistence(), workspaces }),
    Effect.provideService(SheetBotCacheClient, { get: () => bot }),
    Effect.provideService(SheetBotDeliveryClient, { get: () => bot }),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: client.clientId })),
    ),
  );

const featureFlagRow = (flagName = announcementInput.flagName) => ({
  workspaceId: announcementInput.workspaceId,
  flagName,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
});

const definition = makeWorkspacesFeatureFlagsSetAndDeliverDefinition();
const registration = Option.getOrThrow(
  Option.fromNullishOr(
    WorkspaceSheetWorkflowRegistrations.find(({ contract }) => contract === definition.contract),
  ),
);

describe("workspace feature-flag Workflow Definition slice", () => {
  it.effect("registers one pinned v1 four-action graph with stable identities", () =>
    Effect.gen(function* () {
      expect(WorkspaceSheetWorkflowContracts).toEqual([
        WorkspacesDeliverWelcome,
        WorkspacesFeatureFlagsSetAndDeliver,
      ]);
      expect(definition.contract).toBe(WorkspacesFeatureFlagsSetAndDeliver);
      expect(definition.workflow.name).toBe(
        workflowContractKey(WorkspacesFeatureFlagsSetAndDeliver),
      );
      expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
        ["workspaces.featureFlags.setAndDeliver.set-workspace-feature-flag", "1"],
        [
          "workspaces.featureFlags.setAndDeliver.select-feature-flag-announcement-conversation",
          "1",
        ],
        ["workspaces.featureFlags.setAndDeliver.deliver-feature-flag-response", "1"],
        ["workspaces.featureFlags.setAndDeliver.deliver-feature-flag-announcement", "1"],
      ]);
      expect(definition.contract.declaredFailure).toBe(InteractiveDeclaredFailure);
      expect(WorkspaceSheetWorkflowRegistrations).toHaveLength(2);
      expect(registration.definitionVersion).toBe("1");
      expect(WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy).toMatchObject({
        version: "1",
        principalKinds: ["user", "service"],
        requiredCapabilities: ["workspace.manage"],
        resource: "workspace",
        resourceField: "workspaceId",
        serviceRule: "sheet-bot.gateway",
        revalidateBeforeEffects: true,
      });

      const execution = {
        invocationId,
        principal: servicePrincipal,
        actorProvenance,
        input: announcementInput,
      };
      const message = makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled);
      const actionIds = [
        yield* definition.actions[0]!.workflow.executionId(execution),
        yield* definition.actions[1]!.workflow.executionId({ ...execution, state }),
        yield* definition.actions[2]!.workflow.executionId({
          ...execution,
          input: responseInput,
          state,
          message,
        }),
        yield* definition.actions[3]!.workflow.executionId({
          ...execution,
          state,
          message,
          conversation,
        }),
      ];
      expect(new Set(actionIds).size).toBe(4);
      expect(yield* definition.actions[0]!.workflow.executionId(execution)).toBe(actionIds[0]);
      expect(
        yield* definition.actions[3]!.workflow.executionId({
          ...execution,
          state,
          message,
          conversation: conversationRefFrom(client, announcementInput.workspaceId, "changed"),
        }),
      ).toBe(actionIds[3]);
      expect(responseDeliveryKey).not.toBe(announcementDeliveryKey);
      expect(
        makeWorkspaceFeatureFlagDeliveryKey(invocationId, "deliver-feature-flag-announcement"),
      ).toBe(announcementDeliveryKey);
    }),
  );

  it("normalizes names, rejects empty names, and renders exact legacy messages", () => {
    expect(announcementInput.flagName).toBe("feature`one\\two");
    expect(normalizeWorkspaceFeatureFlagName("  alpha  ")).toBe("alpha");
    expect(() => normalizeWorkspaceFeatureFlagName("   ")).toThrow();
    expect(
      makeWorkspaceFeatureFlagSerializationKey(
        client.clientId,
        announcementInput.workspaceId,
        " alpha ",
      ),
    ).toBe('["discord","discord-main","workspace-1","alpha"]');
    expect(
      normalizePayloadText(makeWorkspaceFeatureFlagMessage(announcementInput.flagName, true)),
    ).toEqual({
      embeds: [
        {
          title: "Feature flag enabled",
          description: "This server has been enlisted for `feature\\`one\\\\two`.",
          color: 0x57f287,
        },
      ],
      allowedMentions: "none",
    });
    expect(
      normalizePayloadText(makeWorkspaceFeatureFlagMessage(announcementInput.flagName, false)),
    ).toEqual({
      embeds: [
        {
          title: "Feature flag disabled",
          description: "This server has been delisted from `feature\\`one\\\\two`.",
          color: 0xed4245,
        },
      ],
      allowedMentions: "none",
    });
  });

  it.live("serializes desired-state commits by canonical feature-flag identity", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<Array<string>>([]);
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const otherStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const releaseSecond = yield* Deferred.make<void>();
      const releaseOther = yield* Deferred.make<void>();
      let sameKeyCall = 0;
      const layer = makeWorkspaceFeatureFlagEntityLayer({
        set: ({ payload }) =>
          Effect.gen(function* () {
            const input = Schema.decodeUnknownSync(WorkspacesFeatureFlagsSetAndDeliver.input)(
              payload.input,
            );
            if (input.flagName === "other") {
              yield* Ref.update(events, (items) => [...items, "other:start"]);
              yield* Deferred.succeed(otherStarted, void 0);
              yield* Deferred.await(releaseOther);
              yield* Ref.update(events, (items) => [...items, "other:end"]);
              return { ...state, flagName: "other" };
            }
            sameKeyCall += 1;
            const current = sameKeyCall;
            yield* Ref.update(events, (items) => [...items, `${current}:start`]);
            if (current === 1) {
              yield* Deferred.succeed(firstStarted, void 0);
              yield* Deferred.await(releaseFirst);
            } else {
              yield* Deferred.succeed(secondStarted, void 0);
              yield* Deferred.await(releaseSecond);
            }
            yield* Ref.update(events, (items) => [...items, `${current}:end`]);
            return state;
          }),
      });
      const clientFor = yield* Entity.makeTestClient(WorkspaceFeatureFlagEntity, layer);
      const serialized = yield* clientFor(
        makeWorkspaceFeatureFlagSerializationKey(
          client.clientId,
          announcementInput.workspaceId,
          announcementInput.flagName,
        ),
      );
      const execution = {
        invocationId,
        principal: servicePrincipal,
        actorProvenance,
        input: announcementInput,
      };
      const first = yield* serialized.set(execution).pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const second = yield* serialized
        .set({
          ...execution,
          invocationId: Schema.decodeUnknownSync(InvocationId)(
            "22222222-2222-4222-8222-222222222222",
          ),
          input: { ...announcementInput, enabled: false },
        })
        .pipe(Effect.forkScoped);
      const unrelated = yield* clientFor(
        makeWorkspaceFeatureFlagSerializationKey(
          client.clientId,
          announcementInput.workspaceId,
          "other",
        ),
      );
      const other = yield* unrelated
        .set({ ...execution, input: { ...announcementInput, flagName: "other" } })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(otherStarted);
      expect(yield* Ref.get(events)).toEqual(["1:start", "other:start"]);
      yield* Deferred.succeed(releaseOther, void 0);
      yield* Fiber.join(other);
      yield* Deferred.succeed(releaseFirst, void 0);
      yield* Deferred.await(secondStarted);
      expect(yield* Ref.get(events)).toEqual([
        "1:start",
        "other:start",
        "other:end",
        "1:end",
        "2:start",
      ]);
      yield* Deferred.succeed(releaseSecond, void 0);
      yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
    }).pipe(Effect.provide(TestShardingConfig)),
  );

  it.effect("branches after the authoritative commit and preserves best-effort null outcomes", () =>
    Effect.gen(function* () {
      const responseCalls: Array<string> = [];
      const responseBody = makeWorkspacesFeatureFlagsSetAndDeliverWorkflowBody({
        set: () => Effect.sync(() => (responseCalls.push("set"), state)),
        select: () => Effect.die("response branch must not select"),
        respond: () => Effect.sync(() => (responseCalls.push("respond"), responseReceipt)),
        announce: () => Effect.die("response branch must not announce"),
      });
      expect(
        yield* responseBody({
          invocationId,
          principal: servicePrincipal,
          actorProvenance,
          input: responseInput,
        }),
      ).toEqual({
        workspaceId: state.workspaceId,
        flagName: state.flagName,
        enabled: true,
        announcementConversationId: null,
        announcementMessageId: null,
        deliveryReceipts: [responseReceipt],
      });
      expect(responseCalls).toEqual(["set", "respond"]);

      const announced = makeWorkspacesFeatureFlagsSetAndDeliverWorkflowBody({
        set: () => Effect.succeed(state),
        select: () => Effect.succeed(conversation),
        respond: () => Effect.die("announcement branch must not respond"),
        announce: () => Effect.succeed(announcementReceipt),
      });
      expect(
        yield* announced({ invocationId, principal: servicePrincipal, input: announcementInput }),
      ).toMatchObject({
        announcementConversationId: conversation.conversationId,
        announcementMessageId: "announcement-message",
        deliveryReceipts: [announcementReceipt],
      });

      for (const target of [null, conversation] as const) {
        const omitted = makeWorkspacesFeatureFlagsSetAndDeliverWorkflowBody({
          set: () => Effect.succeed(state),
          select: () => Effect.succeed(target),
          respond: () => Effect.die("unused"),
          announce: () => Effect.succeed(null),
        });
        expect(
          yield* omitted({ invocationId, principal: servicePrincipal, input: announcementInput }),
        ).toMatchObject({
          announcementConversationId: null,
          announcementMessageId: null,
          deliveryReceipts: [],
        });
      }
    }),
  );

  it.effect("idempotently enables, disables, revives, and reconciles ambiguous commits", () =>
    Effect.gen(function* () {
      let current = Option.none<ReturnType<typeof featureFlagRow>>();
      const mutations: Array<string> = [];
      let ambiguous = false;
      const base = basePersistence().workspaces;
      const workspaces: TrustedSheetPersistenceShape["workspaces"] = {
        ...base,
        getWorkspaceFeatureFlag: () => Effect.succeed(current),
        addWorkspaceFeatureFlag: () =>
          Effect.sync(() => {
            mutations.push("enable");
            current = Option.some(featureFlagRow());
          }).pipe(
            Effect.andThen(
              ambiguous
                ? Effect.fail(
                    new ZeroApiError.ZeroClientExecutorError({
                      operation: "mutate",
                      message: "ambiguous commit",
                    }),
                  )
                : Effect.void,
            ),
          ),
        removeWorkspaceFeatureFlag: () =>
          Effect.sync(() => {
            mutations.push("disable");
            current = Option.none();
          }),
      };
      const operations = yield* makeOperations(workspaces, makeBot());
      expect(yield* operations.setDesiredState(announcementInput)).toEqual(state);
      expect(yield* operations.setDesiredState(announcementInput)).toEqual(state);
      expect(mutations).toEqual(["enable"]);

      const legacyActiveRow = featureFlagRow();
      Reflect.deleteProperty(legacyActiveRow, "deletedAt");
      current = Option.some(legacyActiveRow);
      expect(yield* operations.setDesiredState(announcementInput)).toEqual(state);
      expect(mutations).toEqual(["enable"]);

      const disabledInput = { ...announcementInput, enabled: false };
      expect(yield* operations.setDesiredState(disabledInput)).toMatchObject({ enabled: false });
      expect(yield* operations.setDesiredState(disabledInput)).toMatchObject({ enabled: false });
      expect(mutations).toEqual(["enable", "disable"]);

      ambiguous = true;
      expect(yield* operations.setDesiredState(announcementInput)).toEqual(state);
      expect(mutations).toEqual(["enable", "disable", "enable"]);
    }),
  );

  it.effect("selects deterministically through bounded pages and treats no target as absence", () =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const cursor = Schema.decodeUnknownSync(BotCollectionCursor)("next");
      const operations = yield* makeOperations(
        basePersistence().workspaces,
        makeBot({
          listConversations: (request) => {
            requests.push(request);
            return Effect.succeed(
              requests.length === 1
                ? {
                    items: [{ id: "general", type: 0, name: "general", canSendMessages: true }],
                    nextCursor: cursor,
                  }
                : {
                    items: [
                      {
                        id: "system-conversation",
                        type: 5,
                        position: 99,
                        canSendMessages: true,
                      },
                    ],
                  },
            );
          },
        }),
      );
      expect(
        yield* operations.selectAnnouncementConversation(
          announcementInput,
          state,
          WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
        ),
      ).toEqual(conversation);
      expect(requests).toEqual([
        { params: { ...client, workspaceId: state.workspaceId }, query: { limit: 100 } },
        {
          params: { ...client, workspaceId: state.workspaceId },
          query: { limit: 100, cursor },
        },
      ]);

      const absent = yield* makeOperations(
        basePersistence().workspaces,
        makeBot({
          listConversations: () =>
            Effect.succeed({ items: [{ id: "voice", type: 2, canSendMessages: true }] }),
        }),
      );
      expect(
        yield* absent.selectAnnouncementConversation(
          announcementInput,
          state,
          WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
        ),
      ).toBeNull();
    }),
  );

  it.effect("reconciles both delivery branches by stable keys and preserves branch semantics", () =>
    Effect.gen(function* () {
      const responseKeys: Array<typeof DeliveryKey.Type> = [];
      let responseAttempt = 0;
      const responding = yield* makeOperations(
        basePersistence().workspaces,
        makeBot({
          respond: ({ payload }) => {
            responseKeys.push(payload.deliveryKey);
            responseAttempt += 1;
            return responseAttempt === 1
              ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous" }))
              : Effect.succeed(responseReceipt);
          },
        }),
      );
      const respond = () =>
        responding.respond(
          responseInput,
          state,
          makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled),
          responseDeliveryKey,
          WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
        );
      expect(yield* Effect.flip(respond())).toMatchObject({
        _tag: "WorkspaceFeatureFlagWorkflowOperationsError",
      });
      expect(yield* respond()).toEqual(responseReceipt);
      expect(responseKeys).toEqual([responseDeliveryKey, responseDeliveryKey]);

      const rejected = yield* makeOperations(
        basePersistence().workspaces,
        makeBot({ respond: () => Effect.fail(new BotRequestRejected({ message: "rejected" })) }),
      );
      expect(
        yield* Effect.flip(
          rejected.respond(
            responseInput,
            state,
            makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled),
            responseDeliveryKey,
            WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
          ),
        ),
      ).toEqual({
        _tag: "DeliveryRejected",
        operation: "workspaces.featureFlags.setAndDeliver.deliver-feature-flag-response",
        message: "The feature-flag response was rejected",
        recoveryRequired: true,
        committedReference: state.committedReference,
      });

      const announcementKeys: Array<typeof DeliveryKey.Type> = [];
      let announcementAttempt = 0;
      const announcing = yield* makeOperations(
        basePersistence().workspaces,
        makeBot({
          sendMessage: ({ payload }) => {
            announcementKeys.push(payload.deliveryKey);
            announcementAttempt += 1;
            return announcementAttempt === 1
              ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous" }))
              : Effect.succeed(announcementReceipt);
          },
        }),
      );
      const announce = () =>
        announcing.announce(
          announcementInput,
          state,
          conversation,
          makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled),
          announcementDeliveryKey,
          WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
        );
      expect(
        yield* Effect.flip(
          announcing.announce(
            announcementInput,
            { ...state, enabled: false },
            conversation,
            makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled),
            announcementDeliveryKey,
            WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
          ),
        ),
      ).toMatchObject({ _tag: "InvalidRequest", code: "FeatureFlagStateMismatch" });
      expect(announcementKeys).toEqual([]);
      expect(yield* Effect.flip(announce())).toMatchObject({
        _tag: "WorkspaceFeatureFlagWorkflowOperationsError",
      });
      expect(yield* announce()).toEqual(announcementReceipt);
      expect(announcementKeys).toEqual([announcementDeliveryKey, announcementDeliveryKey]);

      const bestEffort = yield* makeOperations(
        basePersistence().workspaces,
        makeBot({
          sendMessage: () => Effect.fail(new BotRequestRejected({ message: "no commit" })),
        }),
      );
      expect(
        yield* bestEffort.announce(
          announcementInput,
          state,
          conversation,
          makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled),
          announcementDeliveryKey,
          WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
        ),
      ).toBeNull();
    }),
  );

  it.effect("admits managing users and only the exact configured gateway service", () =>
    Effect.gen(function* () {
      const environment = {
        SHEET_BOT_GATEWAY_SERVICE_ID: "sheet-bot.gateway",
        SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "sheet-bot-client",
        SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-auto-role-cleanup",
      };
      const authorizeWith = (
        principal: typeof EffectivePrincipal.Type,
        bot: SheetBotHttpClient,
        input: unknown = announcementInput,
      ) => {
        const persistence = basePersistence();
        return Effect.gen(function* () {
          const authorization = yield* ReadOnlyWorkflowAuthorization;
          return yield* authorization.authorize(
            WorkspacesFeatureFlagsSetAndDeliver,
            principal,
            input,
          );
        }).pipe(
          Effect.provide(readOnlyWorkflowAuthorizationLayer),
          Effect.provideService(SheetBotCacheClient, { get: () => bot }),
          Effect.provideService(TrustedSheetPersistence, {
            ...persistence,
            workspaces: {
              ...persistence.workspaces,
              getWorkspaceMonitorRoles: () => Effect.succeed([]),
            },
          }),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment))),
        );
      };

      yield* authorizeWith(userPrincipal, makeBot());
      yield* authorizeWith(servicePrincipal, makeBot({ getMember: () => Effect.die("unused") }));
      const candidates = [
        {
          principal: userPrincipal,
          bot: makeBot({
            listRoles: () =>
              Effect.succeed([
                {
                  id: "manager",
                  name: "Manager",
                  color: 0,
                  permissions: "0",
                  position: 1,
                  managed: false,
                },
              ]),
          }),
        },
        {
          principal: Schema.decodeUnknownSync(EffectivePrincipal)({
            kind: "user",
            userId: "unlinked",
          }),
          bot: makeBot(),
        },
        {
          principal: Schema.decodeUnknownSync(EffectivePrincipal)({
            kind: "service",
            serviceId: "other-service",
            oauthClientId: "sheet-bot-client",
          }),
          bot: makeBot(),
        },
        {
          principal: Schema.decodeUnknownSync(EffectivePrincipal)({
            kind: "service",
            serviceId: "sheet-bot.gateway",
            oauthClientId: "other-client",
          }),
          bot: makeBot(),
        },
      ];
      for (const candidate of candidates) {
        const exit = yield* Effect.exit(authorizeWith(candidate.principal, candidate.bot));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "WorkflowInvocationUnauthorized",
          });
        }
      }
      const forged = yield* Effect.exit(
        authorizeWith(servicePrincipal, makeBot(), {
          ...announcementInput,
          workspaceId: undefined,
        }),
      );
      expect(Exit.isFailure(forged)).toBe(true);
      if (Exit.isFailure(forged)) {
        expect(Option.getOrThrow(Cause.findErrorOption(forged.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
        });
      }
    }),
  );

  it.effect("reauthorizes every effect and Actor Provenance never grants authority", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let allowed = true;
      const authorization: ReadOnlyWorkflowAuthorization["Service"] = {
        authorize: () => {
          calls.push("authorize");
          return allowed
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
      const operations: WorkspaceFeatureFlagWorkflowOperations["Service"] = {
        setDesiredState: () => Effect.sync(() => (calls.push("set"), state)),
        selectAnnouncementConversation: () =>
          Effect.sync(() => (calls.push("select"), conversation)),
        respond: () => Effect.sync(() => (calls.push("respond"), responseReceipt)),
        announce: () => Effect.sync(() => (calls.push("announce"), announcementReceipt)),
      };
      const services = Layer.mergeAll(
        Layer.succeed(ReadOnlyWorkflowAuthorization, authorization),
        Layer.succeed(WorkspaceFeatureFlagWorkflowOperations, operations),
      );
      const execution = {
        invocationId,
        principal: servicePrincipal,
        actorProvenance,
        input: announcementInput,
      };
      yield* executeSetWorkspaceFeatureFlagAction(execution).pipe(Effect.provide(services));
      yield* executeSelectFeatureFlagAnnouncementConversationAction({
        ...execution,
        state,
      }).pipe(Effect.provide(services));
      yield* executeDeliverFeatureFlagResponseAction({
        ...execution,
        input: responseInput,
        state,
        message: makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled),
      }).pipe(Effect.provide(services));
      yield* executeDeliverFeatureFlagAnnouncementAction({
        ...execution,
        state,
        conversation,
        message: makeWorkspaceFeatureFlagMessage(state.flagName, state.enabled),
      }).pipe(Effect.provide(services));
      expect(calls).toEqual([
        "authorize",
        "set",
        "authorize",
        "select",
        "authorize",
        "respond",
        "authorize",
        "announce",
      ]);
      allowed = false;
      const exit = yield* Effect.exit(
        executeSetWorkspaceFeatureFlagAction({
          ...execution,
          actorProvenance: { actorServiceId: servicePrincipal.serviceId },
        }).pipe(Effect.provide(services)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual({
          _tag: "AuthorizationRevoked",
          policy: WorkspacesFeatureFlagsSetAndDeliver.authorizationPolicy.policy,
        });
      }
      expect(calls).toEqual([
        "authorize",
        "set",
        "authorize",
        "select",
        "authorize",
        "respond",
        "authorize",
        "announce",
        "authorize",
      ]);
    }),
  );
});
