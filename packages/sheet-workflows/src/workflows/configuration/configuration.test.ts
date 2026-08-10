import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Predicate, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  BotDependencyUnavailable,
  BotResponseExpired,
  DeliveryKey,
  ResponseReference,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import {
  emptyPermissionBits,
  lockdownRolePermissionAllow,
  lockdownWorkspacePermissionDeny,
  monitorRolePermissionAllow,
} from "sheet-ingress-api/guild-config";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  ConversationsDeliverConfig,
  ConversationsSetLockdown,
  ConversationsUpdateConfigAndDeliver,
  InteractiveDeclaredFailure,
  WorkspacesDeliverConfig,
  WorkspacesSetMonitorRoleAndDeliver,
  WorkspacesUpdateConfigAndDeliver,
} from "sheet-workflow-contracts";
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
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { ConfigurationSheetWorkflowContracts } from "./catalog";
import {
  ConfigurationSheetWorkflowDefinitions,
  ConfigurationSheetWorkflows,
  isConfigurationSheetWorkflowName,
  makeConfigurationDeliveryKey,
  materializeConfigurationWorkflowFailure,
} from "./definitions";
import {
  ConfigurationWorkflowOperations,
  configurationWorkflowOperationsLayer,
} from "./operations";
import { ConfigurationSheetWorkflowRegistrations } from "./registry";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");

const exitErrorOrUndefined = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (Exit.isSuccess(exit)) {
    return undefined;
  }
  return Option.getOrElse(Cause.findErrorOption(exit.cause), () => {
    throw new Error(`Expected a typed failure but found: ${Cause.pretty(exit.cause)}`);
  });
};

const workspaceId = Schema.decodeUnknownSync(WorkspacesDeliverConfig.input)({
  workspaceId: "workspace-1",
  responseReference,
}).workspaceId;

const audit = { createdAt: 1, updatedAt: 1, deletedAt: null } as const;
const workspaceState = {
  workspaceId: "workspace-1",
  workspaceName: "Test *Workspace*",
  sheetId: "sheet-1",
  autoCheckin: true,
  monitorConversationId: "monitor-1",
  monitorRoleIds: ["monitor-role-1"],
} as const;
const conversationState = {
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  exists: true,
  name: "main",
  running: true,
  roleId: "lockdown-role-1",
  checkinConversationId: "checkin-1",
} as const;

const makeBot = (overrides: {
  readonly getWorkspace?: (request: {
    readonly params: {
      readonly workspaceId: string;
      readonly platform: string;
      readonly clientId: string;
    };
  }) => Effect.Effect<unknown, unknown>;
  readonly getConversation?: (request: {
    readonly params: {
      readonly workspaceId: string;
      readonly conversationId: string;
      readonly platform: string;
      readonly clientId: string;
    };
  }) => Effect.Effect<unknown, unknown>;
  readonly getRole?: (request: {
    readonly params: {
      readonly workspaceId: string;
      readonly roleId: string;
      readonly platform: string;
      readonly clientId: string;
    };
  }) => Effect.Effect<unknown, unknown>;
  readonly respond?: (request: {
    readonly payload: {
      readonly responseReference: typeof ResponseReference.Type;
      readonly deliveryKey: typeof DeliveryKey.Type;
      readonly message: unknown;
    };
  }) => Effect.Effect<unknown, unknown>;
  readonly replaceConversationPermissionOverwrites?: (request: {
    readonly payload: {
      readonly conversation: {
        readonly workspace: {
          readonly client: { readonly platform: string; readonly clientId: string };
          readonly workspaceId: string;
        };
        readonly conversationId: string;
      };
      readonly deliveryKey: typeof DeliveryKey.Type;
      readonly permissionOverwrites: ReadonlyArray<unknown>;
    };
  }) => Effect.Effect<unknown, unknown>;
}): SheetBotHttpClient =>
  ({
    cache: {
      getWorkspace: overrides.getWorkspace ?? (() => Effect.die("Unexpected getWorkspace call")),
      getConversation:
        overrides.getConversation ?? (() => Effect.die("Unexpected getConversation call")),
      getRole: overrides.getRole ?? (() => Effect.die("Unexpected getRole call")),
    },
    delivery: {
      respond: overrides.respond ?? (() => Effect.die("Unexpected respond call")),
      replaceConversationPermissionOverwrites:
        overrides.replaceConversationPermissionOverwrites ??
        (() => Effect.die("Unexpected replaceConversationPermissionOverwrites call")),
    },
  }) as unknown as SheetBotHttpClient;

