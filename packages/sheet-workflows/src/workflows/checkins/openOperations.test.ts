import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect";
import { InvocationId } from "effect-zero-workflow/contract";
import { messageRefFrom, type SheetBotHttpClient } from "sheet-bot-api";
import { EffectivePrincipal } from "sheet-auth/identity";
import { CheckinsOpen } from "sheet-workflow-contracts";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { formatAutoCheckinContent } from "sheet-message-content/checkinSummary";
import { text } from "sheet-message-content/text";
import { makeRecordingWorkflowAuthorization } from "../shared/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  CheckinGeneration,
  RoomOrderGeneration,
  SheetDataProvider,
} from "@/services/sheetDataProvider";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import { checkinsOpenWorkflowOperationsLayer } from "./openOperations";
import { CheckinsOpenWorkflowOperations } from "./openService";
import { CheckinsOpenResolvedExecution } from "./openSchema";
import { makeCheckinsOpenDeliveryKey } from "./keys";

const invocationId = Schema.decodeUnknownSync(InvocationId)("123e4567-e89b-42d3-a456-426614174000");
const client = { platform: "discord" as const, clientId: "discord-main" };
const workspaceId = "workspace-1";
const servicePrincipal = Schema.decodeUnknownSync(EffectivePrincipal)({
  kind: "service",
  serviceId: "auto-checkin",
  oauthClientId: "auto-checkin-client",
});

const makeExecution = (
  options: {
    readonly monitorConversationId?: string | null;
    readonly monitorCheckinRequired?: boolean;
  } = {},
) => {
  const initialMessage = [{ type: "text" as const, text: "opening check-in" }];
  const generated = Schema.decodeUnknownSync(CheckinGeneration)({
    hour: 3,
    runningConversationId: "running-1",
    checkinConversationId: "checkin-1",
    monitorConversationId: options.monitorConversationId ?? null,
    fillCount: 5,
    roleId: "role-1",
    initialMessage,
    monitorCheckinMessage: [{ type: "text", text: "monitor summary" }],
    monitorUserId: "monitor-1",
    monitorCheckinRequired: options.monitorCheckinRequired ?? true,
    monitorFailureMessage: null,
    fillIds: ["player-1", "player-2"],
  });
  const input = Schema.decodeUnknownSync(CheckinsOpen.input)({
    workspaceId,
    conversationName: "main",
    hour: 3,
  });
  return Schema.decodeUnknownSync(CheckinsOpenResolvedExecution)({
    invocationId,
    input,
    principal: servicePrincipal,
    context: {
      clientPlatform: client.platform,
      clientId: client.clientId,
      workspaceId,
      principalKind: "service",
      createdByUserId: null,
      responseReference: null,
      generated,
      initialMessage,
      monitorCheckinMessage: [{ type: "text", text: "monitor summary" }],
      monitorFailureMessage: null,
      primaryConversationId: options.monitorConversationId ?? "running-1",
      primaryMessage: {
        content: [{ type: "text", text: "monitor check-in" }],
        embeds: [],
        allowedMentions: "default",
      },
    },
  });
};

const sendReceipt = (
  action: "deliver-checkin" | "deliver-primary" | "deliver-tentative-room-order",
  conversationId: string,
) => ({
  deliveryKey: makeCheckinsOpenDeliveryKey(invocationId, action),
  operation: "sendMessage" as const,
  target: {
    _tag: "Message" as const,
    message: messageRefFrom(client, workspaceId, conversationId, "message-1"),
  },
});

const editReceipt = (
  action: "finalize-checkin" | "finalize-primary" | "deliver-tentative-room-order",
  conversationId: string,
) => ({
  deliveryKey: makeCheckinsOpenDeliveryKey(invocationId, action),
  operation: "editMessage" as const,
  target: {
    _tag: "Message" as const,
    message: messageRefFrom(client, workspaceId, conversationId, "message-1"),
  },
});

const directReceipt = (userId: string, deliveryKey: string) => ({
  deliveryKey,
  operation: "sendDirectMessage" as const,
  target: {
    _tag: "DirectMessage" as const,
    recipient: { client, userId },
    message: messageRefFrom(client, "", `dm-channel-${userId}`, `dm-${userId}`),
  },
});

