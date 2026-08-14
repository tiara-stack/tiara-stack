import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { type SheetBotHttpClient, ResponseReference, messageRefFrom } from "sheet-bot-api";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { RoomOrdersPinTentative, WorkspaceId } from "sheet-workflow-contracts";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeSheetApisClient, makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import {
  roomOrderRow,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import {
  makeRoomOrdersPinTentativeDefinition,
  makeRoomOrdersPinTentativeWorkflowBody,
} from "./pinTentativeDefinition";
import { makeRoomOrderTentativePinClaimId, makeRoomOrderTentativePinDeliveryKey } from "./keys";
import { roomOrderTentativePinOperationsLayer } from "./pinTentativeOperations";
import { RoomOrderNavigationProvider } from "./provider";
import { RoomOrderTentativePinExecution } from "./pinTentativeSchema";
import { RoomOrderTentativePinOperations } from "./pinTentativeService";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const input = Schema.decodeUnknownSync(RoomOrdersPinTentative.input)({
  workspaceId: "forged-workspace",
  messageId: "message-1",
  messageConversationId: "forged-conversation",
  messageContent: "forged content",
  responseReference,
});
const execution = Schema.decodeUnknownSync(RoomOrderTentativePinExecution)({
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
  tentative: true,
  monitor: "Luka",
  sendClaimId: null,
  sentMessageId: null,
  sentConversationId: null,
  tentativeUpdateClaimId: null,
  tentativePinClaimId: null,
  tentativePinnedAt: null,
};
const claimId = makeRoomOrderTentativePinClaimId(invocationId);
const claim = { context, claimId, status: "claimed" as const, detail: null };
const view = { context, claimId, message: { content: "published tentative room order" } };
const message = messageRefFrom(
  { platform: context.clientPlatform, clientId: context.clientId },
  workspaceId,
  context.conversationId,
  context.messageId,
);
const pinReceipt = {
  deliveryKey: makeRoomOrderTentativePinDeliveryKey(invocationId, "pin-tentative-room-order"),
  operation: "setMessagePinned" as const,
  target: { _tag: "Message" as const, message },
};
const editReceipt = {
  deliveryKey: makeRoomOrderTentativePinDeliveryKey(invocationId, "finalize-tentative-room-order"),
  operation: "editMessage" as const,
  target: { _tag: "Message" as const, message },
};
const respondReceipt = {
  deliveryKey: makeRoomOrderTentativePinDeliveryKey(invocationId, "respond"),
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};
const commit = { view, source: "pinned" as const, pinnedAt: 123, receipt: pinReceipt };
const record = { commit, status: "tracked" as const, detail: null };

const deliveryRejected = (operation: string, recoveryRequired: boolean) => ({
  _tag: "DeliveryRejected" as const,
  operation,
  message: `${operation} rejected`,
  ...(recoveryRequired ? { committedReference: context.messageId } : {}),
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
  RoomOrderTentativePinOperations.pipe(
    Effect.provide(roomOrderTentativePinOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(
      Layer.succeed(RoomOrderNavigationProvider, { loadEventStart: () => Effect.succeed(0) }),
    ),
    Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => makeDeliveryBot(delivery) })),
  );

describe("tentative room-order pin Workflow Definition slice", () => {
  it.effect("registers seven pinned policy-v2 actions with stable identities", () =>
    Effect.gen(function* () {
      const definition = makeRoomOrdersPinTentativeDefinition();
      expect(RoomOrdersPinTentative.authorizationPolicy).toMatchObject({
        version: "2",
        principalKinds: ["user"],
        requiredCapabilities: ["workspace.monitor"],
        resource: "message",
        resourceField: "messageId",
      });
      expect(definition.workflow.name).toBe(workflowContractKey(RoomOrdersPinTentative));
      expect(definition.actions.map(({ workflow, version }) => [workflow.name, version])).toEqual([
        ["roomOrders.pinTentative.claim-tentative-pin", "1"],
        ["roomOrders.pinTentative.load-tentative-pin-view", "1"],
        ["roomOrders.pinTentative.pin-tentative-room-order", "1"],
        ["roomOrders.pinTentative.record-tentative-pin", "1"],
        ["roomOrders.pinTentative.finalize-tentative-room-order", "1"],
        ["roomOrders.pinTentative.respond", "1"],
        ["roomOrders.pinTentative.release-tentative-pin-claim", "1"],
      ]);

      const response = {
        context,
        commit,
        messageId: context.messageId,
        messageConversationId: context.conversationId,
        status: "pinned" as const,
        detail: "pinned tentative room order!",
        message: { content: "pinned tentative room order!" },
      };
      const actionInput = {
        ...execution,
        claim,
        view,
        commit,
        finalization: { view, committed: true, committedReference: context.messageId },
        response,
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
      expect(
        new Set([pinReceipt.deliveryKey, editReceipt.deliveryKey, respondReceipt.deliveryKey]).size,
      ).toBe(3);
    }),
  );

  it.effect("uses the pin receipt as the sole commit point and returns ordered evidence", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const result = yield* makeRoomOrdersPinTentativeWorkflowBody({
        claim: () => Effect.sync(() => (calls.push("claim"), claim)),
        load: () => Effect.sync(() => (calls.push("load"), view)),
        pin: () =>
          Effect.sync(
            () => (
              calls.push("pin"),
              { view, status: "pinned" as const, pinnedAt: commit.pinnedAt, receipt: pinReceipt }
            ),
          ),
        record: () => Effect.sync(() => (calls.push("record"), record)),
        finalize: () => Effect.sync(() => (calls.push("finalize"), editReceipt)),
        respond: () => Effect.sync(() => (calls.push("respond"), respondReceipt)),
        release: () => Effect.die("committed claim release"),
      })(execution);

      expect(calls.slice(0, 3)).toEqual(["claim", "load", "pin"]);
      expect(calls.indexOf("record")).toBeLessThan(calls.indexOf("respond"));
      expect(calls.indexOf("finalize")).toBeLessThan(calls.indexOf("respond"));
      expect(result).toEqual({
        messageId: context.messageId,
        messageConversationId: context.conversationId,
        status: "pinned",
        detail: "pinned tentative room order!",
        deliveryReceipts: [pinReceipt, editReceipt, respondReceipt],
      });
    }),
  );

  it.effect("acknowledges denial without entering the pin graph", () =>
    Effect.gen(function* () {
      const detail = "cannot pin a non-tentative room order.";
      const result = yield* makeRoomOrdersPinTentativeWorkflowBody({
        claim: () => Effect.succeed({ ...claim, status: "denied" as const, detail }),
        load: () => Effect.die("denied load"),
        pin: () => Effect.die("denied pin"),
        record: () => Effect.die("denied record"),
        finalize: () => Effect.die("denied finalize"),
        respond: () => Effect.succeed(respondReceipt),
        release: () => Effect.die("unowned claim release"),
      })(execution);
      expect(result).toMatchObject({ status: "denied", detail });
      expect(result.deliveryReceipts).toEqual([respondReceipt]);
    }),
  );

  it.effect("never repins a canonically pinned room order", () =>
    Effect.gen(function* () {
      const alreadyPinnedContext = { ...context, tentativePinnedAt: commit.pinnedAt };
      const staleClaimContext = { ...alreadyPinnedContext, tentativePinnedAt: commit.pinnedAt - 1 };
      const alreadyPinnedView = { ...view, context: alreadyPinnedContext };
      let recordedPinnedAt: number | null = null;
      const result = yield* makeRoomOrdersPinTentativeWorkflowBody({
        claim: () =>
          Effect.succeed({
            ...claim,
            context: staleClaimContext,
            status: "already-pinned" as const,
          }),
        load: () => Effect.succeed(alreadyPinnedView),
        pin: () => Effect.die("already-pinned repin"),
        record: ({ commit: persisted }) =>
          Effect.sync(() => {
            recordedPinnedAt = persisted.pinnedAt;
            return { commit: persisted, status: "not-required" as const, detail: null };
          }),
        finalize: () => Effect.succeed(editReceipt),
        respond: () => Effect.succeed(respondReceipt),
        release: () => Effect.die("already-pinned release"),
      })(execution);
      expect(result).toMatchObject({
        status: "pinned",
        detail: "tentative room order is already pinned.",
      });
      expect(recordedPinnedAt).toBe(commit.pinnedAt);
      expect(result.deliveryReceipts).toEqual([editReceipt, respondReceipt]);
    }),
  );

  it.effect("cleans up and releases only after a definite pin rejection", () =>
    Effect.gen(function* () {
      let released = false;
      const result = yield* makeRoomOrdersPinTentativeWorkflowBody({
        claim: () => Effect.succeed(claim),
        load: () => Effect.succeed(view),
        pin: () =>
          Effect.succeed({ view, status: "rejected" as const, pinnedAt: null, receipt: null }),
        record: () => Effect.die("rejected record"),
        finalize: () => Effect.succeed(editReceipt),
        respond: () => Effect.succeed(respondReceipt),
        release: () => Effect.sync(() => void (released = true)),
      })(execution);
      expect(released).toBe(true);
      expect(result).toMatchObject({ status: "failed" });
      expect(result.deliveryReceipts).toEqual([editReceipt, respondReceipt]);
    }),
  );

  it.effect("releases the claim when the view load fails", () =>
    Effect.gen(function* () {
      let released = false;
      const loadFailure = deliveryRejected("roomOrders.pinTentative.loadTentativePinView", false);
      const exit = yield* Effect.exit(
        makeRoomOrdersPinTentativeWorkflowBody({
          claim: () => Effect.succeed(claim),
          load: () => Effect.fail(loadFailure),
          pin: () => Effect.die("load failure pin"),
          record: () => Effect.die("load failure record"),
          finalize: () => Effect.die("load failure finalize"),
          respond: () => Effect.die("load failure respond"),
          release: () => Effect.sync(() => void (released = true)),
        })(execution),
      );
      expect(released).toBe(true);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual(loadFailure);
      }
    }),
  );

  it.effect("preserves the claim on ambiguous pin or tracking failure", () =>
    Effect.gen(function* () {
      for (const failureAt of ["pin", "record"] as const) {
        let released = false;
        const rejection = deliveryRejected(
          failureAt === "pin"
            ? "roomOrders.pinTentative.pinTentativeRoomOrder"
            : "roomOrders.pinTentative.recordTentativePin",
          true,
        );
        const exit = yield* Effect.exit(
          makeRoomOrdersPinTentativeWorkflowBody({
            claim: () => Effect.succeed(claim),
            load: () => Effect.succeed(view),
            pin: () =>
              failureAt === "pin"
                ? Effect.fail(rejection)
                : Effect.succeed({
                    view,
                    status: "pinned" as const,
                    pinnedAt: commit.pinnedAt,
                    receipt: pinReceipt,
                  }),
            record: () => Effect.fail(rejection),
            finalize: () => Effect.succeed(editReceipt),
            respond: () => Effect.succeed(respondReceipt),
            release: () => Effect.sync(() => void (released = true)),
          })(execution),
        );
        expect(released).toBe(false);
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
  );

  it.effect("gives authorization revocation precedence across collected post-commit failures", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeRoomOrdersPinTentativeWorkflowBody({
          claim: () => Effect.succeed(claim),
          load: () => Effect.succeed(view),
          pin: () =>
            Effect.succeed({
              view,
              status: "pinned" as const,
              pinnedAt: commit.pinnedAt,
              receipt: pinReceipt,
            }),
          record: () =>
            Effect.fail({
              _tag: "AuthorizationRevoked" as const,
              policy: RoomOrdersPinTentative.authorizationPolicy.policy,
            }),
          finalize: () =>
            Effect.fail(
              deliveryRejected("roomOrders.pinTentative.finalizeTentativeRoomOrder", true),
            ),
          respond: () => Effect.fail(deliveryRejected("roomOrders.pinTentative.respond", true)),
          release: () => Effect.die("committed release"),
        })(execution),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual({
          _tag: "AuthorizationRevoked",
          policy: RoomOrdersPinTentative.authorizationPolicy.policy,
        });
      }
    }),
  );

  it.effect(
    "serializes claims, renders canonical content, pins, tracks, and finalizes exactly once",
    () =>
      Effect.gen(function* () {
        let current = roomOrderRow({ tentative: true });
        const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
        const payloads: Array<{ readonly operation: string; readonly payload: unknown }> = [];
        const persistence: TrustedSheetPersistenceShape = {
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
          },
          roomOrderState: {
            ...base.roomOrderState,
            getMessageRoomOrder: () => Effect.succeed(Option.some(current)),
            getMessageRoomOrderEntry: () => Effect.succeed([]),
            claimMessageRoomOrderTentativePin: ({ claimId: requestedClaim }) =>
              Effect.sync(() => {
                if (current.tentativePinClaimId === null) {
                  current = { ...current, tentativePinClaimId: requestedClaim };
                }
              }),
            completeMessageRoomOrderTentativePin: ({ claimId: requestedClaim, pinnedAt }) =>
              Effect.sync(() => {
                if (current.tentativePinClaimId === requestedClaim) {
                  current = { ...current, tentativePinClaimId: null, tentativePinnedAt: pinnedAt };
                }
              }),
          },
        };
        const operations = yield* makeOperations(persistence, {
          setMessagePinned: ({ payload }: { readonly payload: unknown }) =>
            Effect.sync(() => {
              payloads.push({ operation: "pin", payload });
              return pinReceipt;
            }),
          editMessage: ({ payload }: { readonly payload: unknown }) =>
            Effect.sync(() => {
              payloads.push({ operation: "edit", payload });
              return editReceipt;
            }),
        });

        const first = yield* operations.claim(
          context,
          claimId,
          RoomOrdersPinTentative.authorizationPolicy.policy,
        );
        const replay = yield* operations.claim(
          context,
          claimId,
          RoomOrdersPinTentative.authorizationPolicy.policy,
        );
        const competing = yield* operations.claim(
          context,
          `${claimId}:competing`,
          RoomOrdersPinTentative.authorizationPolicy.policy,
        );
        expect(replay).toEqual(first);
        expect(competing).toMatchObject({
          status: "denied",
          detail: "tentative room order is already being pinned.",
        });

        const loaded = yield* operations.loadView(
          first,
          RoomOrdersPinTentative.authorizationPolicy.policy,
        );
        expect(loaded.message).not.toHaveProperty("components");
        const attempt = yield* operations.pin(
          loaded,
          pinReceipt.deliveryKey,
          RoomOrdersPinTentative.authorizationPolicy.policy,
        );
        expect(attempt).toMatchObject({ status: "pinned", receipt: pinReceipt });
        if (attempt.status !== "pinned" || attempt.pinnedAt === null || attempt.receipt === null) {
          return yield* Effect.die("Expected confirmed pin evidence");
        }
        const tracked = yield* operations.record(
          {
            view: loaded,
            source: "pinned",
            pinnedAt: attempt.pinnedAt,
            receipt: attempt.receipt,
          },
          RoomOrdersPinTentative.authorizationPolicy.policy,
        );
        expect(tracked.status).toBe("tracked");
        expect(current).toMatchObject({
          tentativePinClaimId: null,
          tentativePinnedAt: attempt.pinnedAt,
        });
        yield* operations.finalize(
          { view: loaded, committed: true, committedReference: context.messageId },
          editReceipt.deliveryKey,
          RoomOrdersPinTentative.authorizationPolicy.policy,
        );
        expect(payloads).toHaveLength(2);
        expect(payloads[0]).toMatchObject({
          operation: "pin",
          payload: { message, deliveryKey: pinReceipt.deliveryKey, present: true },
        });
        expect(payloads[1]).toMatchObject({
          operation: "edit",
          payload: { message, deliveryKey: editReceipt.deliveryKey, content: loaded.message },
        });
      }),
  );

  it.effect("rejects missing canonical registration before any delivery", () =>
    Effect.gen(function* () {
      let deliveries = 0;
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          getMessageRoomOrder: () => Effect.succeedNone,
        },
      };
      const operations = yield* makeOperations(persistence, {
        setMessagePinned: () => Effect.sync(() => void (deliveries += 1)),
      });
      const exit = yield* Effect.exit(
        operations.claim(context, claimId, RoomOrdersPinTentative.authorizationPolicy.policy),
      );
      expect(deliveries).toBe(0);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "AuthorizationRevoked",
        });
      }
    }),
  );
});
