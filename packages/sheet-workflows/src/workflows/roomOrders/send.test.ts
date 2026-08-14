import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  BotDependencyUnavailable,
  type SheetBotHttpClient,
  ResponseReference,
  messageRefFrom,
} from "sheet-bot-api";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { RoomOrdersSend, WorkspaceId } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeSheetApisClient, makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { authorizeRoomOrdersSendWorkflow } from "../shared/interactive";
import {
  roomOrderRow,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { makeRoomOrdersSendDefinition, makeRoomOrdersSendWorkflowBody } from "./sendDefinition";
import { makeRoomOrderSendClaimId, makeRoomOrderSendDeliveryKey } from "./keys";
import { roomOrderSendOperationsLayer } from "./sendOperations";
import { RoomOrderNavigationProvider } from "./provider";
import { RoomOrderSendExecution } from "./sendSchema";
import { RoomOrderSendOperations } from "./sendService";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const input = Schema.decodeUnknownSync(RoomOrdersSend.input)({
  workspaceId: "forged-workspace",
  messageId: "message-1",
  messageConversationId: "forged-conversation",
  messageContent: "forged content",
  responseReference,
});
const execution = Schema.decodeUnknownSync(RoomOrderSendExecution)({
  invocationId,
  principal,
  input,
});
const context = {
  clientPlatform: "discord" as const,
  clientId: "discord-main",
  messageId: "message-1",
  workspaceId,
  conversationId: "conversation-1",
  previousFills: ["Miku"],
  fills: ["Rin"],
  hour: 2,
  rank: 3,
  tentative: false,
  monitor: "Luka",
  sendClaimId: null,
  sentMessageId: null,
  sentConversationId: null,
  tentativeUpdateClaimId: null,
  tentativePinClaimId: null,
  tentativePinnedAt: null,
};
const claimId = makeRoomOrderSendClaimId(invocationId);
const claim = { context, claimId, status: "claimed" as const, detail: null };
const view = { context, claimId, message: { content: "published room order" } };
const sentMessage = messageRefFrom(
  { platform: context.clientPlatform, clientId: context.clientId },
  workspaceId,
  context.conversationId,
  "sent-message-1",
);
const sendReceipt = {
  deliveryKey: makeRoomOrderSendDeliveryKey(invocationId, "send-room-order-message"),
  operation: "sendMessage" as const,
  target: { _tag: "Message" as const, message: sentMessage },
};
const commit = {
  context,
  claimId,
  source: "sent" as const,
  sentMessage,
  sendReceipt,
};
const pinReceipt = {
  deliveryKey: makeRoomOrderSendDeliveryKey(invocationId, "pin-sent-room-order"),
  operation: "setMessagePinned" as const,
  target: { _tag: "Message" as const, message: sentMessage },
};
const respondReceipt = {
  deliveryKey: makeRoomOrderSendDeliveryKey(invocationId, "respond"),
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};
const record = { commit, status: "tracked" as const, detail: null };
const pin = { commit, status: "pinned" as const, receipt: pinReceipt };

const deliveryRejected = (operation: string, recoveryRequired: boolean) => ({
  _tag: "DeliveryRejected" as const,
  operation,
  message: `${operation} rejected`,
  ...(recoveryRequired ? { committedReference: sentMessage.messageId } : {}),
  recoveryRequired,
});

const makeDeliveryBot = (delivery: Record<string, unknown> = {}): SheetBotHttpClient =>
  ({
    delivery: new Proxy(delivery, {
      get: (target, method: string) =>
        method in target ? target[method] : () => Effect.die(`Unexpected delivery call: ${method}`),
    }),
  }) as unknown as SheetBotHttpClient;

const makeOperations = (
  persistence: TrustedSheetPersistenceShape,
  delivery: Record<string, unknown> = {},
) =>
  RoomOrderSendOperations.pipe(
    Effect.provide(roomOrderSendOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(
      Layer.succeed(RoomOrderNavigationProvider, { loadEventStart: () => Effect.succeed(0) }),
    ),
    Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => makeDeliveryBot(delivery) })),
  );

