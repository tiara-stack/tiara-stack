import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Option, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { ResponseReference, type SheetBotHttpClient, type SendMessageReceipt } from "sheet-bot-api";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import {
  CheckinsTestAuto,
  WorkspaceId,
  type InteractiveDeclaredFailure,
} from "sheet-workflow-contracts";
import {
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { preserveInteractiveDeclaredFailure } from "../shared/interactive";
import { makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import {
  makeCheckinsTestAutoDefinition,
  makeCheckinsTestAutoWorkflowBody,
} from "./autoTestDefinition";
import {
  autoCheckinTestActionIdentities,
  makeAutoCheckinTestActionKey,
  makeAutoCheckinTestDeliveryKey,
  makeAutoCheckinTestInvocationId,
} from "./autoTestKeys";
import type {
  AutoCheckinTestPreparation,
  AutoCheckinTestPreviewDeliveryOutcome,
} from "./autoTestSchema";
import { autoCheckinTestWorkflowOperationsLayer } from "./autoTestOperations";
import { AutoCheckinTestProvider } from "./autoTestProvider";
import { AutoCheckinTestWorkflowOperations } from "./autoTestService";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("auto-checkin-response");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const input = Schema.decodeUnknownSync(CheckinsTestAuto.input)({
  workspaceId,
  responseReference,
  anchorConversationId: "anchor-conversation",
});
const execution = { invocationId, principal, input };
const client = { platform: "discord", clientId: "discord-main" };
const conversation = (conversationId: string) => ({
  workspace: { client, workspaceId },
  conversationId,
});
const message = (conversationId: string, messageId: string) => ({
  conversation: conversation(conversationId),
  messageId,
});
const anchorMessage = message(input.anchorConversationId, "anchor-message");
const forgedAnchor = message("forged-conversation", "forged-anchor");
const anchorReceipt = {
  deliveryKey: makeAutoCheckinTestDeliveryKey(
    invocationId,
    autoCheckinTestActionIdentities.createAnchor,
  ),
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference, message: anchorMessage },
};
const summaryReceipt = {
  deliveryKey: makeAutoCheckinTestDeliveryKey(
    invocationId,
    autoCheckinTestActionIdentities.updateSummary,
  ),
  operation: "editMessage" as const,
  target: { _tag: "Message" as const, message: anchorMessage },
};
const cleanupReceipt = {
  deliveryKey: makeAutoCheckinTestDeliveryKey(
    invocationId,
    autoCheckinTestActionIdentities.cleanupAnchor,
  ),
  operation: "deleteMessage" as const,
  target: { _tag: "Message" as const, message: anchorMessage },
};

const preparation = (
  conversationName: string,
  options: {
    readonly status?: "sent" | "skipped";
    readonly checkin?: boolean;
    readonly roomOrder?: boolean;
  } = {},
): AutoCheckinTestPreparation => {
  const target = conversationName.toLowerCase();
  const preview = (kind: string) => ({
    conversation: conversation(`${target}-${kind}`),
    message: { content: `${conversationName} ${kind}` },
  });
  return {
    conversationName,
    runningConversationId: `${target}-running`,
    checkinConversationId: `${target}-checkin`,
    hour: 1,
    status: options.status ?? "sent",
    checkinPreview: options.checkin === false ? null : preview("checkin"),
    monitorPreview: preview("monitor"),
    tentativeRoomOrderPreview: options.roomOrder === true ? preview("room-order") : null,
    error: null,
  };
};

const sendReceipt = (
  conversationName: string,
  actionIdentity:
    | typeof autoCheckinTestActionIdentities.deliverCheckin
    | typeof autoCheckinTestActionIdentities.deliverMonitor
    | typeof autoCheckinTestActionIdentities.deliverTentativeRoomOrder,
): SendMessageReceipt => ({
  deliveryKey: makeAutoCheckinTestDeliveryKey(invocationId, actionIdentity, conversationName),
  operation: "sendMessage",
  target: {
    _tag: "Message",
    message: message(
      `${conversationName.toLowerCase()}-${actionIdentity}`,
      `${conversationName.toLowerCase()}-${actionIdentity}-message`,
    ),
  },
});

const committedPreview = (receipt: SendMessageReceipt): AutoCheckinTestPreviewDeliveryOutcome => ({
  _tag: "Committed",
  receipt,
});

const rejected = (operation: string): InteractiveDeclaredFailure => ({
  _tag: "ExternalOperationRejected",
  operation,
  code: "TestFailure",
  message: `${operation} failed`,
});
const revoked: InteractiveDeclaredFailure = {
  _tag: "AuthorizationRevoked",
  policy: CheckinsTestAuto.authorizationPolicy.policy,
};

const errorFrom = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("Expected failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

const makeAuthorization = (
  authorize: ReadOnlyWorkflowAuthorization["Service"]["authorize"],
): ReadOnlyWorkflowAuthorization["Service"] => ({
  authorize,
  authorizeSlotOpen: () => Effect.die("unused"),
  authorizeCheckinRespond: () => Effect.die("unused"),
  authorizeRoomOrdersNavigate: () => Effect.die("unused"),
  authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
  authorizeRoomOrdersSend: () => Effect.die("unused"),
  workspaceCapabilities: () => Effect.die("unused"),
});

const makeOperations = (
  bot: SheetBotHttpClient,
  authorize: ReadOnlyWorkflowAuthorization["Service"]["authorize"],
  options: {
    readonly persistence?: TrustedSheetPersistenceShape;
    readonly provider?: AutoCheckinTestProvider["Service"];
  } = {},
) => {
  const persistence = options.persistence ?? makeTrustedSheetPersistenceMock();
  return AutoCheckinTestWorkflowOperations.pipe(
    Effect.provide(autoCheckinTestWorkflowOperationsLayer),
    Effect.provideService(SheetBotCacheClient, { get: () => bot }),
    Effect.provideService(SheetBotDeliveryClient, { get: () => bot }),
    Effect.provideService(TrustedSheetPersistence, persistence),
    Effect.provideService(ReadOnlyWorkflowAuthorization, makeAuthorization(authorize)),
    Effect.provideService(
      AutoCheckinTestProvider,
      options.provider ?? {
        loadCheckin: () => Effect.die("unused"),
        loadRoomOrder: () => Effect.die("unused"),
      },
    ),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          sheetBotClientId: "discord-main",
          autoCheckinConcurrency: 2,
        }),
      ),
    ),
  );
};

