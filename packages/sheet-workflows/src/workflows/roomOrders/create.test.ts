import { describe, expect, it } from "@effect/vitest";
import type { sheets_v4 } from "@googleapis/sheets";
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  BotDependencyUnavailable,
  ResponseReference,
  type SheetBotHttpClient,
} from "sheet-bot-api";
import { TrustedSheetPersistence } from "sheet-zero-server/persistence";
import {
  InteractiveDeclaredFailure,
  RoomOrdersCreate,
  WorkspaceId,
} from "sheet-workflow-contracts";
import { ZeroClient } from "typhoon-zero/client";
import { MutatorResultAppError } from "typhoon-zero/error";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import {
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { calculateRoomOrderEntries } from "./createCalculation";
import {
  makeRoomOrdersCreateDefinition,
  makeRoomOrdersCreateWorkflowBody,
} from "./createDefinition";
import { roomOrderCreateOperationsLayer } from "./createOperations";
import { makeRoomOrderCreateProvider, RoomOrderCreateProvider } from "./createProvider";
import type { RoomOrderCreateDraft } from "./createSchema";
import { RoomOrderCreateOperations } from "./createService";
import { makeRoomOrderCreateDeliveryKey } from "./keys";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("room-order-response");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const input = Schema.decodeUnknownSync(RoomOrdersCreate.input)({
  workspaceId,
  responseReference,
  conversationId: "running-1",
  conversationName: "ignored-by-id-precedence",
  hour: 2,
});
const execution = { invocationId, principal, input };
const context = {
  clientPlatform: "discord" as const,
  clientId: "discord-main",
  workspaceId,
  creatorAccountId: principal.discordAccount.accountId,
};
const draft: RoomOrderCreateDraft = {
  context,
  spreadsheetId: "sheet-1",
  runningConversationId: "running-1",
  runningConversationName: "Run One",
  hour: 2,
  rank: 0,
  range: { minRank: 0, maxRank: 0 },
  previousFills: ["Miku"],
  fills: ["Rin"],
  monitor: "Luka",
  entries: [{ rank: 0, position: 0, hour: 2, team: "Rin Team", tags: [], effectValue: 100 }],
  generatingMessage: { content: "generating" },
  finalMessage: { content: "final", components: [] },
};
const publishKey = makeRoomOrderCreateDeliveryKey(invocationId, "publish-room-order-draft");
const message = {
  conversation: {
    workspace: {
      client: { platform: "discord", clientId: "discord-main" },
      workspaceId,
    },
    conversationId: "response-conversation",
  },
  messageId: "message-1",
};
const published = {
  draft,
  message,
  receipt: {
    deliveryKey: publishKey,
    operation: "respond" as const,
    target: { _tag: "Response" as const, responseReference, message },
  },
};
const finalized = {
  deliveryKey: makeRoomOrderCreateDeliveryKey(invocationId, "finalize-room-order-message"),
  operation: "editMessage" as const,
  target: { _tag: "Message" as const, message },
};
const cleaned = {
  deliveryKey: makeRoomOrderCreateDeliveryKey(invocationId, "delete-provisional-room-order"),
  operation: "deleteMessage" as const,
  target: { _tag: "Message" as const, message },
};

const failure = (value: typeof InteractiveDeclaredFailure.Type) => Effect.fail(value);

const errorFrom = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

const makeOperations = (
  persistence: TrustedSheetPersistence["Service"],
  provider: typeof RoomOrderCreateProvider.Service,
  bot: SheetBotHttpClient = {} as SheetBotHttpClient,
) =>
  Effect.gen(function* () {
    return yield* RoomOrderCreateOperations;
  }).pipe(
    Effect.provide(roomOrderCreateOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(Layer.succeed(RoomOrderCreateProvider, provider)),
    Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => bot })),
  );