const makeDeliveryBot = (handlers: Record<string, unknown>): SheetBotHttpClient =>
  ({
    delivery: new Proxy(handlers, {
      get: (target, method: string) =>
        method in target ? target[method] : () => Effect.die(`Unexpected delivery call: ${method}`),
    }),
  }) as unknown as SheetBotHttpClient;

const makeOperations = (
  persistence: TrustedSheetPersistenceShape,
  handlers: Record<string, unknown>,
  dataProvider: SheetDataProvider["Service"] = makeDataProvider(),
) =>
  Effect.gen(function* () {
    return yield* CheckinsOpenWorkflowOperations;
  }).pipe(
    Effect.provide(checkinsOpenWorkflowOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(Layer.succeed(SheetDataProvider, dataProvider)),
    Effect.provide(
      Layer.succeed(SheetBotDeliveryClient, {
        get: () => makeDeliveryBot(handlers),
      }),
    ),
    Effect.provide(
      Layer.succeed(ReadOnlyWorkflowAuthorization, makeRecordingWorkflowAuthorization([])),
    ),
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ SHEET_BOT_CLIENT_ID: client.clientId })),
    ),
  );

type CheckinRow = Option.Option.Value<
  Effect.Success<ReturnType<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinData"]>>
>;
type CheckinMemberRow = Effect.Success<
  ReturnType<TrustedSheetPersistenceShape["checkinState"]["getMessageCheckinMembers"]>
>[number];
type PersistCheckinInput = Parameters<
  TrustedSheetPersistenceShape["checkinState"]["persistMessageCheckin"]
>[0];
type PersistRoomOrderInput = Parameters<
  TrustedSheetPersistenceShape["roomOrderState"]["persistMessageRoomOrder"]
>[0];
type RoomOrderRow = Option.Option.Value<
  Effect.Success<ReturnType<TrustedSheetPersistenceShape["roomOrderState"]["getMessageRoomOrder"]>>
>;

const canonicalCheckinRow = (
  request: PersistCheckinInput,
  messageId = "message-1",
): CheckinRow => ({
  clientPlatform: client.platform,
  clientId: client.clientId,
  messageId,
  hour: request.data.hour,
  roleId: request.data.roleId ?? null,
  initialMessage: request.data.initialMessage,
  runningConversationId: request.data.runningConversationId,
  workspaceId: request.data.workspaceId,
  conversationId: request.data.conversationId,
  createdByUserId: request.data.createdByUserId,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
});

const canonicalMembers = (
  request: PersistCheckinInput,
  messageId = "message-1",
): ReadonlyArray<CheckinMemberRow> =>
  request.memberIds.map((memberId) => ({
    clientPlatform: client.platform,
    clientId: client.clientId,
    messageId,
    memberId,
    checkinAt: null,
    checkinClaimId: null,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }));