const invalidAnchorCleanupError = (cleanupResult: unknown) =>
  Effect.gen(function* () {
    const bot = {
      cache: {
        getWorkspace: () =>
          Effect.succeed({
            id: workspaceId,
            name: "Workspace One",
            icon: null,
            ownerId: "owner-1",
          }),
      },
      delivery: {
        respond: ({ payload }: Parameters<SheetBotHttpClient["delivery"]["respond"]>[0]) =>
          Effect.succeed({
            deliveryKey: payload.deliveryKey,
            operation: "respond" as const,
            target: {
              _tag: "Response" as const,
              responseReference: payload.responseReference,
              message: forgedAnchor,
            },
          }),
        deleteMessage: () => Effect.succeed(cleanupResult),
      },
    } as unknown as SheetBotHttpClient;
    const operations = yield* makeOperations(bot, () => Effect.void);
    return errorFrom(
      yield* Effect.exit(
        operations.createAnchor(
          execution,
          makeAutoCheckinTestDeliveryKey(
            invocationId,
            autoCheckinTestActionIdentities.createAnchor,
          ),
        ),
      ),
    );
  });

const invalidAnchorCleanupExpectedError = {
  _tag: "DeliveryRejected",
  operation: "checkins.testAuto.create-provisional-anchor",
  message: "The response receipt did not match the authorized anchor context",
  committedReference: "forged-anchor",
  recoveryRequired: true,
} satisfies InteractiveDeclaredFailure;

const summaryFailureWorkflow = (committed: boolean, onCleanup: () => void) =>
  makeCheckinsTestAutoWorkflowBody({
    createAnchor: () => Effect.succeed(anchorReceipt),
    discover: () =>
      Effect.succeed({
        conversationNames: committed ? ["Alpha"] : [],
        concurrency: 1,
      }),
    prepare: () => Effect.succeed(preparation("Alpha", { checkin: false })),
    deliverCheckin: () => Effect.die("check-in preview was absent"),
    deliverMonitor: () =>
      Effect.succeed(
        committedPreview(sendReceipt("Alpha", autoCheckinTestActionIdentities.deliverMonitor)),
      ),
    deliverTentativeRoomOrder: () => Effect.die("room-order preview was absent"),
    updateSummary: () => Effect.fail(rejected("update-summary")),
    cleanup: () => Effect.sync(() => (onCleanup(), cleanupReceipt)),
  })(execution);