describe("room-order send Workflow Definition slice", () => {
  it.effect("registers seven pinned policy-v2 actions with stable identities", () =>
    Effect.gen(function* () {
      const definition = makeRoomOrdersSendDefinition();
      expect(RoomOrdersSend.authorizationPolicy).toMatchObject({
        version: "2",
        requiredCapabilities: ["workspace.monitor"],
        resource: "message",
        resourceField: "messageId",
      });
      expect(definition.workflow.name).toBe(workflowContractKey(RoomOrdersSend));
      expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
        ["roomOrders.send.claim-send", "1"],
        ["roomOrders.send.load-send-view", "1"],
        ["roomOrders.send.send-room-order-message", "1"],
        ["roomOrders.send.record-room-order-send", "1"],
        ["roomOrders.send.pin-sent-room-order", "1"],
        ["roomOrders.send.respond", "1"],
        ["roomOrders.send.release-send-claim", "1"],
      ]);

      const actionInput = {
        ...execution,
        claim,
        view,
        commit,
        response: {
          context,
          commit,
          sourceMessageId: context.messageId,
          sourceConversationId: context.conversationId,
          resultMessageId: sentMessage.messageId,
          resultConversationId: sentMessage.conversation.conversationId,
          status: "pinned" as const,
          detail: "sent room order and pinned it!",
          message: { content: "sent room order and pinned it!" },
        },
      };
      const first = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(actionInput),
      );
      const replay = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(actionInput),
      );
      expect(replay).toEqual(first);
      expect(new Set(first).size).toBe(7);
      expect(claimId).toContain(String(invocationId));
      expect(sendReceipt.deliveryKey).not.toBe(pinReceipt.deliveryKey);
      expect(pinReceipt.deliveryKey).not.toBe(respondReceipt.deliveryKey);
    }),
  );

  it.effect("uses the send receipt as commit and returns deterministic delivery evidence", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const result = yield* makeRoomOrdersSendWorkflowBody({
        claim: () => Effect.sync(() => (calls.push("claim"), claim)),
        load: () => Effect.sync(() => (calls.push("load"), view)),
        send: () => Effect.sync(() => (calls.push("send"), commit)),
        record: () => Effect.sync(() => (calls.push("record"), record)),
        pin: () => Effect.sync(() => (calls.push("pin"), pin)),
        respond: () => Effect.sync(() => (calls.push("respond"), respondReceipt)),
        release: () => Effect.die("committed claim release"),
      })(execution);

      expect(calls.slice(0, 3)).toEqual(["claim", "load", "send"]);
      expect(calls.indexOf("record")).toBeLessThan(calls.indexOf("respond"));
      expect(calls.indexOf("pin")).toBeLessThan(calls.indexOf("respond"));
      expect(result).toEqual({
        messageId: sentMessage.messageId,
        messageConversationId: sentMessage.conversation.conversationId,
        status: "pinned",
        detail: "sent room order and pinned it!",
        deliveryReceipts: [sendReceipt, pinReceipt, respondReceipt],
      });
    }),
  );

  it.effect("acknowledges busy denial without entering the send graph", () =>
    Effect.gen(function* () {
      const detail = "room order is already being sent.";
      const result = yield* makeRoomOrdersSendWorkflowBody({
        claim: () => Effect.succeed({ ...claim, status: "denied" as const, detail }),
        load: () => Effect.die("denied load"),
        send: () => Effect.die("denied send"),
        record: () => Effect.die("denied record"),
        pin: () => Effect.die("denied pin"),
        respond: () => Effect.succeed(respondReceipt),
        release: () => Effect.die("unowned claim release"),
      })(execution);
      expect(result).toMatchObject({ status: "denied", detail });
      expect(result.deliveryReceipts).toEqual([respondReceipt]);
    }),
  );

  it.effect("never resends an already-sent room order and pins its persisted reference", () =>
    Effect.gen(function* () {
      const alreadySentContext = {
        ...context,
        sentMessageId: sentMessage.messageId,
        sentConversationId: sentMessage.conversation.conversationId,
      };
      const result = yield* makeRoomOrdersSendWorkflowBody({
        claim: () =>
          Effect.succeed({
            ...claim,
            context: alreadySentContext,
            status: "already-sent" as const,
          }),
        load: () => Effect.die("already-sent load"),
        send: () => Effect.die("already-sent resend"),
        record: () => Effect.die("already-sent record"),
        pin: ({ commit: persisted }) =>
          Effect.succeed({ commit: persisted, status: "pinned" as const, receipt: pinReceipt }),
        respond: () => Effect.succeed(respondReceipt),
        release: () => Effect.die("already-sent release"),
      })(execution);
      expect(result).toMatchObject({
        messageId: sentMessage.messageId,
        status: "pinned",
        detail: "room order was already sent and is now pinned.",
      });
      expect(result.deliveryReceipts).toEqual([pinReceipt, respondReceipt]);
    }),
  );

  it.effect("releases a pre-commit claim after render or confirmed-delivery failure", () =>
    Effect.gen(function* () {
      for (const failureAt of ["load", "send"] as const) {
        let released = false;
        const exit = yield* Effect.exit(
          makeRoomOrdersSendWorkflowBody({
            claim: () => Effect.succeed(claim),
            load: () =>
              failureAt === "load"
                ? Effect.fail({
                    _tag: "ExternalOperationRejected" as const,
                    operation: "roomOrders.send.loadSendView",
                    code: "ProviderRejected",
                    message: "render failed",
                  })
                : Effect.succeed(view),
            send: () =>
              failureAt === "send"
                ? Effect.fail(deliveryRejected("roomOrders.send.sendRoomOrderMessage", false))
                : Effect.succeed(commit),
            record: () => Effect.die("pre-commit record"),
            pin: () => Effect.die("pre-commit pin"),
            respond: () => Effect.die("pre-commit respond"),
            release: () => Effect.sync(() => void (released = true)),
          })(execution),
        );
        expect(released).toBe(true);
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect("preserves the claim when delivery rejection is ambiguous", () =>
    Effect.gen(function* () {
      let released = false;
      const rejection = deliveryRejected("roomOrders.send.sendRoomOrderMessage", true);
      const exit = yield* Effect.exit(
        makeRoomOrdersSendWorkflowBody({
          claim: () => Effect.succeed(claim),
          load: () => Effect.succeed(view),
          send: () => Effect.fail(rejection),
          record: () => Effect.die("ambiguous record"),
          pin: () => Effect.die("ambiguous pin"),
          respond: () => Effect.die("ambiguous respond"),
          release: () => Effect.sync(() => void (released = true)),
        })(execution),
      );
      expect(released).toBe(false);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual(rejection);
      }
    }),
  );

  it.effect("pins only while the send claim or persisted sent binding owns the commit", () =>
    Effect.gen(function* () {
      let current = roomOrderRow({ sendClaimId: `${claimId}:replacement` });
      let pinCalls = 0;
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          getMessageRoomOrder: () => Effect.succeed(Option.some(current)),
        },
      };
      const operations = yield* makeOperations(persistence, {
        setMessagePinned: () =>
          Effect.sync(() => {
            pinCalls += 1;
            return pinReceipt;
          }),
      });

      const staleExit = yield* Effect.exit(
        operations.pin(commit, pinReceipt.deliveryKey, RoomOrdersSend.authorizationPolicy.policy),
      );
      expect(Exit.isFailure(staleExit)).toBe(true);
      if (Exit.isFailure(staleExit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(staleExit.cause))).toMatchObject({
          _tag: "AuthorizationRevoked",
        });
      }
      expect(pinCalls).toBe(0);

      current = roomOrderRow({ sendClaimId: claimId });
      yield* operations.pin(
        commit,
        pinReceipt.deliveryKey,
        RoomOrdersSend.authorizationPolicy.policy,
      );
      current = roomOrderRow({
        sentMessageId: sentMessage.messageId,
        sentConversationId: sentMessage.conversation.conversationId,
      });
      yield* operations.pin(
        commit,
        pinReceipt.deliveryKey,
        RoomOrdersSend.authorizationPolicy.policy,
      );
      expect(pinCalls).toBe(2);
    }),
  );

  it.effect("reports tracking or pinning recovery as a committed partial result", () =>
    Effect.gen(function* () {
      const recovery = {
        commit,
        status: "recovery-required" as const,
        detail: "sent room order, but tracking could not be confirmed; the claim was preserved.",
      };
      const result = yield* makeRoomOrdersSendWorkflowBody({
        claim: () => Effect.succeed(claim),
        load: () => Effect.succeed(view),
        send: () => Effect.succeed(commit),
        record: () => Effect.succeed(recovery),
        pin: () => Effect.succeed({ commit, status: "rejected" as const, receipt: null }),
        respond: () => Effect.succeed(respondReceipt),
        release: () => Effect.die("committed release"),
      })(execution);
      expect(result).toMatchObject({ status: "partial", detail: recovery.detail });
      expect(result.deliveryReceipts).toEqual([sendReceipt, respondReceipt]);
    }),
  );

  it.effect("gives authorization revocation precedence across post-commit failures", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeRoomOrdersSendWorkflowBody({
          claim: () => Effect.succeed(claim),
          load: () => Effect.succeed(view),
          send: () => Effect.succeed(commit),
          record: () =>
            Effect.fail({
              _tag: "AuthorizationRevoked" as const,
              policy: RoomOrdersSend.authorizationPolicy.policy,
            }),
          pin: () => Effect.fail(deliveryRejected("roomOrders.send.pinSentRoomOrder", true)),
          respond: () => Effect.fail(deliveryRejected("roomOrders.send.respond", true)),
          release: () => Effect.die("committed release"),
        })(execution),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual({
          _tag: "AuthorizationRevoked",
          policy: RoomOrdersSend.authorizationPolicy.policy,
        });
      }
    }),
  );

  it.effect("serializes send claims and targets the canonical conversation", () =>
    Effect.gen(function* () {
      let current = roomOrderRow();
      let sentPayload: unknown;
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          getMessageRoomOrder: () => Effect.succeed(Option.some(current)),
          claimMessageRoomOrderSend: ({ claimId: requestedClaim }) =>
            Effect.sync(() => {
              if (current.sendClaimId === null)
                current = { ...current, sendClaimId: requestedClaim };
            }),
        },
      };
      const operations = yield* makeOperations(persistence, {
        sendMessage: ({ payload }: { readonly payload: unknown }) =>
          Effect.sync(() => {
            sentPayload = payload;
            return sendReceipt;
          }),
      });
      const first = yield* operations.claim(
        context,
        claimId,
        RoomOrdersSend.authorizationPolicy.policy,
      );
      const replay = yield* operations.claim(
        context,
        claimId,
        RoomOrdersSend.authorizationPolicy.policy,
      );
      const competing = yield* operations.claim(
        context,
        `${claimId}:competing`,
        RoomOrdersSend.authorizationPolicy.policy,
      );
      expect(first).toMatchObject({ status: "claimed", claimId });
      expect(replay).toEqual(first);
      expect(competing).toMatchObject({
        status: "denied",
        detail: "room order is already being sent.",
      });

      const committed = yield* operations.send(
        { ...view, context: first.context },
        sendReceipt.deliveryKey,
        RoomOrdersSend.authorizationPolicy.policy,
      );
      expect(committed.sentMessage).toEqual(sentMessage);
      expect(sentPayload).toMatchObject({
        conversation: {
          workspace: { workspaceId, client: { clientId: context.clientId } },
          conversationId: context.conversationId,
        },
        deliveryKey: sendReceipt.deliveryKey,
      });
    }),
  );

  it.effect("preserves replay-time monitor authorization dependency failure for retry", () =>
    Effect.gen(function* () {
      const dependencyFailure = new BotDependencyUnavailable({ message: "cache unavailable" });
      const exit = yield* authorizeRoomOrdersSendWorkflow(execution).pipe(
        Effect.provideService(ReadOnlyWorkflowAuthorization, {
          authorize: () => Effect.die("unused"),
          authorizeSlotOpen: () => Effect.die("unused"),
          authorizeCheckinRespond: () => Effect.die("unused"),
          authorizeRoomOrdersNavigate: () => Effect.die("unused"),
          authorizeRoomOrdersPinTentative: () => Effect.die("unused"),
          authorizeRoomOrdersSend: () => Effect.fail(dependencyFailure),
          workspaceCapabilities: () => Effect.die("unused"),
        }),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(dependencyFailure);
      }
    }),
  );
});