const canonicalRoomOrderRow = (
  request: PersistRoomOrderInput,
  messageId = request.messageId,
): RoomOrderRow => ({
  clientPlatform: request.clientPlatform,
  clientId: request.clientId,
  messageId,
  previousFills: request.data.previousFills,
  fills: request.data.fills,
  hour: request.data.hour,
  rank: request.data.rank,
  tentative: request.data.tentative ?? true,
  monitor: request.data.monitor ?? null,
  workspaceId: request.data.workspaceId ?? null,
  conversationId: request.data.conversationId ?? null,
  createdByUserId: request.data.createdByUserId ?? null,
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

const roomOrder = () =>
  Schema.decodeUnknownSync(RoomOrderGeneration)({
    content: [text("room order")],
    runningConversationId: "running-1",
    range: { minRank: 1, maxRank: 1 },
    rank: 1,
    hour: 3,
    monitor: null,
    previousFills: [],
    fills: ["player-1"],
    entries: [],
  });

const makeDataProvider = (
  overrides: Partial<SheetDataProvider["Service"]> = {},
): SheetDataProvider["Service"] => ({
  generateCheckin: () => Effect.succeed(makeExecution().context.generated),
  generateRoomOrder: () => Effect.succeed(roomOrder()),
  loadWorkspaceSchedules: () => Effect.die("unused"),
  resolveSpreadsheetId: () => Effect.succeed(Option.none()),
  ...overrides,
});

const basePersistence = () => {
  return makeTrustedSheetPersistenceMock();
};

const preferenceRow = (userId: string) => ({
  platform: client.platform,
  userId,
  defaultClientId: client.clientId,
  checkinDmEnabled: true,
  monitorDmEnabled: true,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
});

describe("CheckinsOpen workflow operations", () => {
  it.effect("resolves and materializes the generated check-in context", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const calls: Array<unknown> = [];
      const operations = yield* makeOperations(
        basePersistence(),
        {},
        makeDataProvider({
          generateCheckin: (request) =>
            Effect.sync(() => (calls.push(request), execution.context.generated)),
        }),
      );

      const result = yield* operations.resolve({
        invocationId: execution.invocationId,
        input: execution.input,
        principal: execution.principal,
      });

      expect(calls).toHaveLength(1);
      expect(result).toMatchObject({
        clientPlatform: client.platform,
        clientId: client.clientId,
        workspaceId,
        principalKind: "service",
        createdByUserId: null,
        primaryConversationId: "running-1",
        generated: execution.context.generated,
      });
    }),
  );

  it.effect("validates configured recipients before delivering participant and monitor DMs", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const base = basePersistence();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        preferences: {
          ...base.preferences,
          getCheckinDmEnabledUserConfigs: ({ userIds }) =>
            Effect.succeed(userIds.map(preferenceRow)),
          getMonitorDmEnabledUserConfigs: ({ userIds }) =>
            Effect.succeed(userIds.map(preferenceRow)),
        },
      };
      const operations = yield* makeOperations(persistence, {
        sendDirectMessage: ({
          payload,
        }: {
          readonly payload: {
            readonly recipient: { readonly userId: string };
            readonly deliveryKey: string;
          };
        }) => Effect.succeed(directReceipt(payload.recipient.userId, payload.deliveryKey)),
      });

      const participantKey = makeCheckinsOpenDeliveryKey(
        invocationId,
        "deliver-participant-dm",
        "player-1",
      );
      const monitorKey = makeCheckinsOpenDeliveryKey(invocationId, "deliver-monitor-dm");
      const participant = yield* operations.deliverParticipantDm(
        execution,
        "player-1",
        execution.context.primaryMessage,
        participantKey,
      );
      const monitor = yield* operations.deliverMonitorDm(
        execution,
        execution.context.primaryMessage,
        monitorKey,
      );

      expect(participant).toEqual(directReceipt("player-1", participantKey));
      expect(monitor).toEqual(directReceipt("monitor-1", monitorKey));
    }),
  );

  it.effect("identifies the missing monitor DM preference", () =>
    Effect.gen(function* () {
      const base = basePersistence();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        preferences: {
          ...base.preferences,
          getMonitorDmEnabledUserConfigs: () => Effect.succeed([]),
        },
      };
      const operations = yield* makeOperations(persistence, {});
      const result = yield* Effect.exit(
        operations.deliverMonitorDm(
          makeExecution(),
          makeExecution().context.primaryMessage,
          makeCheckinsOpenDeliveryKey(invocationId, "deliver-monitor-dm"),
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
          _tag: "ExternalOperationRejected",
          message: "The recipient has no enabled monitor DM for this bot client",
        });
      }
    }),
  );

  it.effect("identifies the missing participant DM preference", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const base = basePersistence();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        preferences: {
          ...base.preferences,
          getCheckinDmEnabledUserConfigs: () => Effect.succeed([]),
        },
      };
      const operations = yield* makeOperations(persistence, {});
      const result = yield* Effect.exit(
        operations.deliverParticipantDm(
          execution,
          "player-1",
          execution.context.primaryMessage,
          makeCheckinsOpenDeliveryKey(invocationId, "deliver-participant-dm", "player-1"),
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
          _tag: "ExternalOperationRejected",
          message: "The recipient has no enabled check-in DM for this bot client",
        });
      }
    }),
  );

  it.effect("persists formatted autonomous check-ins with canonical attribution", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const sent = sendReceipt("deliver-checkin", "checkin-1");
      let request: PersistCheckinInput | undefined;
      const base = basePersistence();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        checkinState: {
          ...base.checkinState,
          persistMessageCheckin: (value) =>
            Effect.sync(() => {
              request = value;
            }),
        },
      };
      const operations = yield* makeOperations(persistence, {
        sendMessage: () => Effect.succeed(sent),
      });

      const result = yield* operations.deliverCheckin(
        execution,
        makeCheckinsOpenDeliveryKey(invocationId, "deliver-checkin"),
        makeCheckinsOpenDeliveryKey(invocationId, "cleanup-checkin"),
      );

      expect(result).toEqual({ message: sent.target.message, receipt: sent });
      expect(request).toBeDefined();
      expect(request?.data).toMatchObject({
        hour: 3,
        runningConversationId: "running-1",
        roleId: "role-1",
        workspaceId,
        conversationId: "checkin-1",
        createdByUserId: null,
        initialMessage: formatAutoCheckinContent(execution.context.initialMessage!),
      });
      expect(request?.memberIds).toEqual(["player-1", "player-2"]);
    }),
  );

  it.effect("reconciles an ambiguous persistence failure when canonical state exists", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const sent = sendReceipt("deliver-checkin", "checkin-1");
      let request: PersistCheckinInput | undefined;
      let deleted = false;
      const base = basePersistence();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        checkinState: {
          ...base.checkinState,
          persistMessageCheckin: (value) =>
            Effect.sync(() => (request = value)).pipe(Effect.andThen(Effect.die("after commit"))),
          getMessageCheckinData: () =>
            Effect.suspend(() =>
              request === undefined
                ? Effect.succeed(Option.none())
                : Effect.succeed(Option.some(canonicalCheckinRow(request))),
            ),
          getMessageCheckinMembers: () =>
            Effect.suspend(() =>
              request === undefined
                ? Effect.succeed([])
                : Effect.succeed(canonicalMembers(request)),
            ),
        },
      };
      const operations = yield* makeOperations(persistence, {
        sendMessage: () => Effect.succeed(sent),
        deleteMessage: () => Effect.sync(() => (deleted = true)),
      });

      expect(
        yield* operations.deliverCheckin(
          execution,
          makeCheckinsOpenDeliveryKey(invocationId, "deliver-checkin"),
          makeCheckinsOpenDeliveryKey(invocationId, "cleanup-checkin"),
        ),
      ).toEqual({ message: sent.target.message, receipt: sent });
      expect(deleted).toBe(false);
    }),
  );

  it.effect(
    "cleans up only when persistence is definitely absent and raises recovery otherwise",
    () =>
      Effect.gen(function* () {
        const execution = makeExecution();
        const sent = sendReceipt("deliver-checkin", "checkin-1");
        const base = basePersistence();
        const persistence: TrustedSheetPersistenceShape = {
          ...base,
          checkinState: {
            ...base.checkinState,
            persistMessageCheckin: () => Effect.die("persistence unavailable"),
            getMessageCheckinData: () => Effect.succeed(Option.none()),
            getMessageCheckinMembers: () => Effect.succeed([]),
          },
        };
        let cleanupCalls = 0;
        const operations = yield* makeOperations(persistence, {
          sendMessage: () => Effect.succeed(sent),
          deleteMessage: () => Effect.sync(() => (cleanupCalls += 1)),
        });
        const cleaned = yield* Effect.exit(
          operations.deliverCheckin(
            execution,
            makeCheckinsOpenDeliveryKey(invocationId, "deliver-checkin"),
            makeCheckinsOpenDeliveryKey(invocationId, "cleanup-checkin"),
          ),
        );
        expect(Exit.isFailure(cleaned)).toBe(true);
        if (Exit.isFailure(cleaned)) {
          expect(Option.getOrThrow(Cause.findErrorOption(cleaned.cause))).toMatchObject({
            _tag: "ExternalOperationRejected",
            code: "PersistenceRejected",
          });
        }
        expect(cleanupCalls).toBe(1);

        const unreconciled = yield* makeOperations(persistence, {
          sendMessage: () => Effect.succeed(sent),
          deleteMessage: () => Effect.die("delete ambiguous"),
        }).pipe(
          Effect.flatMap((next) =>
            Effect.exit(
              next.deliverCheckin(
                execution,
                makeCheckinsOpenDeliveryKey(invocationId, "deliver-checkin"),
                makeCheckinsOpenDeliveryKey(invocationId, "cleanup-checkin"),
              ),
            ),
          ),
        );
        expect(Exit.isFailure(unreconciled)).toBe(true);
        if (Exit.isFailure(unreconciled)) {
          expect(Option.getOrThrow(Cause.findErrorOption(unreconciled.cause))).toMatchObject({
            _tag: "DeliveryRejected",
            recoveryRequired: true,
            committedReference: "message-1",
          });
        }
      }),
  );

  it.effect("persists and finalizes a configured monitor check-in as the required primary", () =>
    Effect.gen(function* () {
      const execution = makeExecution({ monitorConversationId: "monitor-1" });
      const sent = sendReceipt("deliver-primary", "monitor-1");
      const finalized = editReceipt("finalize-primary", "monitor-1");
      let request: PersistCheckinInput | undefined;
      const base = basePersistence();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        checkinState: {
          ...base.checkinState,
          persistMessageCheckin: (value) =>
            Effect.sync(() => {
              request = value;
            }),
        },
      };
      const operations = yield* makeOperations(persistence, {
        sendMessage: () => Effect.succeed(sent),
        editMessage: () => Effect.succeed(finalized),
      });

      const result = yield* operations.deliverPrimary(
        execution,
        makeCheckinsOpenDeliveryKey(invocationId, "deliver-primary"),
        makeCheckinsOpenDeliveryKey(invocationId, "finalize-primary"),
        makeCheckinsOpenDeliveryKey(invocationId, "cleanup-checkin", "monitor"),
      );

      expect(result).toEqual({ receipt: sent, additionalReceipts: [finalized] });
      expect(request?.data).toMatchObject({
        conversationId: "monitor-1",
        roleId: null,
        createdByUserId: null,
      });
      expect(request?.memberIds).toEqual(["monitor-1"]);
    }),
  );

  it.effect("reconciles ambiguous tentative room-order persistence before finalizing", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const generated = roomOrder();
      const sent = sendReceipt("deliver-tentative-room-order", "running-1");
      const finalized = editReceipt("deliver-tentative-room-order", "running-1");
      let request: PersistRoomOrderInput | undefined;
      let deleted = false;
      const base = basePersistence();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          persistMessageRoomOrder: (value) =>
            Effect.sync(() => (request = value)).pipe(Effect.andThen(Effect.die("after commit"))),
          getMessageRoomOrder: () =>
            Effect.suspend(() =>
              request === undefined
                ? Effect.succeed(Option.none())
                : Effect.succeed(Option.some(canonicalRoomOrderRow(request))),
            ),
          getMessageRoomOrderRange: () => Effect.succeed([]),
        },
      };
      const operations = yield* makeOperations(
        persistence,
        {
          sendMessage: () => Effect.succeed(sent),
          editMessage: () => Effect.succeed(finalized),
          deleteMessage: () => Effect.sync(() => (deleted = true)),
        },
        makeDataProvider({ generateRoomOrder: () => Effect.succeed(generated) }),
      );

      const result = yield* operations.deliverTentativeRoomOrder(
        execution,
        makeCheckinsOpenDeliveryKey(invocationId, "deliver-tentative-room-order"),
        makeCheckinsOpenDeliveryKey(invocationId, "deliver-tentative-room-order", "finalize"),
        makeCheckinsOpenDeliveryKey(invocationId, "cleanup-tentative-room-order"),
      );

      expect(result).toEqual(finalized);
      expect(deleted).toBe(false);
    }),
  );

  it.effect("cleans up a tentative room-order placeholder when persistence is absent", () =>
    Effect.gen(function* () {
      const execution = makeExecution();
      const sent = sendReceipt("deliver-tentative-room-order", "running-1");
      let cleanupCalls = 0;
      const base = basePersistence();
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          persistMessageRoomOrder: () => Effect.die("persistence unavailable"),
          getMessageRoomOrder: () => Effect.succeed(Option.none()),
          getMessageRoomOrderRange: () => Effect.succeed([]),
        },
      };
      const operations = yield* makeOperations(
        persistence,
        {
          sendMessage: () => Effect.succeed(sent),
          deleteMessage: () => Effect.sync(() => (cleanupCalls += 1)),
        },
        makeDataProvider(),
      );

      const result = yield* Effect.exit(
        operations.deliverTentativeRoomOrder(
          execution,
          makeCheckinsOpenDeliveryKey(invocationId, "deliver-tentative-room-order"),
          makeCheckinsOpenDeliveryKey(invocationId, "deliver-tentative-room-order", "finalize"),
          makeCheckinsOpenDeliveryKey(invocationId, "cleanup-tentative-room-order"),
        ),
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toMatchObject({
          _tag: "ExternalOperationRejected",
          code: "PersistenceRejected",
        });
      }
      expect(cleanupCalls).toBe(1);
    }),
  );
});