const makeOperations = (
  workspaces: TrustedSheetPersistence["Service"]["workspaces"],
  bot: SheetBotHttpClient,
) => {
  const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
  return Effect.gen(function* () {
    return yield* ConfigurationWorkflowOperations;
  }).pipe(
    Effect.provide(configurationWorkflowOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, { ...base, workspaces })),
    Effect.provide(Layer.succeed(SheetBotCacheClient, { get: () => bot })),
    Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => bot })),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ sheetBotClientId: "discord-main" })),
    ),
  );
};

const baseWorkspaces = () => makeTrustedSheetPersistenceMock(makeSheetApisClient({})).workspaces;

describe("workspace and conversation configuration Workflow Definition slice", () => {
  it("registers exactly the six pinned definitions", () => {
    expect(ConfigurationSheetWorkflowContracts).toEqual([
      WorkspacesDeliverConfig,
      WorkspacesUpdateConfigAndDeliver,
      WorkspacesSetMonitorRoleAndDeliver,
      ConversationsDeliverConfig,
      ConversationsUpdateConfigAndDeliver,
      ConversationsSetLockdown,
    ]);
    expect(
      ConfigurationSheetWorkflowDefinitions.map(({ contract, workflow }) => ({
        contract: workflowContractKey(contract),
        workflow: workflow.name,
      })),
    ).toEqual(
      ConfigurationSheetWorkflowContracts.map((contract) => ({
        contract: workflowContractKey(contract),
        workflow: workflowContractKey(contract),
      })),
    );
    expect(ConfigurationSheetWorkflowDefinitions.map(({ actions }) => actions.length)).toEqual([
      2, 3, 3, 2, 3, 3,
    ]);
    expect(
      ConfigurationSheetWorkflowRegistrations.every(
        ({ definitionVersion }) => definitionVersion === "1",
      ),
    ).toBe(true);
    expect(
      ConfigurationSheetWorkflowDefinitions.every(
        ({ contract }) => contract.declaredFailure === InteractiveDeclaredFailure,
      ),
    ).toBe(true);
    expect(isConfigurationSheetWorkflowName(ConfigurationSheetWorkflows[0]!.name)).toBe(true);
    expect(isConfigurationSheetWorkflowName("legacy.workflow")).toBe(false);
  });

  it.effect("uses stable Action identities and operation-specific Delivery Keys", () =>
    Effect.gen(function* () {
      const configurationState = {
        workspaceId: "workspace-1",
        workspaceName: "Workspace",
        sheetId: "sheet-1",
        autoCheckin: false,
        monitorConversationId: "conversation-1",
        monitorRoleIds: [],
        conversationId: "conversation-1",
        exists: true,
        name: "Conversation",
        running: false,
        roleId: "lockdown-role-1",
        checkinConversationId: null,
        enabled: true,
      };
      const payload = {
        invocationId,
        principal,
        input: {
          workspaceId,
          responseReference,
          conversationId: "conversation-1",
          enabled: true,
        },
        current: configurationState,
        state: configurationState,
      };
      const definition = ConfigurationSheetWorkflowDefinitions.find(
        ({ contract }) => contract === ConversationsSetLockdown,
      );
      expect(definition).toBeDefined();
      if (Predicate.isUndefined(definition)) {
        return yield* Effect.die("Missing ConversationsSetLockdown workflow definition");
      }
      const actionIds = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      const replayIds = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      expect(replayIds).toEqual(actionIds);
      expect(definition.actions).toHaveLength(3);
      expect(new Set(actionIds).size).toBe(actionIds.length);
      expect(
        makeConfigurationDeliveryKey(
          ConversationsSetLockdown,
          invocationId,
          "permission-overwrites",
        ),
      ).not.toBe(makeConfigurationDeliveryKey(ConversationsSetLockdown, invocationId, "response"));
      expect(makeConfigurationDeliveryKey(ConversationsSetLockdown, invocationId, "response")).toBe(
        makeConfigurationDeliveryKey(ConversationsSetLockdown, invocationId, "response"),
      );
    }),
  );

  it.effect(
    "applies workspace-manage authorization with the Effective Principal and owner isolation",
    () => {
      const calls: Array<unknown> = [];
      const authorization = makeRecordingWorkflowAuthorization(calls);
      return Effect.gen(function* () {
        const input = { workspaceId, responseReference };
        yield* Effect.forEach(ConfigurationSheetWorkflowRegistrations, (registration) =>
          registration.authorize(context, input),
        );
        expect(calls).toEqual(
          ConfigurationSheetWorkflowContracts.map((contract) => ({ contract, principal, input })),
        );

        const errors = yield* Effect.forEach(
          ConfigurationSheetWorkflowRegistrations,
          (registration) =>
            Effect.exit(
              registration.authorizeObservation({ ...context, ownerKey: "user:other" }),
            ).pipe(Effect.map(exitErrorOrUndefined)),
        );
        for (const error of errors) {
          expect(error).toMatchObject({
            _tag: "WorkflowInvocationUnauthorized",
            message: "Workflow owner does not match the effective principal",
          });
        }
      }).pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
    },
  );

  it.effect("rejects the everyone role before updating conversation configuration", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const workspaces = {
        ...baseWorkspaces(),
        upsertWorkspaceConversationConfig: (args: unknown) => {
          calls.push({ method: "upsertConversation", args });
          return Effect.void;
        },
      };
      const bot = makeBot({
        getRole: ({ params }) => {
          calls.push({ method: "bot.getRole", params });
          return Effect.succeed({
            id: params.roleId,
            workspaceId: params.workspaceId,
            name: "@everyone",
          });
        },
      });
      const operations = yield* makeOperations(workspaces, bot);
      const input = Schema.decodeUnknownSync(ConversationsUpdateConfigAndDeliver.input)({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        responseReference,
        patch: { roleId: "workspace-1" },
      });
      const exit = yield* Effect.exit(
        operations.updateConversation(input, conversationState, "policy"),
      );
      expect(exitErrorOrUndefined(exit)).toEqual({
        _tag: "InvalidRequest",
        code: "LockdownEveryoneRoleForbidden",
        message: "The @everyone role cannot be used as the lockdown role",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("uses trusted configuration persistence and typed bot cache reads", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      let workspaceRow: {
        readonly workspaceId: string;
        sheetId: string | null;
        autoCheckin: boolean | null;
        monitorConversationId: string | null;
        readonly createdAt: number;
        readonly updatedAt: number;
        readonly deletedAt: number | null;
      } = {
        workspaceId: "workspace-1",
        sheetId: "sheet-1",
        autoCheckin: true,
        monitorConversationId: "monitor-1",
        ...audit,
      };
      const conversationRow = {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        name: "main" as string | null,
        running: true as boolean | null,
        roleId: "lockdown-role-1" as string | null,
        checkinConversationId: "checkin-1" as string | null,
        ...audit,
      };
      const base = baseWorkspaces();
      const workspaces: TrustedSheetPersistence["Service"]["workspaces"] = {
        ...base,
        getWorkspaceConfigByWorkspaceId: (args) => {
          calls.push({ method: "getWorkspaceConfig", args });
          return Effect.succeed(Option.some(workspaceRow));
        },
        getWorkspaceMonitorRoles: (args) => {
          calls.push({ method: "getMonitorRoles", args });
          return Effect.succeed([
            { workspaceId: args.workspaceId, roleId: "monitor-role-1", ...audit },
          ]);
        },
        upsertWorkspaceConfig: (args) => {
          calls.push({ method: "upsertWorkspace", args });
          workspaceRow = {
            ...workspaceRow,
            sheetId: args.sheetId ?? workspaceRow.sheetId,
            autoCheckin: args.autoCheckin ?? workspaceRow.autoCheckin,
            monitorConversationId:
              args.monitorConversationId === undefined
                ? workspaceRow.monitorConversationId
                : args.monitorConversationId,
          };
          return Effect.void;
        },
        addWorkspaceMonitorRole: (args) => {
          calls.push({ method: "addMonitorRole", args });
          return Effect.void;
        },
        getWorkspaceConversationById: (args) => {
          calls.push({ method: "getConversationConfig", args });
          return Effect.succeed(Option.some(conversationRow));
        },
        upsertWorkspaceConversationConfig: (args) => {
          calls.push({ method: "upsertConversation", args });
          return Effect.void;
        },
      };
      const bot = makeBot({
        getWorkspace: ({ params }) => {
          calls.push({ method: "bot.getWorkspace", params });
          return Effect.succeed({
            id: params.workspaceId,
            name: "Test *Workspace*",
            icon: null,
            ownerId: "owner-1",
          });
        },
        getConversation: ({ params }) => {
          calls.push({ method: "bot.getConversation", params });
          return Effect.succeed({
            id: params.conversationId,
            workspaceId: params.workspaceId,
            name: "main",
            type: 0,
          });
        },
        getRole: ({ params }) => {
          calls.push({ method: "bot.getRole", params });
          return Effect.succeed({
            id: params.roleId,
            workspaceId: params.workspaceId,
            name: "Monitor",
          });
        },
      });
      const operations = yield* makeOperations(workspaces, bot);
      expect(
        yield* operations.loadWorkspace("workspace-1", "policy", { requireConfig: true }),
      ).toEqual(workspaceState);
      const workspaceInput = Schema.decodeUnknownSync(WorkspacesUpdateConfigAndDeliver.input)({
        workspaceId: "workspace-1",
        responseReference,
        patch: { spreadsheetId: "sheet-2", autoCheckin: false },
      });
      expect(
        yield* operations.updateWorkspace(workspaceInput, workspaceState, "policy"),
      ).toMatchObject({ sheetId: "sheet-2", autoCheckin: false });
      const monitorRoleInput = Schema.decodeUnknownSync(WorkspacesSetMonitorRoleAndDeliver.input)({
        workspaceId: "workspace-1",
        responseReference,
        roleId: "monitor-role-2",
        enabled: true,
      });
      expect(
        yield* operations.setMonitorRole(monitorRoleInput, workspaceState, "policy"),
      ).toMatchObject({ monitorRoleIds: ["monitor-role-1", "monitor-role-2"] });
      expect(
        yield* operations.loadConversation("workspace-1", "conversation-1", "policy", {
          requireConfig: true,
        }),
      ).toEqual(conversationState);
      const conversationInput = Schema.decodeUnknownSync(ConversationsUpdateConfigAndDeliver.input)(
        {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          responseReference,
          patch: { running: false, name: null },
        },
      );
      expect(
        yield* operations.updateConversation(conversationInput, conversationState, "policy"),
      ).toMatchObject({ running: false, name: null });
      expect(calls).toContainEqual({
        method: "upsertWorkspace",
        args: { workspaceId: "workspace-1", sheetId: "sheet-2", autoCheckin: false },
      });
      expect(calls).toContainEqual({
        method: "upsertConversation",
        args: {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          running: false,
          name: null,
        },
      });
      expect(calls).toContainEqual({
        method: "addMonitorRole",
        args: { workspaceId: "workspace-1", roleId: "monitor-role-2" },
      });
      expect(
        calls.filter(
          (call) =>
            Predicate.hasProperty(call, "method") &&
            Predicate.isString(call.method) &&
            call.method.startsWith("bot.get"),
        ),
      ).toHaveLength(3);
    }),
  );

  it.effect("fails closed when provider conversation ownership is absent or mismatched", () =>
    Effect.gen(function* () {
      const errors = yield* Effect.forEach(
        [undefined, "workspace-2"] as const,
        (providerWorkspaceId) =>
          Effect.gen(function* () {
            const bot = makeBot({
              getConversation: ({ params }) =>
                Effect.succeed({
                  id: params.conversationId,
                  type: 0,
                  ...(Predicate.isUndefined(providerWorkspaceId)
                    ? {}
                    : { workspaceId: providerWorkspaceId }),
                }),
            });
            const operations = yield* makeOperations(baseWorkspaces(), bot);
            const exit = yield* Effect.exit(
              operations.loadConversation("workspace-1", "conversation-1", "policy", {
                requireConfig: false,
              }),
            );
            return exitErrorOrUndefined(exit);
          }),
      );
      expect(errors).toHaveLength(2);
      for (const error of errors) {
        expect(error).toMatchObject({
          _tag: "InvalidRequest",
          code: "ConversationWorkspaceMismatch",
        });
      }
    }),
  );

  it.effect("removes a stale monitor role without provider validation", () =>
    Effect.gen(function* () {
      const workspaces = baseWorkspaces();
      const operations = yield* makeOperations(
        {
          ...workspaces,
          removeWorkspaceMonitorRole: () => Effect.void,
        },
        makeBot({}),
      );
      const input = Schema.decodeUnknownSync(WorkspacesSetMonitorRoleAndDeliver.input)({
        workspaceId: "workspace-1",
        responseReference,
        roleId: "deleted-role",
        enabled: false,
      });
      expect(
        yield* operations.setMonitorRole(
          input,
          { ...workspaceState, monitorRoleIds: ["deleted-role"] },
          "policy",
        ),
      ).toMatchObject({ monitorRoleIds: [] });
    }),
  );

  it.effect("preserves complete lockdown replacement and inherited-default restoration", () =>
    Effect.gen(function* () {
      const deliveries: Array<unknown> = [];
      const base = baseWorkspaces();
      const workspaces: TrustedSheetPersistence["Service"]["workspaces"] = {
        ...base,
        getWorkspaceConversationById: () =>
          Effect.succeed(
            Option.some({
              workspaceId: "workspace-1",
              conversationId: "conversation-1",
              name: "main",
              running: true,
              roleId: "lockdown-role-1",
              checkinConversationId: "checkin-1",
              ...audit,
            }),
          ),
        getWorkspaceMonitorRoles: () =>
          Effect.succeed([
            { workspaceId: "workspace-1", roleId: "monitor-role-1", ...audit },
            { workspaceId: "workspace-1", roleId: "lockdown-role-1", ...audit },
          ]),
      };
      const bot = makeBot({
        getConversation: ({ params }) =>
          Effect.succeed({
            id: params.conversationId,
            workspaceId: params.workspaceId,
            type: 0,
          }),
        replaceConversationPermissionOverwrites: ({ payload }) => {
          deliveries.push(payload);
          return Effect.succeed({
            deliveryKey: payload.deliveryKey,
            operation: "replaceConversationPermissionOverwrites" as const,
            target: { _tag: "Conversation" as const, conversation: payload.conversation },
          });
        },
      });
      const operations = yield* makeOperations(workspaces, bot);
      const setupInput = Schema.decodeUnknownSync(ConversationsSetLockdown.input)({
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        responseReference,
        enabled: true,
      });
      const setup = yield* operations.loadLockdown(setupInput, "policy");
      const setupKey = makeConfigurationDeliveryKey(
        ConversationsSetLockdown,
        invocationId,
        "permission-overwrites",
      );
      yield* operations.replaceLockdownPermissions(setup, setupKey, "policy");
      const undoInput = { ...setupInput, enabled: false };
      const undo = yield* operations.loadLockdown(undoInput, "policy");
      const undoKey = Schema.decodeUnknownSync(DeliveryKey)("undo-key");
      yield* operations.replaceLockdownPermissions(undo, undoKey, "policy");
      const missingRoleKey = Schema.decodeUnknownSync(DeliveryKey)("missing-role-key");
      yield* operations.replaceLockdownPermissions(
        { ...setup, roleId: null },
        missingRoleKey,
        "policy",
      );

      expect(deliveries).toEqual([
        {
          conversation: {
            workspace: {
              client: { platform: "discord", clientId: "discord-main" },
              workspaceId: "workspace-1",
            },
            conversationId: "conversation-1",
          },
          deliveryKey: setupKey,
          permissionOverwrites: [
            {
              targetId: "lockdown-role-1",
              targetKind: "role",
              allow: lockdownRolePermissionAllow,
              deny: emptyPermissionBits,
            },
            {
              targetId: "monitor-role-1",
              targetKind: "role",
              allow: monitorRolePermissionAllow,
              deny: emptyPermissionBits,
            },
            {
              targetId: "workspace-1",
              targetKind: "role",
              allow: emptyPermissionBits,
              deny: lockdownWorkspacePermissionDeny,
            },
          ],
        },
        {
          conversation: {
            workspace: {
              client: { platform: "discord", clientId: "discord-main" },
              workspaceId: "workspace-1",
            },
            conversationId: "conversation-1",
          },
          deliveryKey: undoKey,
          permissionOverwrites: [],
        },
        {
          conversation: {
            workspace: {
              client: { platform: "discord", clientId: "discord-main" },
              workspaceId: "workspace-1",
            },
            conversationId: "conversation-1",
          },
          deliveryKey: missingRoleKey,
          permissionOverwrites: [],
        },
      ]);
    }),
  );

  it.effect(
    "reconciles ambiguous permission delivery with the same key and marks post-commit response recovery",
    () =>
      Effect.gen(function* () {
        const permissionKeys: Array<typeof DeliveryKey.Type> = [];
        let permissionAttempt = 0;
        const bot = makeBot({
          replaceConversationPermissionOverwrites: ({ payload }) => {
            permissionKeys.push(payload.deliveryKey);
            permissionAttempt += 1;
            return permissionAttempt === 1
              ? Effect.fail(new BotDependencyUnavailable({ message: "ambiguous provider outcome" }))
              : Effect.succeed({
                  deliveryKey: payload.deliveryKey,
                  operation: "replaceConversationPermissionOverwrites" as const,
                  target: { _tag: "Conversation" as const, conversation: payload.conversation },
                });
          },
          respond: () =>
            Effect.fail(new BotResponseExpired({ message: "response expired after commit" })),
        });
        const operations = yield* makeOperations(baseWorkspaces(), bot);
        const permissionKey = makeConfigurationDeliveryKey(
          ConversationsSetLockdown,
          invocationId,
          "permission-overwrites",
        );
        const state = {
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          enabled: false,
          roleId: null,
          monitorRoleIds: [],
        } as const;
        const permissionExit = yield* Effect.exit(
          operations.replaceLockdownPermissions(state, permissionKey, "policy"),
        );
        const permissionError = exitErrorOrUndefined(permissionExit);
        expect(permissionError).toMatchObject({
          _tag: "ConfigurationWorkflowOperationsError",
          operation: "conversations.setLockdown.permissionOverwrites",
          cause: {
            _tag: "BotDependencyUnavailable",
            message: "ambiguous provider outcome",
          },
        });
        expect(
          yield* operations.replaceLockdownPermissions(state, permissionKey, "policy"),
        ).toMatchObject({ deliveryKey: permissionKey });
        expect(permissionKeys).toEqual([permissionKey, permissionKey]);

        const input = Schema.decodeUnknownSync(ConversationsSetLockdown.input)({
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          responseReference,
          enabled: false,
        });
        const responseExit = yield* Effect.exit(
          operations.deliverLockdownResponse(
            input,
            makeConfigurationDeliveryKey(ConversationsSetLockdown, invocationId, "response"),
            "policy",
          ),
        );
        const responseError = exitErrorOrUndefined(responseExit);
        expect(responseError).toEqual({
          _tag: "DeliveryRejected",
          operation: "conversations.setLockdown.respond",
          message: "The response is no longer available",
          recoveryRequired: true,
        });
      }),
  );

  it.effect("renders legacy configuration messages and materializes only typed failures", () =>
    Effect.gen(function* () {
      const messages: Array<unknown> = [];
      const bot = makeBot({
        respond: ({ payload }) => {
          messages.push(normalizePayloadText(payload.message));
          return Effect.succeed({
            deliveryKey: payload.deliveryKey,
            operation: "respond" as const,
            target: {
              _tag: "Response" as const,
              responseReference: payload.responseReference,
            },
          });
        },
      });
      const operations = yield* makeOperations(baseWorkspaces(), bot);
      yield* operations.deliverWorkspaceConfig(
        responseReference,
        workspaceState,
        Schema.decodeUnknownSync(DeliveryKey)("workspace-response"),
        "policy",
        { recoveryRequired: false },
      );
      yield* operations.deliverConversationConfig(
        responseReference,
        conversationState,
        Schema.decodeUnknownSync(DeliveryKey)("conversation-response"),
        "policy",
        { recoveryRequired: false, updated: true },
      );
      expect(messages).toEqual([
        {
          embeds: [
            {
              title: "Config for Test \\*Workspace\\*",
              description:
                "Sheet id: sheet\\-1\nAuto check-in: Enabled\nMonitor channel: #monitor-1\nMonitor role: @role:monitor-role-1",
            },
          ],
        },
        {
          embeds: [
            {
              title: "Success!",
              description: "#conversation-1 configuration updated",
              fields: [
                { name: "Name", value: "main" },
                { name: "Run destination", value: "Yes" },
                { name: "Lockdown role", value: "@role:lockdown-role-1" },
                { name: "Check-in destination", value: "#checkin-1" },
              ],
            },
          ],
        },
      ]);

      const declared = { _tag: "ResourceNotFound", resource: "conversation-config" } as const;
      expect(
        materializeConfigurationWorkflowFailure(
          ConfigurationSheetWorkflows[0]!,
          Cause.fail(declared),
        ),
      ).toEqual({ _tag: "Declared", error: declared });
      expect(
        materializeConfigurationWorkflowFailure(ConfigurationSheetWorkflows[0]!, Cause.die("boom")),
      ).toEqual({ _tag: "System", code: "UnexpectedFailure", retryable: false });
    }),
  );
});
