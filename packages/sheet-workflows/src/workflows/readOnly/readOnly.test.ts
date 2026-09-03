import {
  Cause,
  ConfigProvider,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
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
  messageRefFrom,
} from "sheet-bot-api";
import { WebSheetConfiguration } from "sheet-domain";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { EffectivePrincipal } from "sheet-auth/identity";
import {
  DataAcquisitionDeclaredFailure,
  DiscordLoadProfile,
  DiscordLoadWorkspaceChannels,
  MembersKick,
  RoomOrdersNavigate,
  RoomOrdersPinTentative,
  RoomOrdersSend,
  SchedulesDeliverUserSchedule,
  ServicesDeliverStatus,
  SheetSnapshotDeclaredFailure,
  SheetsDescribeInput,
  SheetsReadSnapshotInput,
  SheetSnapshotTab,
  SpreadsheetId,
  TeamSubmissionsDecide,
  TeamSubmissionsProcess,
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
import { SheetSnapshotProvider } from "./sheetSnapshotProvider";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetDataProvider, SheetDataProviderError } from "@/services/sheetDataProvider";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import {
  assertRegistrationValidationFails,
  makeRecordingWorkflowAuthorization,
  type MessageRoomOrderRow,
  roomOrderRow,
  workflowTestAccountId as accountId,
  workflowTestContext as context,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";

const allowAuthorizationLayer = Layer.succeed(ReadOnlyWorkflowAuthorization, {
  authorize: () => Effect.void,
  authorizeSlotOpen: () => Effect.die("unused"),
  authorizeCheckinRespond: () => Effect.die("unused"),
  authorizeRoomOrdersNavigate: () => Effect.die("unused"),
  authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
  authorizeRoomOrdersSend: () => Effect.die("unused"),
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

const makeDataProvider = (
  loadWorkspaceSchedules: SheetDataProvider["Service"]["loadWorkspaceSchedules"] = () =>
    Effect.die("unused"),
  resolveSpreadsheetId: SheetDataProvider["Service"]["resolveSpreadsheetId"] = () =>
    Effect.succeed(Option.none<typeof SpreadsheetId.Type>()),
): SheetDataProvider["Service"] => ({
  generateCheckin: () => Effect.die("unused"),
  generateRoomOrder: () => Effect.die("unused"),
  loadWorkspaceSchedules,
  resolveSpreadsheetId,
});

const previewTab = {
  sheetId: 0,
  title: "Roster",
  hidden: false,
  sheetType: "GRID",
  rowCount: 100,
  columnCount: 40,
} satisfies Schema.Schema.Type<typeof SheetSnapshotTab>;

const makeSnapshotProvider = (
  calls: Array<string>,
  policies: Array<string> = [],
): SheetSnapshotProvider["Service"] => ({
  describe: (spreadsheetId, readPolicy) =>
    Effect.sync(() => {
      calls.push(`describe:${spreadsheetId}`);
      policies.push(`describe:${readPolicy}`);
      return {
        spreadsheetId: Schema.decodeUnknownSync(SpreadsheetId)(spreadsheetId),
        tabs: [previewTab],
        metadataFetchedAtEpochMs: 1,
      };
    }),
  readSnapshot: (spreadsheetId, sheetId, window, readPolicy) =>
    Effect.sync(() => {
      calls.push(`snapshot:${spreadsheetId}`);
      policies.push(`snapshot:${readPolicy}`);
      return {
        spreadsheetId: Schema.decodeUnknownSync(SpreadsheetId)(spreadsheetId),
        tab: { ...previewTab, sheetId },
        window,
        cells: [],
        rowMetadata: [],
        columnMetadata: [],
        merges: [],
        metadataFetchedAtEpochMs: 1,
        windowFetchedAtEpochMs: 1,
      };
    }),
});

type WorkspaceMonitorRole = Effect.Success<
  ReturnType<TrustedSheetPersistenceShape["workspaces"]["getWorkspaceMonitorRoles"]>
>[number];

type MessageTeamSubmissionRow = Option.Option.Value<
  Effect.Success<
    ReturnType<TrustedSheetPersistenceShape["teamSubmissionState"]["getMessageTeamSubmission"]>
  >
>;

type AuthorizationPersistenceOverrides = {
  readonly getMessageRoomOrder?: TrustedSheetPersistenceShape["roomOrderState"]["getMessageRoomOrder"];
  readonly getMessageTeamSubmission?: TrustedSheetPersistenceShape["teamSubmissionState"]["getMessageTeamSubmission"];
};

const authorizationWithBot = (
  botClient: SheetBotHttpClient,
  monitorRoles: ReadonlyArray<WorkspaceMonitorRole> = [],
  overrides: AuthorizationPersistenceOverrides = {},
) => {
  const { getMessageRoomOrder, getMessageTeamSubmission } = overrides;
  const persistence = makeTrustedSheetPersistenceMock();
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
        roomOrderState: {
          ...persistence.roomOrderState,
          ...(getMessageRoomOrder ? { getMessageRoomOrder } : {}),
        },
        teamSubmissionState: {
          ...persistence.teamSubmissionState,
          ...(getMessageTeamSubmission ? { getMessageTeamSubmission } : {}),
        },
      }),
    ),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "sheet-bot-client",
          SHEET_BOT_GATEWAY_SERVICE_ID: "sheet-bot.gateway",
          SHEET_AUTH_OAUTH_CLIENT_ID: "sheet-auto-role-cleanup",
        }),
      ),
    ),
  );
};