// The suite is intentionally colocated so the full workflow policy is reviewed as one contract.
// fallow-ignore-next-line complexity
const autoCheckinTestWorkflowDefinitionTests = () => {
  it("registers the pinned interactive v1 eight-action graph", () => {
    const definition = makeCheckinsTestAutoDefinition();
    expect(definition.contract).toBe(CheckinsTestAuto);
    expect(definition.workflow.name).toBe(workflowContractKey(CheckinsTestAuto));
    expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
      ["checkins.testAuto.create-provisional-anchor", "1"],
      ["checkins.testAuto.discover-targets", "1"],
      ["checkins.testAuto.prepare-target", "1"],
      ["checkins.testAuto.deliver-checkin-preview", "1"],
      ["checkins.testAuto.deliver-monitor-preview", "1"],
      ["checkins.testAuto.deliver-tentative-room-order-preview", "1"],
      ["checkins.testAuto.update-anchor-summary", "1"],
      ["checkins.testAuto.cleanup-provisional-anchor", "1"],
    ]);
    expect(CheckinsTestAuto.authorizationPolicy).toMatchObject({
      principalKinds: ["user"],
      requiredCapabilities: ["workspace.manage"],
      resource: "workspace",
      resourceField: "workspaceId",
      revalidateBeforeEffects: true,
    });
  });

  it("derives stable invocation, action, and delivery identities without array positions", () => {
    const firstInvocation = makeAutoCheckinTestInvocationId("discord-main", "interaction-1");
    expect(makeAutoCheckinTestInvocationId("discord-main", "interaction-1")).toBe(firstInvocation);
    expect(makeAutoCheckinTestInvocationId("discord-main", "interaction-2")).not.toBe(
      firstInvocation,
    );

    const alpha = makeAutoCheckinTestActionKey(
      invocationId,
      autoCheckinTestActionIdentities.prepareTarget,
      "Alpha",
    );
    expect(
      makeAutoCheckinTestActionKey(
        invocationId,
        autoCheckinTestActionIdentities.prepareTarget,
        "Alpha",
      ),
    ).toBe(alpha);
    expect(alpha).not.toContain("Alpha");
    expect(alpha).not.toBe(
      makeAutoCheckinTestActionKey(
        invocationId,
        autoCheckinTestActionIdentities.prepareTarget,
        "Beta",
      ),
    );
    expect(
      makeAutoCheckinTestDeliveryKey(
        invocationId,
        autoCheckinTestActionIdentities.deliverCheckin,
        "Alpha",
      ),
    ).not.toBe(
      makeAutoCheckinTestDeliveryKey(
        invocationId,
        autoCheckinTestActionIdentities.deliverMonitor,
        "Alpha",
      ),
    );
  });

  it.effect("rejects a forged anchor receipt and deletes its provisional message", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const bot = {
        cache: {
          getWorkspace: ({ params }: { readonly params: { readonly workspaceId: string } }) =>
            Effect.sync(() => {
              effects.push(`workspace:${params.workspaceId}`);
              return { id: workspaceId, name: "Workspace One", icon: null, ownerId: "owner-1" };
            }),
        },
        delivery: {
          respond: ({ payload }: Parameters<SheetBotHttpClient["delivery"]["respond"]>[0]) =>
            Effect.sync(() => {
              effects.push(`respond:${payload.workspace?.client.clientId}`);
              return {
                deliveryKey: payload.deliveryKey,
                operation: "respond" as const,
                target: {
                  _tag: "Response" as const,
                  responseReference: payload.responseReference,
                  message: forgedAnchor,
                },
              };
            }),
          deleteMessage: ({
            payload,
          }: Parameters<SheetBotHttpClient["delivery"]["deleteMessage"]>[0]) =>
            Effect.sync(() => {
              effects.push(`delete:${payload.message.messageId}`);
              return {
                deliveryKey: payload.deliveryKey,
                operation: "deleteMessage" as const,
                target: { _tag: "Message" as const, message: payload.message },
              };
            }),
        },
      } as unknown as SheetBotHttpClient;
      const operations = yield* makeOperations(bot, () =>
        Effect.sync(() => effects.push("authorize")),
      );
      const exit = yield* Effect.exit(
        operations.createAnchor(
          execution,
          makeAutoCheckinTestDeliveryKey(
            invocationId,
            autoCheckinTestActionIdentities.createAnchor,
          ),
        ),
      );

      expect(errorFrom(exit)).toEqual({
        _tag: "DeliveryRejected",
        operation: "checkins.testAuto.create-provisional-anchor",
        message: "The response receipt did not match the authorized anchor context",
        recoveryRequired: false,
      });
      expect(effects).toEqual([
        "workspace:workspace-1",
        "authorize",
        "respond:discord-main",
        "authorize",
        "delete:forged-anchor",
      ]);
    }),
  );

  it.effect("reports recovery when invalid-anchor cleanup returns a mismatched delivery key", () =>
    Effect.gen(function* () {
      const error = yield* invalidAnchorCleanupError({
        deliveryKey: makeAutoCheckinTestDeliveryKey(
          invocationId,
          autoCheckinTestActionIdentities.createAnchor,
        ),
        operation: "deleteMessage",
        target: { _tag: "Message", message: forgedAnchor },
      });

      expect(error).toEqual(invalidAnchorCleanupExpectedError);
    }),
  );

  it.effect("reports recovery when invalid-anchor cleanup returns a mismatched operation", () =>
    Effect.gen(function* () {
      const error = yield* invalidAnchorCleanupError({
        deliveryKey: cleanupReceipt.deliveryKey,
        operation: "editMessage",
        target: { _tag: "Message", message: forgedAnchor },
      });

      expect(error).toEqual(invalidAnchorCleanupExpectedError);
    }),
  );

  it.effect("reports recovery when invalid-anchor cleanup returns a mismatched message", () =>
    Effect.gen(function* () {
      const error = yield* invalidAnchorCleanupError({
        deliveryKey: cleanupReceipt.deliveryKey,
        operation: "deleteMessage",
        target: { _tag: "Message", message: message("forged-conversation", "other-anchor") },
      });

      expect(error).toEqual(invalidAnchorCleanupExpectedError);
    }),
  );

  it.effect("reauthorizes immediately before each preview delivery and validates its receipt", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const prepared = preparation("Alpha", { checkin: false });
      const bot = {
        delivery: {
          sendMessage: ({
            payload,
          }: Parameters<SheetBotHttpClient["delivery"]["sendMessage"]>[0]) =>
            Effect.sync(() => {
              effects.push(`send:${payload.conversation.conversationId}`);
              return {
                deliveryKey: payload.deliveryKey,
                operation: "sendMessage" as const,
                target: {
                  _tag: "Message" as const,
                  message: {
                    conversation: payload.conversation,
                    messageId: "monitor-message",
                  },
                },
              };
            }),
        },
      } as unknown as SheetBotHttpClient;
      const operations = yield* makeOperations(bot, () =>
        Effect.sync(() => effects.push("authorize")),
      );
      const outcome = yield* operations.deliverMonitorPreview(
        { ...execution, anchor: anchorMessage, conversationName: "Alpha", preparation: prepared },
        makeAutoCheckinTestDeliveryKey(
          invocationId,
          autoCheckinTestActionIdentities.deliverMonitor,
          "Alpha",
        ),
      );

      expect(outcome).toEqual({
        _tag: "Committed",
        receipt: expect.objectContaining({
          target: expect.objectContaining({
            message: expect.objectContaining({ messageId: "monitor-message" }),
          }),
        }),
      });
      expect(effects).toEqual(["authorize", "send:alpha-monitor"]);
    }),
  );

  it.effect("re-propagates an interrupted preview delivery", () =>
    Effect.gen(function* () {
      const prepared = preparation("Alpha", { checkin: false });
      const bot = {
        delivery: {
          sendMessage: () => Effect.failCause(Cause.interrupt(19)),
        },
      } as unknown as SheetBotHttpClient;
      const operations = yield* makeOperations(bot, () => Effect.void);
      const exit = yield* Effect.exit(
        operations.deliverMonitorPreview(
          { ...execution, anchor: anchorMessage, conversationName: "Alpha", preparation: prepared },
          makeAutoCheckinTestDeliveryKey(
            invocationId,
            autoCheckinTestActionIdentities.deliverMonitor,
            "Alpha",
          ),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }
    }),
  );

  it.effect("preserves an ambiguous preview write after an invalid receipt", () =>
    Effect.gen(function* () {
      const effects: Array<string> = [];
      const outcomes: Array<AutoCheckinTestPreviewDeliveryOutcome> = [];
      const summaryCommitStates: Array<boolean> = [];
      let cleanupCalls = 0;
      const prepared = preparation("Alpha", { checkin: false });
      const deliveryKey = makeAutoCheckinTestDeliveryKey(
        invocationId,
        autoCheckinTestActionIdentities.deliverMonitor,
        "Alpha",
      );
      const bot = {
        delivery: {
          sendMessage: ({
            payload,
          }: Parameters<SheetBotHttpClient["delivery"]["sendMessage"]>[0]) =>
            Effect.sync(() => {
              effects.push(`send:${payload.conversation.conversationId}`);
              return {
                deliveryKey: makeAutoCheckinTestDeliveryKey(
                  invocationId,
                  autoCheckinTestActionIdentities.deliverCheckin,
                  "Alpha",
                ),
                operation: "sendMessage" as const,
                target: {
                  _tag: "Message" as const,
                  message: {
                    conversation: payload.conversation,
                    messageId: "recorded-preview",
                  },
                },
              };
            }),
        },
      } as unknown as SheetBotHttpClient;
      const operations = yield* makeOperations(bot, () =>
        Effect.sync(() => effects.push("authorize")),
      );
      const exit = yield* Effect.exit(
        makeCheckinsTestAutoWorkflowBody({
          createAnchor: () => Effect.succeed(anchorReceipt),
          discover: () => Effect.succeed({ conversationNames: ["Alpha"], concurrency: 1 }),
          prepare: () => Effect.succeed(prepared),
          deliverCheckin: () => Effect.die("check-in preview was absent"),
          deliverMonitor: (preparedExecution) =>
            preserveInteractiveDeclaredFailure(
              operations.deliverMonitorPreview(preparedExecution, deliveryKey),
            ).pipe(Effect.tap((outcome) => Effect.sync(() => outcomes.push(outcome)))),
          deliverTentativeRoomOrder: () => Effect.die("room-order preview was absent"),
          updateSummary: ({ previewMayHaveCommitted }) =>
            Effect.sync(() => summaryCommitStates.push(previewMayHaveCommitted)).pipe(
              Effect.andThen(Effect.fail(rejected("update-summary"))),
            ),
          cleanup: () =>
            Effect.sync(() => {
              cleanupCalls += 1;
              return cleanupReceipt;
            }),
        })(execution),
      );

      expect(errorFrom(exit)).toEqual(rejected("update-summary"));
      expect(outcomes).toEqual([
        {
          _tag: "Unknown",
          failure: {
            _tag: "DeliveryRejected",
            operation: "checkins.testAuto.deliver-monitor-preview",
            message: "The preview receipt did not match the requested delivery",
            committedReference: "recorded-preview",
            recoveryRequired: true,
          },
        },
      ]);
      expect(summaryCommitStates).toEqual([true]);
      expect(cleanupCalls).toBe(0);
      expect(effects).toEqual(["authorize", "send:alpha-monitor"]);
    }),
  );

  it.effect("accepts a replayed bare preview receipt as committed", () =>
    Effect.gen(function* () {
      const legacyReceipt = sendReceipt("Alpha", autoCheckinTestActionIdentities.deliverMonitor);
      const summaryCommitStates: Array<boolean> = [];
      const result = Schema.decodeUnknownSync(CheckinsTestAuto.success)(
        yield* makeCheckinsTestAutoWorkflowBody({
          createAnchor: () => Effect.succeed(anchorReceipt),
          discover: () => Effect.succeed({ conversationNames: ["Alpha"], concurrency: 1 }),
          prepare: () => Effect.succeed(preparation("Alpha", { checkin: false })),
          deliverCheckin: () => Effect.die("check-in preview was absent"),
          deliverMonitor: () => Effect.succeed(legacyReceipt),
          deliverTentativeRoomOrder: () => Effect.die("room-order preview was absent"),
          updateSummary: ({ previewMayHaveCommitted }) =>
            Effect.sync(() => {
              summaryCommitStates.push(previewMayHaveCommitted);
              return summaryReceipt;
            }),
          cleanup: () => Effect.die("replayed committed preview cleaned its anchor"),
        })(execution),
      );

      expect(result.deliveryReceipts).toEqual([anchorReceipt, legacyReceipt, summaryReceipt]);
      expect(summaryCommitStates).toEqual([true]);
    }),
  );

  it.effect("keeps check-in and monitor previews when optional room-order entries are empty", () =>
    Effect.gen(function* () {
      const persistence = makeTrustedSheetPersistenceMock();
      yield* persistence.workspaces.upsertWorkspaceConfig({ workspaceId, sheetId: "sheet-1" });
      yield* persistence.workspaces.upsertWorkspaceConversationConfig({
        workspaceId,
        conversationId: "running-1",
        name: "Alpha",
        running: true,
      });
      const fills = globalThis.Array.from({ length: 5 }, (_, index) => ({
        accountId: `member-${index}`,
        name: `Member ${index}`,
      }));
      const operations = yield* makeOperations({} as SheetBotHttpClient, () => Effect.void, {
        persistence,
        provider: {
          loadCheckin: () =>
            Effect.succeed({
              eventStartEpochMs: 0,
              schedules: [
                {
                  hour: 1,
                  fills,
                  overfillCount: 0,
                  monitor: { accountId: "monitor-1", name: "Monitor" },
                },
              ],
            }),
          loadRoomOrder: () =>
            Effect.succeed({
              eventStartEpochMs: 0,
              schedules: [
                {
                  hour: 1,
                  fills: [],
                  monitor: null,
                },
              ],
              teamsByPlayerName: new Map(),
            }),
        },
      });

      const result = yield* operations.prepareTarget({
        ...execution,
        anchor: anchorMessage,
        conversationName: "Alpha",
      });
      expect(result.status).toBe("sent");
      expect(result.checkinPreview).not.toBeNull();
      expect(result.monitorPreview).not.toBeNull();
      expect(result.tentativeRoomOrderPreview).toBeNull();
    }),
  );

  it.effect("collects sent, skipped, and target failures and edits the aggregate anchor last", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const body = makeCheckinsTestAutoWorkflowBody({
        createAnchor: () => Effect.sync(() => (calls.push("anchor"), anchorReceipt)),
        discover: () =>
          Effect.sync(
            () => (
              calls.push("discover"),
              { conversationNames: ["Alpha", "Broken", "Skipped"], concurrency: 1 }
            ),
          ),
        prepare: ({ conversationName }) =>
          Effect.sync(() => calls.push(`prepare:${conversationName}`)).pipe(
            Effect.andThen(
              conversationName === "Broken"
                ? Effect.fail(rejected("prepare"))
                : Effect.succeed(
                    preparation(conversationName, {
                      status: conversationName === "Skipped" ? "skipped" : "sent",
                      checkin: conversationName !== "Skipped",
                      roomOrder: conversationName === "Alpha",
                    }),
                  ),
            ),
          ),
        deliverCheckin: ({ preparation: current }) =>
          Effect.sync(
            () => (
              calls.push(`checkin:${current.conversationName}`),
              committedPreview(
                sendReceipt(
                  current.conversationName,
                  autoCheckinTestActionIdentities.deliverCheckin,
                ),
              )
            ),
          ),
        deliverMonitor: ({ preparation: current }) =>
          Effect.sync(
            () => (
              calls.push(`monitor:${current.conversationName}`),
              committedPreview(
                sendReceipt(
                  current.conversationName,
                  autoCheckinTestActionIdentities.deliverMonitor,
                ),
              )
            ),
          ),
        deliverTentativeRoomOrder: ({ preparation: current }) =>
          Effect.sync(
            () => (
              calls.push(`room:${current.conversationName}`),
              committedPreview(
                sendReceipt(
                  current.conversationName,
                  autoCheckinTestActionIdentities.deliverTentativeRoomOrder,
                ),
              )
            ),
          ),
        updateSummary: ({ conversations }) =>
          Effect.sync(() => {
            calls.push(`summary:${conversations.map(({ status }) => status).join(",")}`);
            return summaryReceipt;
          }),
        cleanup: () => Effect.die("successful run cleaned its anchor"),
      });

      const result = Schema.decodeUnknownSync(CheckinsTestAuto.success)(yield* body(execution));
      expect(result).toMatchObject({
        workspaceId,
        hour: 1,
        conversationCount: 3,
        sentCount: 1,
        skippedCount: 1,
        failedCount: 1,
        conversations: [
          { conversationName: "Alpha", status: "sent" },
          {
            conversationName: "Broken",
            status: "failed",
            error: "Test run failed; see server logs.",
          },
          { conversationName: "Skipped", status: "skipped" },
        ],
      });
      expect(result.deliveryReceipts).toHaveLength(6);
      expect(calls).toEqual([
        "anchor",
        "discover",
        "prepare:Alpha",
        "checkin:Alpha",
        "monitor:Alpha",
        "room:Alpha",
        "prepare:Broken",
        "prepare:Skipped",
        "monitor:Skipped",
        "summary:sent,failed,skipped",
      ]);
    }),
  );

  it.effect("preserves an earlier preview receipt when a later target delivery fails", () =>
    Effect.gen(function* () {
      const checkinReceipt = sendReceipt("Alpha", autoCheckinTestActionIdentities.deliverCheckin);
      let roomOrderCalls = 0;
      const result = Schema.decodeUnknownSync(CheckinsTestAuto.success)(
        yield* makeCheckinsTestAutoWorkflowBody({
          createAnchor: () => Effect.succeed(anchorReceipt),
          discover: () => Effect.succeed({ conversationNames: ["Alpha"], concurrency: 1 }),
          prepare: () => Effect.succeed(preparation("Alpha", { roomOrder: true })),
          deliverCheckin: () => Effect.succeed(committedPreview(checkinReceipt)),
          deliverMonitor: () => Effect.fail(rejected("deliver-monitor")),
          deliverTentativeRoomOrder: () =>
            Effect.sync(() => {
              roomOrderCalls += 1;
              return committedPreview(
                sendReceipt("Alpha", autoCheckinTestActionIdentities.deliverTentativeRoomOrder),
              );
            }),
          updateSummary: () => Effect.succeed(summaryReceipt),
          cleanup: () => Effect.die("committed preview cleaned its anchor"),
        })(execution),
      );

      expect(result.conversations).toEqual([
        expect.objectContaining({ conversationName: "Alpha", status: "failed" }),
      ]);
      expect(result.deliveryReceipts).toEqual([anchorReceipt, checkinReceipt, summaryReceipt]);
      expect(roomOrderCalls).toBe(0);
    }),
  );

  it.effect(
    "cleans the provisional anchor when authorization is lost before any preview commits",
    () =>
      Effect.gen(function* () {
        let cleanupCalls = 0;
        const exit = yield* Effect.exit(
          makeCheckinsTestAutoWorkflowBody({
            createAnchor: () => Effect.succeed(anchorReceipt),
            discover: () => Effect.succeed({ conversationNames: ["Alpha"], concurrency: 1 }),
            prepare: () => Effect.fail(revoked),
            deliverCheckin: () => Effect.die("revoked preparation delivered"),
            deliverMonitor: () => Effect.die("revoked preparation delivered"),
            deliverTentativeRoomOrder: () => Effect.die("revoked preparation delivered"),
            updateSummary: () => Effect.die("revoked workflow summarized"),
            cleanup: () =>
              Effect.sync(() => {
                cleanupCalls += 1;
                return cleanupReceipt;
              }),
          })(execution),
        );
        expect(errorFrom(exit)).toEqual(revoked);
        expect(cleanupCalls).toBe(1);
      }),
  );

  it.effect("preserves the original failure when provisional anchor cleanup also fails", () =>
    Effect.gen(function* () {
      const originalFailure = rejected("discover");
      let cleanupCalls = 0;
      const exit = yield* Effect.exit(
        makeCheckinsTestAutoWorkflowBody({
          createAnchor: () => Effect.succeed(anchorReceipt),
          discover: () => Effect.fail(originalFailure),
          prepare: () => Effect.die("failed discovery prepared a target"),
          deliverCheckin: () => Effect.die("failed discovery delivered a preview"),
          deliverMonitor: () => Effect.die("failed discovery delivered a preview"),
          deliverTentativeRoomOrder: () => Effect.die("failed discovery delivered a preview"),
          updateSummary: () => Effect.die("failed discovery updated the summary"),
          cleanup: () =>
            Effect.sync(() => {
              cleanupCalls += 1;
            }).pipe(Effect.andThen(Effect.fail(rejected("cleanup")))),
        })(execution),
      );
      expect(errorFrom(exit)).toEqual(originalFailure);
      expect(cleanupCalls).toBe(1);
    }),
  );

  it.effect("uses forward recovery after a preview commits and later authorization is lost", () =>
    Effect.gen(function* () {
      let cleanupCalls = 0;
      const alphaReceipt = sendReceipt("Alpha", autoCheckinTestActionIdentities.deliverMonitor);
      const exit = yield* Effect.exit(
        makeCheckinsTestAutoWorkflowBody({
          createAnchor: () => Effect.succeed(anchorReceipt),
          discover: () => Effect.succeed({ conversationNames: ["Alpha", "Beta"], concurrency: 1 }),
          prepare: ({ conversationName }) =>
            conversationName === "Beta"
              ? Effect.fail(revoked)
              : Effect.succeed(preparation("Alpha", { checkin: false })),
          deliverCheckin: () => Effect.die("check-in preview was absent"),
          deliverMonitor: () => Effect.succeed(committedPreview(alphaReceipt)),
          deliverTentativeRoomOrder: () => Effect.die("room-order preview was absent"),
          updateSummary: () => Effect.die("authorization failure summarized"),
          cleanup: () =>
            Effect.sync(() => {
              cleanupCalls += 1;
              return cleanupReceipt;
            }),
        })(execution),
      );
      expect(errorFrom(exit)).toEqual(revoked);
      expect(cleanupCalls).toBe(0);
    }),
  );

  it.effect("treats a replayed recovery-required delivery failure as an ambiguous commit", () =>
    Effect.gen(function* () {
      let cleanupCalls = 0;
      const summaryCommitStates: Array<boolean> = [];
      const exit = yield* Effect.exit(
        makeCheckinsTestAutoWorkflowBody({
          createAnchor: () => Effect.succeed(anchorReceipt),
          discover: () => Effect.succeed({ conversationNames: ["Alpha"], concurrency: 1 }),
          prepare: () => Effect.succeed(preparation("Alpha", { checkin: false })),
          deliverCheckin: () => Effect.die("check-in preview was absent"),
          deliverMonitor: () =>
            Effect.fail({
              _tag: "DeliveryRejected" as const,
              operation: "checkins.testAuto.deliver-monitor-preview",
              message: "The preview delivery outcome is unknown",
              committedReference: "legacy-preview",
              recoveryRequired: true,
            }),
          deliverTentativeRoomOrder: () => Effect.die("room-order preview was absent"),
          updateSummary: ({ previewMayHaveCommitted }) =>
            Effect.sync(() => summaryCommitStates.push(previewMayHaveCommitted)).pipe(
              Effect.andThen(Effect.fail(rejected("update-summary"))),
            ),
          cleanup: () =>
            Effect.sync(() => {
              cleanupCalls += 1;
              return cleanupReceipt;
            }),
        })(execution),
      );

      expect(errorFrom(exit)).toEqual(rejected("update-summary"));
      expect(summaryCommitStates).toEqual([true]);
      expect(cleanupCalls).toBe(0);
    }),
  );

  it.effect("cleans a summary failure before the first preview commit", () =>
    Effect.gen(function* () {
      let cleanupCalls = 0;
      const exit = yield* Effect.exit(
        summaryFailureWorkflow(false, () => {
          cleanupCalls += 1;
        }),
      );
      expect(errorFrom(exit)).toEqual(rejected("update-summary"));
      expect(cleanupCalls).toBe(1);
    }),
  );

  it.effect("does not clean a summary failure after the first preview commit", () =>
    Effect.gen(function* () {
      let cleanupCalls = 0;
      const exit = yield* Effect.exit(
        summaryFailureWorkflow(true, () => {
          cleanupCalls += 1;
        }),
      );
      expect(errorFrom(exit)).toEqual(rejected("update-summary"));
      expect(cleanupCalls).toBe(0);
    }),
  );
};

describe("auto-checkin test Workflow Definition slice", autoCheckinTestWorkflowDefinitionTests);