describe("room-order creation Workflow Definition slice", () => {
  it("registers the pinned policy-v1 graph and stable action identities", () => {
    const definition = makeRoomOrdersCreateDefinition();
    expect(RoomOrdersCreate.authorizationPolicy).toMatchObject({
      version: "1",
      principalKinds: ["user"],
      requiredCapabilities: ["workspace.member"],
      resource: "workspace",
      resourceField: "workspaceId",
    });
    expect(definition.workflow.name).toBe(workflowContractKey(RoomOrdersCreate));
    expect(definition.actions.map(({ workflow }) => workflow.name)).toEqual([
      "roomOrders.create.load-room-order-draft",
      "roomOrders.create.publish-room-order-draft",
      "roomOrders.create.bind-room-order-state",
      "roomOrders.create.finalize-room-order-message",
      "roomOrders.create.delete-provisional-room-order",
    ]);
    expect(definition.actions.every(({ version }) => version === "1")).toBe(true);
  });

  it.effect("derives stable distinct Action and Delivery Keys from invocation identity", () =>
    Effect.gen(function* () {
      const definition = makeRoomOrdersCreateDefinition();
      const payload = { ...execution, draft, publication: published };
      const first = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      const replay = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(payload),
      );
      expect(replay).toEqual(first);
      expect(new Set(first).size).toBe(5);
      const keys = [
        makeRoomOrderCreateDeliveryKey(invocationId, "publish-room-order-draft"),
        makeRoomOrderCreateDeliveryKey(invocationId, "delete-provisional-room-order"),
        makeRoomOrderCreateDeliveryKey(invocationId, "finalize-room-order-message"),
      ];
      expect(new Set(keys).size).toBe(3);
      expect(keys[0]).toBe(`roomOrders.create:1:${invocationId}:publish-room-order-draft`);
    }),
  );

  it.effect("completes only after publication, exact binding, and final edit", () => {
    const calls: Array<string> = [];
    return Effect.gen(function* () {
      const result = yield* makeRoomOrdersCreateWorkflowBody({
        load: () => Effect.sync(() => (calls.push("load"), draft)),
        publish: () => Effect.sync(() => (calls.push("publish"), published)),
        bind: () => Effect.sync(() => (calls.push("bind"), { _tag: "Bound" as const })),
        finalize: () => Effect.sync(() => (calls.push("finalize"), finalized)),
        cleanup: () => Effect.sync(() => (calls.push("cleanup"), cleaned)),
      })(execution);
      expect(calls).toEqual(["load", "publish", "bind", "finalize"]);
      expect(result).toEqual({
        messageId: "message-1",
        messageConversationId: "response-conversation",
        hour: 2,
        runningConversationId: "running-1",
        rank: 0,
        deliveryReceipts: [published.receipt, finalized],
      });
    });
  });

  it.effect("cleans up only a definitively uncommitted provisional publication", () => {
    const calls: Array<string> = [];
    const rejected = {
      _tag: "ExternalOperationRejected" as const,
      operation: "bind",
      code: "StateBindRejected",
      message: "not committed",
    };
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeRoomOrdersCreateWorkflowBody({
          load: () => Effect.succeed(draft),
          publish: () => Effect.succeed(published),
          bind: () => Effect.succeed({ _tag: "CleanupRequired" as const, failure: rejected }),
          finalize: () => Effect.die("unexpected finalize"),
          cleanup: () => Effect.sync(() => (calls.push("cleanup"), cleaned)),
        })(execution),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toEqual(["cleanup"]);
      expect(errorFrom(exit)).toEqual(rejected);
    });
  });

  it.effect("cleans up after pre-commit authorization loss but not an ambiguous bind defect", () =>
    Effect.gen(function* () {
      const authorizationCleanup: Array<string> = [];
      const authorizationExit = yield* Effect.exit(
        makeRoomOrdersCreateWorkflowBody({
          load: () => Effect.succeed(draft),
          publish: () => Effect.succeed(published),
          bind: () => failure({ _tag: "AuthorizationRevoked", policy: "workspace.member" }),
          finalize: () => Effect.die("unexpected finalize"),
          cleanup: () => Effect.sync(() => (authorizationCleanup.push("cleanup"), cleaned)),
        })(execution),
      );
      expect(Exit.isFailure(authorizationExit)).toBe(true);
      expect(authorizationCleanup).toEqual(["cleanup"]);

      const ambiguousCleanup: Array<string> = [];
      const ambiguousExit = yield* Effect.exit(
        makeRoomOrdersCreateWorkflowBody({
          load: () => Effect.succeed(draft),
          publish: () => Effect.succeed(published),
          bind: () => Effect.die("ambiguous bind"),
          finalize: () => Effect.die("unexpected finalize"),
          cleanup: () => Effect.sync(() => (ambiguousCleanup.push("cleanup"), cleaned)),
        })(execution),
      );
      expect(Exit.isFailure(ambiguousExit)).toBe(true);
      expect(ambiguousCleanup).toEqual([]);
    }),
  );

  it.effect("preserves committed state and committed reference on final-edit rejection", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeRoomOrdersCreateWorkflowBody({
          load: () => Effect.succeed(draft),
          publish: () => Effect.succeed(published),
          bind: () => Effect.succeed({ _tag: "Bound" as const }),
          finalize: () =>
            failure({
              _tag: "DeliveryRejected",
              operation: "finalize",
              message: "rejected",
              committedReference: "message-1",
              recoveryRequired: true,
            }),
          cleanup: () => Effect.die("must not clean up after commit"),
        })(execution),
      );
      expect(errorFrom(exit)).toMatchObject({
        _tag: "DeliveryRejected",
        committedReference: "message-1",
        recoveryRequired: true,
      });
    }),
  );

  it.effect("calculates deterministic ranked entries with heal and enc behavior", () =>
    Effect.gen(function* () {
      const teams = [
        [
          {
            playerId: "player-1",
            playerName: "Miku",
            teamName: "Miku Team",
            tags: ["heal"],
            lead: 100,
            backline: 100,
            talent: 10,
            encable: true,
            tierer: false,
          },
        ],
        [
          {
            playerId: "player-2",
            playerName: "Rin",
            teamName: "Rin Team",
            tags: ["tierer_hint"],
            lead: 90,
            backline: 90,
            talent: 9,
            encable: false,
            tierer: true,
          },
        ],
      ];
      const first = yield* calculateRoomOrderEntries({
        teamsByPlayer: teams,
        healNeeded: 1,
        hour: 3,
      });
      const replay = yield* calculateRoomOrderEntries({
        teamsByPlayer: teams,
        healNeeded: 1,
        hour: 3,
      });
      expect(replay).toEqual(first);
      expect(first).toHaveLength(2);
      expect(first.map(({ position, rank, team }) => ({ position, rank, team }))).toEqual([
        { rank: 0, position: 0, team: "Miku Team" },
        { rank: 0, position: 1, team: "Rin Team" },
      ]);
      expect(first[0]!.tags).toContain("enc");
      expect(first[1]!.tags).toContain("tierer");
      expect(
        yield* calculateRoomOrderEntries({ teamsByPlayer: teams, healNeeded: 2, hour: 3 }),
      ).toEqual([]);
    }),
  );

  it.effect("uses ID precedence and derives explicit and legacy-default hours", () => {
    const base = makeTrustedSheetPersistenceMock();
    const calls: Array<unknown> = [];
    const persistence = {
      ...base,
      workspaces: {
        ...base.workspaces,
        getWorkspaceConfigByWorkspaceId: () =>
          Effect.succeed(
            Option.some({
              workspaceId,
              sheetId: "sheet-1",
              autoCheckin: null,
              monitorConversationId: null,
              createdAt: 1,
              updatedAt: 1,
              deletedAt: null,
            }),
          ),
        getWorkspaceConversationById: (args: unknown) => {
          calls.push(args);
          return Effect.succeed(
            Option.some({
              workspaceId,
              conversationId: "running-1",
              name: "Run One",
              running: true,
              roleId: null,
              checkinConversationId: null,
              createdAt: 1,
              updatedAt: 1,
              deletedAt: null,
            }),
          );
        },
      },
    } satisfies TrustedSheetPersistence["Service"];
    const provider = {
      load: (spreadsheetId: string, conversationName: string) => {
        calls.push({ spreadsheetId, conversationName });
        return Effect.succeed({
          eventStartEpochMs: 0,
          schedules: [
            {
              hour: 1,
              fills: [{ accountId: "player-0", name: "Miku", enc: false }],
              monitor: null,
            },
            {
              hour: 2,
              fills: [{ accountId: "player-1", name: "Rin", enc: true }],
              monitor: "Luka",
            },
          ],
          teamsByPlayerName: new Map([
            [
              "Rin",
              [
                {
                  playerId: "player-1",
                  playerName: "Rin",
                  teamName: "Rin Team",
                  tags: [],
                  lead: 100,
                  backline: 100,
                  talent: 10,
                  encable: false,
                  tierer: false,
                },
              ],
            ],
          ]),
        });
      },
    };
    return Effect.gen(function* () {
      const operations = yield* makeOperations(persistence, provider);
      const result = yield* operations.loadDraft(context, input);
      expect(calls).toEqual([
        { workspaceId, conversationId: "running-1", running: true },
        { spreadsheetId: "sheet-1", conversationName: "Run One" },
      ]);
      expect(result).toMatchObject({
        runningConversationId: "running-1",
        hour: 2,
        rank: 0,
        previousFills: ["Miku"],
        fills: ["Rin"],
        monitor: "Luka",
      });
      expect(result.entries).toHaveLength(1);
      const defaultHour = yield* operations.loadDraft(context, {
        workspaceId,
        responseReference,
        conversationId: "running-1",
      });
      expect(defaultHour.hour).toBe(1);
    });
  });

  it.effect("rejects an ambiguous name selector before provider reads", () => {
    const base = makeTrustedSheetPersistenceMock();
    const conversation = (conversationId: string) => ({
      workspaceId,
      conversationId,
      name: "Run One",
      running: true,
      roleId: null,
      checkinConversationId: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    });
    const persistence = {
      ...base,
      workspaces: {
        ...base.workspaces,
        getWorkspaceConfigByWorkspaceId: () =>
          Effect.succeed(
            Option.some({
              workspaceId,
              sheetId: "sheet-1",
              autoCheckin: null,
              monitorConversationId: null,
              createdAt: 1,
              updatedAt: 1,
              deletedAt: null,
            }),
          ),
        getWorkspaceConversations: () =>
          Effect.succeed([conversation("running-1"), conversation("running-2")]),
      },
    } satisfies TrustedSheetPersistence["Service"];
    return Effect.gen(function* () {
      const operations = yield* makeOperations(persistence, {
        load: () => Effect.die("provider must not be called"),
      });
      const exit = yield* Effect.exit(
        operations.loadDraft(context, {
          workspaceId,
          responseReference,
          conversationName: "Run One",
        }),
      );
      expect(errorFrom(exit)).toMatchObject({
        _tag: "InvalidRequest",
        code: "AmbiguousRunningConversationSelector",
      });
    });
  });

  it.effect("binds absent canonical state and exactly reconciles replay", () => {
    const base = makeTrustedSheetPersistenceMock();
    let row = Option.none<any>();
    let entries: ReadonlyArray<any> = [];
    let binds = 0;
    const roomOrderState = {
      ...base.roomOrderState,
      getMessageRoomOrder: () => Effect.succeed(row),
      getMessageRoomOrderRange: () => Effect.succeed(entries),
      bindMessageRoomOrderIfAbsent: (args: any) =>
        Effect.sync(() => {
          binds += 1;
          if (Option.isSome(row)) return;
          row = Option.some({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            ...args.data,
            sendClaimId: null,
            sendClaimedAt: null,
            sentMessageId: null,
            sentConversationId: null,
            sentAt: null,
            tentativeUpdateClaimId: null,
            tentativeUpdateClaimedAt: null,
            tentativePinClaimId: null,
            tentativePinClaimedAt: null,
            tentativePinnedAt: null,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          });
          entries = args.entries.map((entry: any) => ({
            clientPlatform: args.clientPlatform,
            clientId: args.clientId,
            messageId: args.messageId,
            ...entry,
            createdAt: 1,
            updatedAt: 1,
            deletedAt: null,
          }));
        }),
    };
    return Effect.gen(function* () {
      const operations = yield* makeOperations(
        { ...base, roomOrderState },
        { load: () => Effect.die("unused") },
      );
      expect(yield* operations.bindState(published)).toEqual({ _tag: "Bound" });
      expect(yield* operations.bindState(published)).toEqual({ _tag: "Bound" });
      expect(binds).toBe(2);
      expect(row).toEqual(
        Option.some({
          clientPlatform: "discord",
          clientId: "discord-main",
          messageId: "message-1",
          previousFills: ["Miku"],
          fills: ["Rin"],
          hour: 2,
          rank: 0,
          tentative: false,
          monitor: "Luka",
          workspaceId,
          conversationId: "response-conversation",
          createdByUserId: principal.discordAccount.accountId,
          sendClaimId: null,
          sendClaimedAt: null,
          sentMessageId: null,
          sentConversationId: null,
          sentAt: null,
          tentativeUpdateClaimId: null,
          tentativeUpdateClaimedAt: null,
          tentativePinClaimId: null,
          tentativePinClaimedAt: null,
          tentativePinnedAt: null,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        }),
      );
      expect(entries).toEqual([
        {
          clientPlatform: "discord",
          clientId: "discord-main",
          messageId: "message-1",
          rank: 0,
          position: 0,
          hour: 2,
          team: "Rin Team",
          tags: [],
          effectValue: 100,
          createdAt: 1,
          updatedAt: 1,
          deletedAt: null,
        },
      ]);
    });
  });

  it.effect("treats only explicit absent-state mutation rejections as safe to clean up", () => {
    const base = makeTrustedSheetPersistenceMock();
    const persistenceWithBind = (
      bindMessageRoomOrderIfAbsent: TrustedSheetPersistence["Service"]["roomOrderState"]["bindMessageRoomOrderIfAbsent"],
    ): TrustedSheetPersistence["Service"] => ({
      ...base,
      roomOrderState: {
        ...base.roomOrderState,
        getMessageRoomOrder: () => Effect.succeed(Option.none()),
        getMessageRoomOrderRange: () => Effect.succeed([]),
        bindMessageRoomOrderIfAbsent,
      },
    });
    return Effect.gen(function* () {
      const ambiguousOperations = yield* makeOperations(
        persistenceWithBind(() =>
          Effect.fail(
            new ZeroClient.ZeroClientExecutorError({
              operation: "bind room order",
              message: "connection lost",
            }),
          ),
        ),
        { load: () => Effect.die("unused") },
      );
      const ambiguousExit = yield* Effect.exit(ambiguousOperations.bindState(published));
      expect(errorFrom(ambiguousExit)).toMatchObject({
        _tag: "RoomOrderCreateOperationsError",
        operation: "roomOrders.create.bindRoomOrderState.ambiguous",
      });

      const rejectedOperations = yield* makeOperations(
        persistenceWithBind(() =>
          Effect.fail(new MutatorResultAppError({ type: "app", message: "rejected" })),
        ),
        { load: () => Effect.die("unused") },
      );
      expect(yield* rejectedOperations.bindState(published)).toMatchObject({
        _tag: "CleanupRequired",
        failure: { _tag: "ExternalOperationRejected", code: "StateBindRejected" },
      });
    });
  });

  it.effect("bounds stalled state binding and reports its outcome as ambiguous", () =>
    Effect.gen(function* () {
      const stalled = yield* Deferred.make<void>();
      const base = makeTrustedSheetPersistenceMock();
      const persistence: TrustedSheetPersistence["Service"] = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          getMessageRoomOrder: () => Effect.succeed(Option.none()),
          getMessageRoomOrderRange: () => Effect.succeed([]),
          bindMessageRoomOrderIfAbsent: () => Deferred.await(stalled),
        },
      };
      const operations = yield* makeOperations(persistence, { load: () => Effect.die("unused") });
      const fiber = yield* operations.bindState(published).pipe(Effect.exit, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(30));
      const exit = yield* Fiber.join(fiber);
      expect(errorFrom(exit)).toMatchObject({
        _tag: "RoomOrderCreateOperationsError",
        operation: "roomOrders.create.bindRoomOrderState.ambiguous",
      });
    }),
  );

  it.effect(
    "validates configured-client publication and cleans an invalid response message",
    () => {
      const calls: Array<unknown> = [];
      const foreignMessage = {
        ...message,
        conversation: {
          ...message.conversation,
          workspace: {
            ...message.conversation.workspace,
            client: { platform: "discord", clientId: "foreign-client" },
          },
        },
      };
      const bot = {
        delivery: {
          respond: ({ payload }: any) =>
            Effect.sync(() => {
              calls.push({ operation: "respond", payload });
              return {
                ...published.receipt,
                target: { ...published.receipt.target, message: foreignMessage },
              };
            }),
          deleteMessage: ({ payload }: any) =>
            Effect.sync(() => {
              calls.push({ operation: "deleteMessage", payload });
              return { ...cleaned, target: { _tag: "Message" as const, message: foreignMessage } };
            }),
        },
      } as unknown as SheetBotHttpClient;
      const base = makeTrustedSheetPersistenceMock();
      return Effect.gen(function* () {
        const operations = yield* makeOperations(base, { load: () => Effect.die("unused") }, bot);
        const exit = yield* Effect.exit(
          operations.publishDraft(
            draft,
            responseReference,
            {
              publishKey,
              cleanupKey: makeRoomOrderCreateDeliveryKey(
                invocationId,
                "delete-provisional-room-order",
              ),
            },
            RoomOrdersCreate.authorizationPolicy.policy,
          ),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(errorFrom(exit)).toMatchObject({
          _tag: "DeliveryRejected",
          operation: "roomOrders.create.publishRoomOrderDraft",
          recoveryRequired: true,
        });
        expect(calls.map((call: any) => call.operation)).toEqual(["respond", "deleteMessage"]);
      });
    },
  );

  it.effect(
    "retains the provisional message reference when invalid-publication cleanup fails",
    () => {
      const foreignMessage = {
        ...message,
        conversation: {
          ...message.conversation,
          workspace: {
            ...message.conversation.workspace,
            client: { platform: "discord", clientId: "foreign-client" },
          },
        },
      };
      const bot = {
        delivery: {
          respond: () =>
            Effect.succeed({
              ...published.receipt,
              target: { ...published.receipt.target, message: foreignMessage },
            }),
          deleteMessage: () =>
            Effect.fail(new BotDependencyUnavailable({ message: "cleanup unavailable" })),
        },
      } as unknown as SheetBotHttpClient;
      const base = makeTrustedSheetPersistenceMock();
      return Effect.gen(function* () {
        const operations = yield* makeOperations(base, { load: () => Effect.die("unused") }, bot);
        const exit = yield* Effect.exit(
          operations.publishDraft(
            draft,
            responseReference,
            {
              publishKey,
              cleanupKey: makeRoomOrderCreateDeliveryKey(
                invocationId,
                "delete-provisional-room-order",
              ),
            },
            RoomOrdersCreate.authorizationPolicy.policy,
          ),
        );
        expect(errorFrom(exit)).toMatchObject({
          _tag: "DeliveryRejected",
          operation: "roomOrders.create.publishRoomOrderDraft",
          committedReference: "message-1",
          recoveryRequired: true,
        });
      });
    },
  );

  it.live("parses room-order schedule data and retries transient formatting reads", () => {
    let formatAttempts = 0;
    const client = {
      spreadsheets: {
        values: {
          batchGet: ({ ranges = [] }: { readonly ranges?: ReadonlyArray<string> }) => {
            const first = ranges[0];
            if (first === "'Thee''s Sheet Settings'!O8:P") {
              return Promise.resolve({
                data: {
                  valueRanges: [
                    { values: [["Start Time", "1700000000"]] },
                    {
                      values: [
                        [
                          "Run One",
                          "1",
                          "Schedule",
                          "A1:A2",
                          "C1:C2",
                          "D1:D2",
                          "bold",
                          "B1:F2",
                          "G1:G2",
                          "H1:H2",
                          "",
                          "",
                          "I1",
                        ],
                      ],
                    },
                    { values: [] },
                  ],
                },
              });
            }
            if (first === "'Thee''s Sheet Settings'!E8:M") {
              return Promise.resolve({
                data: {
                  valueRanges: [
                    { values: [] },
                    {
                      values: [
                        ["User IDs", "'Players'!A1:A2"],
                        ["User Sheet Names", "'Players'!B1:B2"],
                      ],
                    },
                  ],
                },
              });
            }
            if (first === "'Schedule'!A1:A2") {
              return Promise.resolve({
                data: {
                  valueRanges: [
                    { values: [[1], [2]] },
                    { values: [["", "miku"], ["rin"]] },
                    { values: [[false], [false]] },
                    { values: [["luka"], []] },
                  ],
                },
              });
            }
            return Promise.resolve({
              data: {
                valueRanges: [
                  { values: [["account-miku"], ["account-rin"]] },
                  { values: [["Miku"], ["Rin"]] },
                ],
              },
            });
          },
        },
        get: () => {
          formatAttempts += 1;
          if (formatAttempts === 1) return Promise.reject({ response: { status: 503 } });
          return Promise.resolve({
            data: {
              sheets: [
                {
                  properties: { title: "Schedule" },
                  data: [
                    {
                      startRow: 0,
                      startColumn: 1,
                      rowData: [
                        {
                          values: [{}, { effectiveFormat: { textFormat: { bold: true } } }],
                        },
                        { values: [] },
                      ],
                    },
                  ],
                },
              ],
            },
          });
        },
      },
    } as unknown as sheets_v4.Sheets;
    return Effect.gen(function* () {
      const view = yield* makeRoomOrderCreateProvider(client).load("sheet-1", "Run One");
      expect(formatAttempts).toBe(2);
      expect(view.eventStartEpochMs).toBe(1_700_000_000_000);
      expect(view.schedules).toEqual([
        {
          hour: 1,
          fills: [{ accountId: "account-miku", name: "Miku", enc: true }],
          monitor: "Luka",
        },
        {
          hour: 2,
          fills: [{ accountId: "account-rin", name: "Rin", enc: false }],
          monitor: null,
        },
      ]);
    });
  });

  it.effect("rejects an incomplete schedule-format response as malformed provider data", () => {
    const client = {
      spreadsheets: {
        values: {
          batchGet: ({ ranges = [] }: { readonly ranges?: ReadonlyArray<string> }) =>
            Promise.resolve({
              data: {
                valueRanges:
                  ranges[0] === "'Thee''s Sheet Settings'!O8:P"
                    ? [
                        { values: [["Start Time", "1700000000"]] },
                        {
                          values: [
                            [
                              "Run One",
                              "1",
                              "Schedule",
                              "A1:A1",
                              "auto",
                              "",
                              "regex",
                              "B1:F1",
                              "G1:G1",
                              "H1:H1",
                              "",
                              "",
                              "I1",
                            ],
                          ],
                        },
                        { values: [] },
                      ]
                    : ranges[0] === "'Thee''s Sheet Settings'!E8:M"
                      ? [
                          { values: [] },
                          {
                            values: [
                              ["User IDs", "'Players'!A1:A1"],
                              ["User Sheet Names", "'Players'!B1:B1"],
                            ],
                          },
                        ]
                      : ranges[0] === "'Schedule'!A1:A1"
                        ? [{ values: [[1]] }, { values: [["Miku"]] }]
                        : [{ values: [["account-miku"]] }, { values: [["Miku"]] }],
              },
            }),
        },
        get: () => Promise.resolve({ data: { sheets: [] } }),
      },
    } as unknown as sheets_v4.Sheets;
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(
        makeRoomOrderCreateProvider(client).load("sheet-1", "Run One"),
      );
      expect(failure.operation).toBe("read-schedule-format");
    });
  });
});
