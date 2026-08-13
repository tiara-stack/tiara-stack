import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "@effect/vitest";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  type AcceptedWorkflowInvocation,
  type WorkflowInvocationStore,
} from "effect-zero-workflow";
import {
  BotCollectionCursor,
  BotDependencyUnavailable,
  BotResourceNotFound,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { EffectivePrincipal } from "sheet-auth/identity";
import {
  DataAcquisitionDeclaredFailure,
  DiscordLoadProfile,
  DiscordLoadWorkspaceChannels,
  SchedulesDeliverUserSchedule,
  TeamsDeliverList,
  WorkspaceId,
} from "sheet-workflow-contracts";
import { workflowContractZeroGroupIdentifier } from "effect-zero-workflow/contract/transport";
import {
  isReadOnlySheetWorkflowName,
  materializeReadOnlyWorkflowFailure,
  ReadOnlySheetWorkflowDefinitions,
  ReadOnlySheetWorkflows,
} from "./definitions";
import { ReadOnlySheetWorkflowContracts } from "./catalog";
import {
  makeReadOnlySheetWorkflowZeroEnqueue,
  makeReadOnlySheetWorkflowZeroGroups,
  makeReadOnlyWorkflowTransportHandler,
  ReadOnlySheetWorkflowRegistrations,
} from "./registry";
import {
  ownerKeyForEffectivePrincipal,
  ReadOnlyWorkflowAuthorization,
  readOnlyWorkflowAuthorizationLayer,
} from "./authorization";
import { ReadOnlyWorkflowDataSource, readOnlyWorkflowDataSourceLayer } from "./dataSource";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetApisClient } from "@/services/sheetApisClient";
import { makeSheetApisClient, makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import {
  assertRegistrationValidationFails,
  makeRecordingWorkflowAuthorization,
  workflowTestAccountId as accountId,
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";

const allowAuthorizationLayer = Layer.succeed(ReadOnlyWorkflowAuthorization, {
  authorize: () => Effect.void,
  authorizeSlotOpen: () => Effect.die("unused"),
  workspaceCapabilities: () =>
    Effect.succeed({
      member: true,
      monitor: false,
      manage: false,
      participant: true,
      appOwner: false,
    }),
});

const makeAuthorizationBotClient = (
  getMember: (_request: unknown) => Effect.Effect<unknown, unknown>,
  permissions = "0",
  getApplication: (_request: unknown) => Effect.Effect<unknown, unknown> = () =>
    Effect.succeed({ ownerId: "application-owner" }),
) =>
  ({
    cache: {
      getApplication,
      getMember,
      getWorkspace: () =>
        Effect.succeed({
          id: "workspace-1",
          name: "Tiara",
          icon: null,
          ownerId: "workspace-owner",
        }),
      listRoles: () =>
        Effect.succeed([
          {
            id: "member-role",
            name: "Member",
            color: 0,
            permissions,
            position: 0,
            managed: false,
          },
        ]),
    },
  }) as unknown as SheetBotHttpClient;

type WorkspaceMonitorRole = Effect.Success<
  ReturnType<TrustedSheetPersistenceShape["workspaces"]["getWorkspaceMonitorRoles"]>
>[number];

const authorizationWithBot = (
  botClient: SheetBotHttpClient,
  monitorRoles: ReadonlyArray<WorkspaceMonitorRole> = [],
) => {
  const sheetApisClient = makeSheetApisClient({});
  const persistence = makeTrustedSheetPersistenceMock(sheetApisClient);
  return Effect.gen(function* () {
    return yield* ReadOnlyWorkflowAuthorization;
  }).pipe(
    Effect.provide(readOnlyWorkflowAuthorizationLayer),
    Effect.provide(Layer.succeed(SheetBotCacheClient, { get: () => botClient })),
    Effect.provide(
      Layer.succeed(TrustedSheetPersistence, {
        ...persistence,
        workspaces: {
          ...persistence.workspaces,
          getWorkspaceMonitorRoles: () => Effect.succeed(monitorRoles),
        },
      }),
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  );
};

describe("read-only Sheet Workflow Definition slice", () => {
  it("registers exactly the six pinned published definitions", () => {
    expect(ReadOnlySheetWorkflowContracts).toHaveLength(6);
    expect(
      ReadOnlySheetWorkflowDefinitions.map(({ contract, workflow }) => ({
        contract: workflowContractKey(contract),
        workflow: workflow.name,
      })),
    ).toEqual(
      ReadOnlySheetWorkflowContracts.map((contract) => ({
        contract: workflowContractKey(contract),
        workflow: workflowContractKey(contract),
      })),
    );
    expect(ReadOnlySheetWorkflows).toHaveLength(6);
    expect(
      ReadOnlySheetWorkflowRegistrations.every(
        ({ definitionVersion }) => definitionVersion === "1",
      ),
    ).toBe(true);
    expect(
      ReadOnlySheetWorkflowDefinitions.every(
        ({ contract }) => contract.declaredFailure === DataAcquisitionDeclaredFailure,
      ),
    ).toBe(true);
    expect(isReadOnlySheetWorkflowName(ReadOnlySheetWorkflows[0]!.name)).toBe(true);
    expect(isReadOnlySheetWorkflowName("legacy.workflow")).toBe(false);
  });

  it.effect("fails closed for missing and duplicate registrations", () =>
    assertRegistrationValidationFails(
      ReadOnlySheetWorkflowContracts,
      ReadOnlySheetWorkflowRegistrations,
    ),
  );

  it("mounts only selected generated enqueue/get/list procedures", () => {
    const groups = makeReadOnlySheetWorkflowZeroGroups(() => Promise.resolve());
    expect(groups).toHaveLength(6);
    expect(groups.flatMap(({ endpoints }) => Object.keys(endpoints))).toHaveLength(18);
    expect(groups.map(({ identifier }) => identifier)).toEqual(
      ReadOnlySheetWorkflowContracts.map(workflowContractZeroGroupIdentifier),
    );
    expect(groups.some(({ identifier }) => identifier === "workflows")).toBe(false);
  });

  it.effect("constructs the canonical Zero transaction enqueue adapter", () =>
    Effect.gen(function* () {
      const enqueue = yield* makeReadOnlySheetWorkflowZeroEnqueue;
      expect(enqueue).toBeTypeOf("function");
    }).pipe(Effect.provide(allowAuthorizationLayer)),
  );

  it.effect("preserves invocation replay identity and owner isolation", () =>
    Effect.gen(function* () {
      let stored: AcceptedWorkflowInvocation | undefined;
      let enqueueCalls = 0;
      const store: WorkflowInvocationStore = {
        enqueue: (invocation) => {
          enqueueCalls += 1;
          stored ??= invocation;
          return Effect.succeed(stored.fingerprint);
        },
        get: (ownerKey, workflowName, requestedId) =>
          Effect.succeed(
            stored &&
              stored.ownerKey === ownerKey &&
              stored.workflowName === workflowName &&
              stored.fingerprint.invocationId === requestedId
              ? {
                  runId: requestedId,
                  status: "pending" as const,
                  result: null,
                  error: null,
                  completedAt: null,
                  createdAt: 0,
                  updatedAt: 0,
                }
              : undefined,
          ),
        list: () => Effect.succeed([]),
      };
      const handler = yield* makeReadOnlyWorkflowTransportHandler(store);
      const request = { invocationId, input: {} };
      const first = yield* handler.enqueue(DiscordLoadProfile, context, request);
      const replay = yield* handler.enqueue(DiscordLoadProfile, context, request);
      expect(first).toEqual(replay);
      expect(enqueueCalls).toBe(2);
      expect(stored?.principal).toEqual(principal);
      expect(yield* handler.get(DiscordLoadProfile, context, invocationId)).toBeDefined();
      const foreign = yield* Effect.exit(
        handler.get(DiscordLoadProfile, { ...context, ownerKey: "user:other" }, invocationId),
      );
      expect(Exit.isFailure(foreign)).toBe(true);
    }).pipe(Effect.provide(allowAuthorizationLayer)),
  );

  it.effect("composes published policy authorization with the Effective Principal", () =>
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const authorization = makeRecordingWorkflowAuthorization(calls);
      yield* ReadOnlySheetWorkflowRegistrations[1]!
        .authorize(context, { workspaceId: "workspace-1" })
        .pipe(Effect.provideService(ReadOnlyWorkflowAuthorization, authorization));
      expect(calls).toEqual([
        {
          contract: DiscordLoadWorkspaceChannels,
          principal,
          input: { workspaceId: "workspace-1" },
        },
      ]);
      expect(ownerKeyForEffectivePrincipal(principal)).toBe(context.ownerKey);
    }),
  );

  it.effect("redacts authorization lookup failures at the public transport boundary", () =>
    Effect.gen(function* () {
      const store: WorkflowInvocationStore = {
        enqueue: () => Effect.die("authorization should fail before enqueue"),
        get: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
      };
      const handler = yield* makeReadOnlyWorkflowTransportHandler(store);
      const exit = yield* handler
        .enqueue(DiscordLoadWorkspaceChannels, context, {
          invocationId,
          input: { workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1") },
        })
        .pipe(
          Effect.provideService(ReadOnlyWorkflowAuthorization, {
            authorize: () =>
              Effect.fail(
                new BotDependencyUnavailable({
                  message: "postgres://secret@internal/authorization",
                }),
              ),
            authorizeSlotOpen: () => Effect.die("unused"),
            workspaceCapabilities: () => Effect.die("unused"),
          }),
          Effect.exit,
        );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toMatchObject({
          _tag: "Some",
          value: {
            _tag: "WorkflowTransportUnavailable",
            message: "Workflow enqueue transport is unavailable",
          },
        });
      }
    }),
  );

  it.effect("fails workspace capabilities closed for missing or malformed membership data", () =>
    Effect.gen(function* () {
      const missingMemberAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() =>
          Effect.fail(
            new BotResourceNotFound({ resource: "member", message: "member is unavailable" }),
          ),
        ),
      );
      expect(
        yield* missingMemberAuthorization.workspaceCapabilities(principal, "workspace-1"),
      ).toEqual({
        member: false,
        monitor: false,
        manage: false,
        participant: false,
        appOwner: false,
      });

      for (const permissions of ["not-an-integer", "-32"]) {
        const invalidPermissionsAuthorization = yield* authorizationWithBot(
          makeAuthorizationBotClient(
            () => Effect.succeed({ userId: accountId, roleIds: ["member-role"] }),
            permissions,
          ),
        );
        expect(
          yield* invalidPermissionsAuthorization.workspaceCapabilities(principal, "workspace-1"),
        ).toMatchObject({ member: true, manage: false, participant: false });
      }
    }),
  );

  it.effect("evaluates target-user policy v2 for self, monitor, and application owner", () =>
    Effect.gen(function* () {
      const selfAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() => Effect.die("self authorization must not read membership")),
      );
      const monitorAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() =>
          Effect.succeed({ userId: accountId, roleIds: ["member-role"] }),
        ),
        [
          {
            workspaceId: "workspace-1",
            roleId: "member-role",
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          },
        ],
      );
      const ownerAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(
          () =>
            Effect.fail(new BotResourceNotFound({ resource: "member", message: "not a member" })),
          "0",
          () => Effect.succeed({ ownerId: accountId }),
        ),
      );

      for (const contract of [TeamsDeliverList, SchedulesDeliverUserSchedule]) {
        yield* selfAuthorization.authorize(contract, principal, {
          workspaceId: "workspace-1",
          targetUserId: accountId,
        });
        yield* monitorAuthorization.authorize(contract, principal, {
          workspaceId: "workspace-1",
          targetUserId: "account-other",
        });
        yield* ownerAuthorization.authorize(contract, principal, {
          workspaceId: "workspace-1",
          targetUserId: "account-other",
        });
      }
      expect(yield* ownerAuthorization.workspaceCapabilities(principal, "workspace-1")).toEqual({
        member: false,
        monitor: false,
        manage: false,
        participant: false,
        appOwner: true,
      });
    }),
  );

  it.effect("fails target-user policy v2 closed for unlinked users and service sentinels", () =>
    Effect.gen(function* () {
      const authorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() =>
          Effect.die("unlinked principals must not read membership"),
        ),
      );
      for (const { authorizationInput, candidate } of [
        {
          candidate: Schema.decodeUnknownSync(EffectivePrincipal)({
            kind: "user",
            userId: "unlinked-user",
          }),
          authorizationInput: {
            workspaceId: "workspace-1",
            targetUserId: "legacy-service-sentinel",
          },
        },
        {
          candidate: Schema.decodeUnknownSync(EffectivePrincipal)({
            kind: "service",
            serviceId: "legacy-service-sentinel",
            oauthClientId: "legacy-service-sentinel",
          }),
          authorizationInput: {
            workspaceId: "workspace-1",
            targetUserId: "legacy-service-sentinel",
          },
        },
        {
          candidate: principal,
          authorizationInput: { workspaceId: "workspace-1" },
        },
      ]) {
        const exit = yield* Effect.exit(
          authorization.authorize(TeamsDeliverList, candidate, authorizationInput),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(false);
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "WorkflowInvocationUnauthorized",
            message: "Workflow invocation is unauthorized",
          });
        }
      }
    }),
  );

  it.effect("denies target-user policy v2 to ordinary workspace members", () =>
    Effect.gen(function* () {
      const authorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() =>
          Effect.succeed({ userId: accountId, roleIds: ["member-role"] }),
        ),
      );
      for (const contract of [TeamsDeliverList, SchedulesDeliverUserSchedule]) {
        const exit = yield* Effect.exit(
          authorization.authorize(contract, principal, {
            workspaceId: "workspace-1",
            targetUserId: "account-other",
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(false);
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "WorkflowInvocationUnauthorized",
          });
        }
      }
    }),
  );

  it.effect("preserves capability lookup failures for retryable handling", () =>
    Effect.gen(function* () {
      const authorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(
          () => Effect.succeed({ userId: accountId, roleIds: ["member-role"] }),
          "0",
          () => Effect.fail(new BotDependencyUnavailable({ message: "bot cache unavailable" })),
        ),
      );

      const exit = yield* Effect.exit(
        authorization.authorize(DiscordLoadWorkspaceChannels, principal, {
          workspaceId: "workspace-1",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toMatchObject({
          _tag: "Some",
          value: { _tag: "BotDependencyUnavailable" },
        });
      }
    }),
  );

  it.effect("uses the typed bot cache adapter for profile and bounded collection reads", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let conversationsPage = 0;
      const botClient = {
        cache: {
          getApplication: () => {
            calls.push("getApplication");
            return Effect.succeed({ ownerId: "owner-1" });
          },
          getUserProfile: () => {
            calls.push("getUserProfile");
            return Effect.succeed({
              user: {
                id: accountId,
                username: "theerie",
                displayName: "Theerie",
                avatar: null,
              },
              workspaces: [{ id: "workspace-1", name: "Tiara", icon: null, ownerId: "owner-1" }],
            });
          },
          listConversations: () => {
            calls.push("listConversations");
            conversationsPage += 1;
            return Effect.succeed(
              conversationsPage === 1
                ? {
                    items: [{ id: "conversation-1", name: "general", type: 0, position: 1 }],
                    nextCursor: Schema.decodeUnknownSync(BotCollectionCursor)("next"),
                  }
                : {
                    items: [],
                    nextCursor: Schema.decodeUnknownSync(BotCollectionCursor)("next"),
                  },
            );
          },
          listRoles: () => {
            calls.push("listRoles");
            return Effect.succeed([
              {
                id: "role-1",
                name: "Monitor",
                color: 123,
                permissions: "32",
                position: 1,
                managed: false,
              },
            ]);
          },
        },
      } as unknown as SheetBotHttpClient;
      yield* Effect.gen(function* () {
        const dataSource = yield* ReadOnlyWorkflowDataSource;
        expect(yield* dataSource.loadProfile(principal)).toMatchObject({
          user: { id: accountId },
          guilds: [{ id: "workspace-1" }],
        });
        const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
        expect(yield* dataSource.loadWorkspaceChannels(workspaceId)).toEqual([
          {
            id: "conversation-1",
            name: "general",
            type: 0,
            parentId: null,
            position: 1,
          },
        ]);
        expect(yield* dataSource.loadWorkspaceRoles(workspaceId)).toMatchObject([
          { id: "role-1", color: 123 },
        ]);
        expect(yield* dataSource.loadSupportedClients("discord")).toEqual([
          { platform: "discord", clientId: "discord-main" },
        ]);
      }).pipe(
        Effect.provide(readOnlyWorkflowDataSourceLayer),
        Effect.provide(Layer.succeed(SheetBotCacheClient, { get: () => botClient })),
        Effect.provide(Layer.succeed(SheetApisClient, makeSheetApisClient({}))),
        Effect.provide(allowAuthorizationLayer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );
      expect(calls).toEqual([
        "getUserProfile",
        "listConversations",
        "listConversations",
        "listRoles",
        "getApplication",
      ]);
    }),
  );

  it.effect("redacts upstream schedule failure details", () =>
    Effect.gen(function* () {
      const sheetApisClient = makeSheetApisClient({
        sheet: {
          getAllSchedules: () => Effect.succeed({ schedules: [] }),
          getEventConfig: () => Effect.fail(new Error("postgres://secret@internal/sheets")),
        },
      });
      const error = yield* Effect.gen(function* () {
        const dataSource = yield* ReadOnlyWorkflowDataSource;
        return yield* Effect.flip(
          dataSource.loadWorkspaceSchedules(Schema.decodeUnknownSync(WorkspaceId)("workspace-1")),
        );
      }).pipe(
        Effect.provide(readOnlyWorkflowDataSourceLayer),
        Effect.provide(
          Layer.succeed(SheetBotCacheClient, {
            get: () => makeAuthorizationBotClient(() => Effect.die("unused")),
          }),
        ),
        Effect.provide(Layer.succeed(SheetApisClient, sheetApisClient)),
        Effect.provide(allowAuthorizationLayer),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
      );

      expect(error).toEqual({
        _tag: "ExternalOperationRejected",
        operation: "schedules.loadWorkspace",
        code: "ProviderRejected",
        message: "Schedule provider rejected the read",
      });
    }),
  );

  it("materializes only declared or system failure values", () => {
    const declared = { _tag: "ConfigurationMissing" as const, configuration: "sheet" };
    expect(
      materializeReadOnlyWorkflowFailure(ReadOnlySheetWorkflows[0]!, Cause.fail(declared)),
    ).toEqual({ _tag: "Declared", error: declared });
    expect(
      materializeReadOnlyWorkflowFailure(ReadOnlySheetWorkflows[0]!, Cause.die("provider")),
    ).toEqual({ _tag: "System", code: "UnexpectedFailure", retryable: false });
  });
});