const expectUnauthorized = <A, E>(
  exit: Exit.Exit<A, E>,
  expected: object = { _tag: "WorkflowInvocationUnauthorized" },
) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(false);
    expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject(expected);
  }
};

describe("read-only Sheet Workflow Definition slice", () => {
  it("registers exactly the eight pinned published definitions", () => {
    expect(ReadOnlySheetWorkflowContracts).toHaveLength(8);
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
    expect(ReadOnlySheetWorkflows).toHaveLength(8);
    expect(
      ReadOnlySheetWorkflowRegistrations.every(
        ({ definitionVersion }) => definitionVersion === "1",
      ),
    ).toBe(true);
    expect(
      ReadOnlySheetWorkflowDefinitions.every(
        ({ contract }) =>
          contract.declaredFailure === DataAcquisitionDeclaredFailure ||
          contract.declaredFailure === SheetSnapshotDeclaredFailure,
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
    expect(groups).toHaveLength(8);
    expect(groups.flatMap(({ endpoints }) => Object.keys(endpoints))).toHaveLength(24);
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

  it.effect(
    "uses the authoritative candidate spreadsheet for an unsaved pre-activation preview",
    () => {
      const calls: Array<string> = [];
      const policies: Array<string> = [];
      return Effect.gen(function* () {
        const dataSource = yield* ReadOnlyWorkflowDataSource;
        const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
        const describeInput = Schema.decodeUnknownSync(SheetsDescribeInput)({
          workspaceId,
          spreadsheetId: "candidate-sheet",
          readPolicy: "fresh",
        });
        const description = yield* dataSource.describeSheets(describeInput);
        expect(description.spreadsheetId).toBe("candidate-sheet");
        expect(description.tabs).toEqual([previewTab]);

        const snapshotInput = Schema.decodeUnknownSync(SheetsReadSnapshotInput)({
          workspaceId,
          spreadsheetId: Schema.decodeUnknownSync(SpreadsheetId)("candidate-sheet"),
          sheetId: 0,
          window: { startRow: 0, startColumn: 0, rowCount: 4, columnCount: 4 },
          readPolicy: "fresh",
        });
        const snapshot = yield* dataSource.readSheetSnapshot(snapshotInput);
        expect(snapshot.spreadsheetId).toBe("candidate-sheet");
        expect(calls).toEqual(["describe:candidate-sheet", "snapshot:candidate-sheet"]);
        expect(policies).toEqual(["describe:fresh", "snapshot:fresh"]);
      }).pipe(
        Effect.provide(readOnlyWorkflowDataSourceLayer),
        Effect.provide(Layer.succeed(SheetSnapshotProvider, makeSnapshotProvider(calls, policies))),
        Effect.provide(
          Layer.succeed(SheetBotCacheClient, {
            get: () => makeAuthorizationBotClient(() => Effect.die("unused")),
          }),
        ),
        Effect.provide(
          Layer.succeed(
            SheetDataProvider,
            makeDataProvider(undefined, () =>
              Effect.succeed(
                Option.some(Schema.decodeUnknownSync(SpreadsheetId)("candidate-sheet")),
              ),
            ),
          ),
        ),
        Effect.provide(Layer.sync(TrustedSheetPersistence, makeTrustedSheetPersistenceMock)),
        Effect.provide(allowAuthorizationLayer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "sheet-bot-client" }),
          ),
        ),
      );
    },
  );

  it.effect("uses a persisted draft spreadsheet for a pre-activation preview", () => {
    const calls: Array<string> = [];
    const policies: Array<string> = [];
    const configuration = Schema.decodeUnknownSync(WebSheetConfiguration)({
      schemaVersion: 1,
      spreadsheetId: "candidate-sheet",
      users: {
        userIds: {
          sheetId: 0,
          startRow: 0,
          endRow: "sheet-end",
          startColumn: 0,
          endColumn: 1,
        },
        userSheetNames: {
          sheetId: 0,
          startRow: 0,
          endRow: "sheet-end",
          startColumn: 1,
          endColumn: 2,
        },
      },
      teams: [],
      event: { startTimeEpochMs: 0 },
      schedules: [],
      runners: [],
    });
    const persistedConfiguration = Schema.encodeSync(WebSheetConfiguration)(configuration);
    const configurationRow = {
      workspaceId: "workspace-1",
      source: { kind: "owned", revisionId: null },
      legacyBinding: null,
      draftVersion: 1,
      baseRevisionId: null,
      baselineDigest: null,
      draft: persistedConfiguration,
      diagnostics: [],
      activeRevisionId: null,
      updatedBy: null,
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
    };
    const basePersistence = makeTrustedSheetPersistenceMock();
    const configurationPersistence: NonNullable<
      TrustedSheetPersistenceShape["sheetConfiguration"]
    > = {
      getSheetConfiguration: () => Effect.succeed(Option.some(configurationRow)),
      getSheetConfigurationRevisions: () => Effect.die("unused"),
      getSheetConfigurationRevisionById: () => Effect.die("unused"),
      getSheetConfigurationRevisionsBySpreadsheetId: () => Effect.die("unused"),
      getSheetConfigurationImportAttempt: () => Effect.die("unused"),
      upsertSheetConfigurationDraft: () => Effect.die("unused"),
      saveSheetConfigurationRevision: () => Effect.die("unused"),
      activateSheetConfigurationRevision: () => Effect.die("unused"),
      rollbackSheetConfiguration: () => Effect.die("unused"),
      discardSheetConfigurationDraft: () => Effect.die("unused"),
      upsertSheetConfigurationImportAttempt: () => Effect.die("unused"),
      recordSheetConfigurationAudit: () => Effect.die("unused"),
    };
    return Effect.gen(function* () {
      const dataSource = yield* ReadOnlyWorkflowDataSource;
      const description = yield* dataSource.describeSheets(
        Schema.decodeUnknownSync(SheetsDescribeInput)({
          workspaceId: "workspace-1",
          spreadsheetId: "candidate-sheet",
          readPolicy: "fresh",
        }),
      );
      expect(description.spreadsheetId).toBe("candidate-sheet");
      expect(calls).toEqual(["describe:candidate-sheet"]);
      expect(policies).toEqual(["describe:fresh"]);
    }).pipe(
      Effect.provide(readOnlyWorkflowDataSourceLayer),
      Effect.provide(Layer.succeed(SheetSnapshotProvider, makeSnapshotProvider(calls, policies))),
      Effect.provide(
        Layer.succeed(SheetBotCacheClient, {
          get: () => makeAuthorizationBotClient(() => Effect.die("unused")),
        }),
      ),
      Effect.provide(
        Layer.succeed(
          SheetDataProvider,
          makeDataProvider(undefined, () => Effect.die("authoritative fallback was used")),
        ),
      ),
      Effect.provide(
        Layer.succeed(TrustedSheetPersistence, {
          ...basePersistence,
          sheetConfiguration: configurationPersistence,
        }),
      ),
      Effect.provide(allowAuthorizationLayer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "sheet-bot-client" }),
        ),
      ),
    );
  });

  it.effect("rejects a preview candidate that is not the bound spreadsheet", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const dataSource = yield* ReadOnlyWorkflowDataSource;
      const exit = yield* Effect.exit(
        dataSource.describeSheets(
          Schema.decodeUnknownSync(SheetsDescribeInput)({
            workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
            spreadsheetId: "unrelated-sheet",
            readPolicy: "fresh",
          }),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toMatchObject({
          _tag: "Some",
          value: { _tag: "ConfigurationMissing", configuration: "spreadsheet" },
        });
      }
      expect(calls).toEqual([]);
    }).pipe(
      Effect.provide(readOnlyWorkflowDataSourceLayer),
      Effect.provide(Layer.succeed(SheetSnapshotProvider, makeSnapshotProvider(calls))),
      Effect.provide(
        Layer.succeed(SheetBotCacheClient, {
          get: () => makeAuthorizationBotClient(() => Effect.die("unused")),
        }),
      ),
      Effect.provide(
        Layer.succeed(
          SheetDataProvider,
          makeDataProvider(undefined, () =>
            Effect.succeed(Option.some(Schema.decodeUnknownSync(SpreadsheetId)("bound-sheet"))),
          ),
        ),
      ),
      Effect.provide(Layer.sync(TrustedSheetPersistence, makeTrustedSheetPersistenceMock)),
      Effect.provide(allowAuthorizationLayer),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ SHEET_BOT_GATEWAY_OAUTH_CLIENT_ID: "sheet-bot-client" }),
        ),
      ),
    );
  });

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
            authorizeCheckinRespond: () => Effect.die("unused"),
            authorizeRoomOrdersNavigate: () => Effect.die("unused"),
            authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
            authorizeRoomOrdersSend: () => Effect.die("unused"),
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
        expectUnauthorized(exit, {
          _tag: "WorkflowInvocationUnauthorized",
          message: "Workflow invocation is unauthorized",
        });
      }
    }),
  );

  it.effect("authorizes member cleanup only for workspace monitors or the configured service", () =>
    Effect.gen(function* () {
      const authorization = yield* authorizationWithBot(
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
      const service = Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "service",
        serviceId: "auto-role-cleanup",
        oauthClientId: "sheet-auto-role-cleanup",
      });
      const wrongService = Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "service",
        serviceId: "auto-role-cleanup",
        oauthClientId: "wrong-client",
      });

      yield* authorization.authorize(MembersKick, principal, { workspaceId: "workspace-1" });
      yield* authorization.authorize(MembersKick, service, { workspaceId: "workspace-1" });
      const denied = yield* Effect.exit(
        authorization.authorize(MembersKick, wrongService, { workspaceId: "workspace-1" }),
      );

      expect(Exit.isFailure(denied)).toBe(true);
      if (Exit.isFailure(denied)) {
        expect(Option.getOrThrow(Cause.findErrorOption(denied.cause))).toMatchObject({
          _tag: "WorkflowInvocationUnauthorized",
        });
      }
    }),
  );

  it.effect("requires the persisted author and current workspace membership for decisions", () =>
    Effect.gen(function* () {
      const client = { platform: "discord" as const, clientId: "discord-main" };
      const input = {
        responseReference: "response-1",
        sourceMessage: messageRefFrom(client, "workspace-1", "conversation-1", "source-message-1"),
        confirmationMessage: messageRefFrom(
          client,
          "workspace-1",
          "conversation-1",
          "confirmation-message-1",
        ),
        decision: "reject" as const,
      };
      const author = Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "user",
        userId: "author",
        discordAccount: { accountId: "discord-user-1" },
      });
      const nonAuthor = Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "user",
        userId: "other",
        discordAccount: { accountId: "discord-user-2" },
      });
      const persistedSubmission: MessageTeamSubmissionRow = {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "source-message-1",
        clientPlatform: "discord",
        clientId: "discord-main",
        discordGuildId: "workspace-1",
        discordChannelId: "conversation-1",
        discordAuthorId: "discord-user-1",
        sheetId: "sheet-1",
        sheetConfigurationBinding: null,
        confirmationMessageId: "confirmation-message-1",
        parsedSubmission: [],
        rowMappings: [],
        rollbackSnapshot: null,
        version: 1,
        status: "registered",
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      };
      const getMessageTeamSubmissionFor =
        (
          submission: MessageTeamSubmissionRow,
        ): TrustedSheetPersistenceShape["teamSubmissionState"]["getMessageTeamSubmission"] =>
        (key) =>
          key.workspaceId === submission.workspaceId &&
          key.conversationId === submission.conversationId &&
          key.messageId === submission.messageId
            ? Effect.succeed(Option.some(submission))
            : Effect.succeed(Option.none());
      const getMessageTeamSubmission = getMessageTeamSubmissionFor(persistedSubmission);
      const memberAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() => Effect.succeed({ userId: "discord-user-1", roleIds: [] })),
        [],
        { getMessageTeamSubmission },
      );
      yield* memberAuthorization.authorize(TeamSubmissionsDecide, author, input);
      const mismatchedConfirmationExit = yield* Effect.exit(
        memberAuthorization.authorize(TeamSubmissionsDecide, author, {
          ...input,
          confirmationMessage: messageRefFrom(
            client,
            "workspace-1",
            "conversation-1",
            "different-confirmation",
          ),
        }),
      );
      expectUnauthorized(mismatchedConfirmationExit);
      const unknownSubmissionExit = yield* Effect.exit(
        memberAuthorization.authorize(TeamSubmissionsDecide, author, {
          ...input,
          sourceMessage: messageRefFrom(
            client,
            "workspace-1",
            "conversation-1",
            "unknown-source-message",
          ),
        }),
      );
      expectUnauthorized(unknownSubmissionExit);
      for (const confirmationMessage of [
        messageRefFrom(client, "workspace-2", "conversation-1", "confirmation-message-1"),
        messageRefFrom(client, "workspace-1", "conversation-2", "confirmation-message-1"),
      ]) {
        const exit = yield* Effect.exit(
          memberAuthorization.authorize(TeamSubmissionsDecide, author, {
            ...input,
            confirmationMessage,
          }),
        );
        expectUnauthorized(exit);
      }
      const deletedAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() => Effect.succeed({ userId: "discord-user-1", roleIds: [] })),
        [],
        {
          getMessageTeamSubmission: getMessageTeamSubmissionFor({
            ...persistedSubmission,
            deletedAt: 2,
          }),
        },
      );
      const deletedExit = yield* Effect.exit(
        deletedAuthorization.authorize(TeamSubmissionsDecide, author, input),
      );
      expectUnauthorized(deletedExit);
      const foreignClientAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() => Effect.succeed({ userId: "discord-user-1", roleIds: [] })),
        [],
        {
          getMessageTeamSubmission: getMessageTeamSubmissionFor({
            ...persistedSubmission,
            clientId: "discord-other",
          }),
        },
      );
      const foreignClientExit = yield* Effect.exit(
        foreignClientAuthorization.authorize(TeamSubmissionsDecide, author, input),
      );
      expectUnauthorized(foreignClientExit);
      const nonAuthorExit = yield* Effect.exit(
        memberAuthorization.authorize(TeamSubmissionsDecide, nonAuthor, input),
      );
      expectUnauthorized(nonAuthorExit);

      const service = Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "service",
        serviceId: "sheet-bot.gateway",
        oauthClientId: "sheet-bot-client",
      });
      const serviceExit = yield* Effect.exit(
        memberAuthorization.authorize(TeamSubmissionsDecide, service, input),
      );
      expectUnauthorized(serviceExit);

      const leftAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() =>
          Effect.fail(new BotResourceNotFound({ resource: "member", message: "not a member" })),
        ),
        [],
        { getMessageTeamSubmission },
      );
      const leftExit = yield* Effect.exit(
        leftAuthorization.authorize(TeamSubmissionsDecide, author, input),
      );
      expectUnauthorized(leftExit);
    }),
  );

  it.effect("authorizes team-submission process only for the configured gateway service", () =>
    Effect.gen(function* () {
      const client = { platform: "discord" as const, clientId: "discord-main" };
      const authorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() =>
          Effect.die("process authorization must not read membership"),
        ),
      );
      const processInput = {
        sourceMessage: messageRefFrom(client, "workspace-1", "conversation-1", "source-message-1"),
        authorId: "discord-user-1",
        authorDisplayName: "Author",
        content: "full fill: 150/700",
      };
      const gatewayService = Schema.decodeUnknownSync(EffectivePrincipal)({
        kind: "service",
        serviceId: "sheet-bot.gateway",
        oauthClientId: "sheet-bot-client",
      });
      yield* authorization.authorize(TeamSubmissionsProcess, gatewayService, processInput);

      const foreignClientExit = yield* Effect.exit(
        authorization.authorize(TeamSubmissionsProcess, gatewayService, {
          ...processInput,
          sourceMessage: messageRefFrom(
            { platform: "discord", clientId: "foreign-client" },
            "workspace-1",
            "conversation-1",
            "source-message-1",
          ),
        }),
      );
      expectUnauthorized(foreignClientExit);

      for (const candidate of [
        principal,
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "other-service",
          oauthClientId: "other-client",
        }),
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "sheet-bot.gateway",
          oauthClientId: "other-client",
        }),
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "other-service",
          oauthClientId: "sheet-bot-client",
        }),
      ]) {
        const exit = yield* Effect.exit(
          authorization.authorize(TeamSubmissionsProcess, candidate, processInput),
        );
        expectUnauthorized(exit);
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
        expectUnauthorized(exit);
      }
    }),
  );

  it.effect(
    "authorizes room-order navigation from the configured-client record and monitor role",
    () =>
      Effect.gen(function* () {
        const row = roomOrderRow();
        const authorization = yield* authorizationWithBot(
          makeAuthorizationBotClient(() =>
            Effect.succeed({ userId: accountId, roleIds: ["monitor-role"] }),
          ),
          [
            {
              workspaceId: "workspace-1",
              roleId: "monitor-role",
              createdAt: 1,
              updatedAt: 1,
              deletedAt: null,
            },
          ],
          {
            getMessageRoomOrder: (key) => {
              expect(key).toEqual({
                clientPlatform: "discord",
                clientId: "discord-main",
                messageId: "message-1",
              });
              return Effect.succeed(Option.some(row));
            },
          },
        );

        const authorized = yield* authorization.authorizeRoomOrdersNavigate(principal, {
          messageId: "message-1",
          workspaceId: "forged-workspace",
          messageConversationId: "forged-conversation",
          messageContent: "forged content",
        });
        expect(authorized).toEqual({
          clientPlatform: "discord",
          clientId: "discord-main",
          messageId: "message-1",
          workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
          conversationId: "conversation-1",
          previousFills: ["Miku"],
          fills: ["Rin"],
          hour: 2,
          rank: 3,
          tentative: false,
          monitor: "Luka",
        });
        yield* authorization.authorize(RoomOrdersNavigate, principal, { messageId: "message-1" });
      }),
  );

  it.effect(
    "authorizes room-order send and tentative pin from canonical state and rejects incomplete sent bindings",
    () =>
      Effect.gen(function* () {
        const monitor = makeAuthorizationBotClient(() =>
          Effect.succeed({ userId: accountId, roleIds: ["monitor-role"] }),
        );
        const monitorRoles = [
          {
            workspaceId: "workspace-1",
            roleId: "monitor-role",
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          },
        ];
        const authorization = yield* authorizationWithBot(monitor, monitorRoles, {
          getMessageRoomOrder: () =>
            Effect.succeed(
              Option.some(
                roomOrderRow({
                  sendClaimId: "claim-1",
                  tentativePinClaimId: "pin-claim-1",
                }),
              ),
            ),
        });
        const authorized = yield* authorization.authorizeRoomOrdersSend(principal, {
          messageId: "message-1",
          workspaceId: "forged-workspace",
          messageConversationId: "forged-conversation",
          messageContent: "forged content",
        });
        expect(authorized).toMatchObject({
          clientPlatform: "discord",
          clientId: "discord-main",
          messageId: "message-1",
          workspaceId: Schema.decodeUnknownSync(WorkspaceId)("workspace-1"),
          conversationId: "conversation-1",
          rank: 3,
          sendClaimId: "claim-1",
          tentativePinClaimId: "pin-claim-1",
        });
        yield* authorization.authorize(RoomOrdersSend, principal, { messageId: "message-1" });
        expect(
          yield* authorization.authorizeRoomOrdersPinTentative(principal, {
            messageId: "message-1",
            workspaceId: "forged-workspace",
            messageConversationId: "forged-conversation",
          }),
        ).toEqual(authorized);
        yield* authorization.authorize(RoomOrdersPinTentative, principal, {
          messageId: "message-1",
        });

        for (const incomplete of [
          roomOrderRow({ sentMessageId: "sent-1", sentConversationId: null }),
          roomOrderRow({ sentMessageId: null, sentConversationId: "conversation-2" }),
        ]) {
          const incompleteAuthorization = yield* authorizationWithBot(monitor, monitorRoles, {
            getMessageRoomOrder: () => Effect.succeed(Option.some(incomplete)),
          });
          for (const authorize of [
            incompleteAuthorization.authorizeRoomOrdersSend,
            incompleteAuthorization.authorizeRoomOrdersPinTentative,
          ]) {
            const exit = yield* Effect.exit(authorize(principal, { messageId: "message-1" }));
            expectUnauthorized(exit);
          }
        }
      }),
  );

  it.effect("fails room-order navigation closed for non-monitors and invalid canonical rows", () =>
    Effect.gen(function* () {
      const ordinaryMember = makeAuthorizationBotClient(() =>
        Effect.succeed({ userId: accountId, roleIds: ["member-role"] }),
      );
      const monitor = makeAuthorizationBotClient(() =>
        Effect.succeed({ userId: accountId, roleIds: ["monitor-role"] }),
      );
      const monitorRoles = [
        {
          workspaceId: "workspace-1",
          roleId: "monitor-role",
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ];
      const invalidRows = [
        Option.none<MessageRoomOrderRow>(),
        Option.some(roomOrderRow({ workspaceId: null })),
        Option.some(roomOrderRow({ conversationId: null })),
        Option.some(roomOrderRow({ clientId: "discord-other" })),
        Option.some(roomOrderRow({ deletedAt: 2 })),
      ];
      const nonMonitor = yield* authorizationWithBot(ordinaryMember, [], {
        getMessageRoomOrder: () => Effect.succeed(Option.some(roomOrderRow())),
      });
      const nonMonitorExit = yield* Effect.exit(
        nonMonitor.authorizeRoomOrdersNavigate(principal, { messageId: "message-1" }),
      );
      expect(Exit.isFailure(nonMonitorExit)).toBe(true);

      for (const canonical of invalidRows) {
        const authorization = yield* authorizationWithBot(monitor, monitorRoles, {
          getMessageRoomOrder: () => Effect.succeed(canonical),
        });
        const exit = yield* Effect.exit(
          authorization.authorizeRoomOrdersNavigate(principal, { messageId: "message-1" }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "WorkflowInvocationUnauthorized",
          });
        }
      }
    }),
  );

  it.effect("rejects unlinked and service principals before room-order persistence lookup", () =>
    Effect.gen(function* () {
      const authorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(() => Effect.die("unused")),
        [],
        {
          getMessageRoomOrder: () => Effect.die("invalid principal must not read room-order state"),
        },
      );
      const candidates = [
        Schema.decodeUnknownSync(EffectivePrincipal)({ kind: "user", userId: "unlinked" }),
        Schema.decodeUnknownSync(EffectivePrincipal)({
          kind: "service",
          serviceId: "service-1",
          oauthClientId: "client-1",
        }),
      ];
      for (const candidate of candidates) {
        for (const authorize of [
          authorization.authorizeRoomOrdersNavigate,
          authorization.authorizeRoomOrdersPinTentative,
        ]) {
          const exit = yield* Effect.exit(authorize(candidate, { messageId: "message-1" }));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(false);
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

  it.effect("authorizes service status only for the configured application owner", () =>
    Effect.gen(function* () {
      const applicationRequests: Array<unknown> = [];
      const ownerAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(
          () => Effect.die("system authorization must not read workspace membership"),
          "0",
          (request) => {
            applicationRequests.push(request);
            return Effect.succeed({ ownerId: accountId });
          },
        ),
      );
      yield* ownerAuthorization.authorize(ServicesDeliverStatus, principal, {
        responseReference: "forged-authority",
      });
      expect(applicationRequests).toEqual([
        { params: { platform: "discord", clientId: "discord-main" } },
      ]);

      const candidates = [
        {
          authorization: yield* authorizationWithBot(
            makeAuthorizationBotClient(
              () => Effect.die("unused"),
              "0",
              () => Effect.succeed({ ownerId: "another-account" }),
            ),
          ),
          principal,
        },
        {
          authorization: ownerAuthorization,
          principal: Schema.decodeUnknownSync(EffectivePrincipal)({
            kind: "user",
            userId: "unlinked-user",
          }),
        },
        {
          authorization: ownerAuthorization,
          principal: Schema.decodeUnknownSync(EffectivePrincipal)({
            kind: "service",
            serviceId: "sheet-bot",
            oauthClientId: "sheet-bot",
          }),
        },
        {
          authorization: yield* authorizationWithBot(
            makeAuthorizationBotClient(
              () => Effect.die("unused"),
              "0",
              () =>
                Effect.fail(
                  new BotResourceNotFound({
                    resource: "application",
                    message: "configured client is missing",
                  }),
                ),
            ),
          ),
          principal,
        },
      ];
      for (const candidate of candidates) {
        const exit = yield* Effect.exit(
          candidate.authorization.authorize(ServicesDeliverStatus, candidate.principal, {}),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "WorkflowInvocationUnauthorized",
          });
        }
      }

      const dependencyFailure = new BotDependencyUnavailable({
        message: "private cache dependency detail",
      });
      const unavailableAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(
          () => Effect.die("unused"),
          "0",
          () => Effect.fail(dependencyFailure),
        ),
      );
      expect(
        yield* Effect.flip(
          unavailableAuthorization.authorize(ServicesDeliverStatus, principal, {}),
        ),
      ).toBe(dependencyFailure);

      const lookupStarted = yield* Deferred.make<void>();
      const timeoutAuthorization = yield* authorizationWithBot(
        makeAuthorizationBotClient(
          () => Effect.die("unused"),
          "0",
          () => Deferred.succeed(lookupStarted, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      );
      const timeoutFiber = yield* timeoutAuthorization
        .authorize(ServicesDeliverStatus, principal, {})
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(lookupStarted);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Effect.flip(Fiber.join(timeoutFiber))).toEqual(
        new BotDependencyUnavailable({ message: "Bot application cache lookup timed out" }),
      );
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
                    items: [
                      {
                        id: "conversation-1",
                        name: "general",
                        type: 0,
                        position: 1,
                        canSendMessages: true,
                      },
                    ],
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
        Effect.provide(Layer.succeed(SheetSnapshotProvider, makeSnapshotProvider([]))),
        Effect.provide(Layer.succeed(SheetBotCacheClient, { get: () => botClient })),
        Effect.provide(Layer.succeed(SheetDataProvider, makeDataProvider())),
        Effect.provide(Layer.sync(TrustedSheetPersistence, makeTrustedSheetPersistenceMock)),
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
      const error = yield* Effect.gen(function* () {
        const dataSource = yield* ReadOnlyWorkflowDataSource;
        return yield* Effect.flip(
          dataSource.loadWorkspaceSchedules(Schema.decodeUnknownSync(WorkspaceId)("workspace-1")),
        );
      }).pipe(
        Effect.provide(readOnlyWorkflowDataSourceLayer),
        Effect.provide(Layer.succeed(SheetSnapshotProvider, makeSnapshotProvider([]))),
        Effect.provide(
          Layer.succeed(SheetBotCacheClient, {
            get: () => makeAuthorizationBotClient(() => Effect.die("unused")),
          }),
        ),
        Effect.provide(
          Layer.succeed(
            SheetDataProvider,
            makeDataProvider(() =>
              Effect.fail(
                new SheetDataProviderError({
                  operation: "read-schedules",
                  cause: new Error("postgres://secret@internal/sheets"),
                }),
              ),
            ),
          ),
        ),
        Effect.provide(Layer.sync(TrustedSheetPersistence, makeTrustedSheetPersistenceMock)),
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
