import { describe, expect, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Predicate, Schema } from "effect";
import { workflowContractKey } from "effect-zero-workflow/contract";
import {
  BotDependencyUnavailable,
  BotResourceNotFound,
  type SheetBotHttpClient,
  ResponseReference,
} from "sheet-bot-api";
import {
  TrustedSheetPersistence,
  type TrustedSheetPersistenceShape,
} from "sheet-zero-server/persistence";
import { RoomOrdersNavigate, WorkspaceId } from "sheet-workflow-contracts";
import {
  ReadOnlyWorkflowAuthorization,
  readOnlyWorkflowAuthorizationLayer,
} from "../readOnly/authorization";
import { authorizeRoomOrdersNavigateWorkflow } from "../shared/interactive";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import { makeSheetApisClient, makeTrustedSheetPersistenceMock } from "@/services/testHelpers";
import {
  type MessageRoomOrderRow,
  roomOrderRow,
  workflowTestInvocationId as invocationId,
  workflowTestPrincipal as principal,
} from "../shared/testHelpers";
import { RoomOrderSheetWorkflowContracts } from "./catalog";
import { makeRoomOrdersNavigateDefinition, makeRoomOrdersNavigateWorkflowBody } from "./definition";
import { makeRoomOrderNavigationClaimId, makeRoomOrderNavigationDeliveryKey } from "./keys";
import { roomOrderNavigationOperationsLayer } from "./operations";
import { RoomOrderNavigationProvider } from "./provider";
import { RoomOrderNavigateExecution } from "./schema";
import { RoomOrderSheetWorkflowRegistrations } from "./registry";
import { RoomOrderNavigationOperations } from "./service";

const responseReference = Schema.decodeUnknownSync(ResponseReference)("response-1");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)("workspace-1");
const input = Schema.decodeUnknownSync(RoomOrdersNavigate.input)({
  workspaceId: "forged-workspace",
  messageId: "message-1",
  messageConversationId: "forged-conversation",
  messageContent: "forged message content",
  responseReference,
  direction: "next",
});
const execution = Schema.decodeUnknownSync(RoomOrderNavigateExecution)({
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
  rank: 1,
  tentative: false,
  monitor: "Luka",
};
const claim = {
  context,
  claimId: makeRoomOrderNavigationClaimId(invocationId),
  status: "claimed" as const,
  detail: null,
};
const view = {
  context,
  claimId: claim.claimId,
  direction: "next" as const,
  targetRank: 2,
  range: { minRank: 1, maxRank: 3 },
  status: "ready" as const,
  detail: null,
  message: { content: "rank 2" },
};
const committed = {
  context,
  claimId: claim.claimId,
  targetRank: 2,
  status: "updated" as const,
  detail: null,
  message: view.message,
};
const respondReceipt = {
  deliveryKey: makeRoomOrderNavigationDeliveryKey(invocationId, "respond"),
  operation: "respond" as const,
  target: { _tag: "Response" as const, responseReference },
};
const editReceipt = {
  deliveryKey: makeRoomOrderNavigationDeliveryKey(invocationId, "edit-room-order-message"),
  operation: "editMessage" as const,
  target: {
    _tag: "Message" as const,
    message: {
      conversation: {
        workspace: {
          client: { platform: "discord" as const, clientId: context.clientId },
          workspaceId,
        },
        conversationId: context.conversationId,
      },
      messageId: context.messageId,
    },
  },
};

const deliveryRejected = (operation: string) => ({
  _tag: "DeliveryRejected" as const,
  operation,
  message: `${operation} rejected`,
  committedReference: context.messageId,
  recoveryRequired: true,
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
  provider: typeof RoomOrderNavigationProvider.Service = {
    loadEventStart: () => Effect.succeed(0),
  },
) =>
  Effect.gen(function* () {
    return yield* RoomOrderNavigationOperations;
  }).pipe(
    Effect.provide(roomOrderNavigationOperationsLayer),
    Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
    Effect.provide(Layer.succeed(RoomOrderNavigationProvider, provider)),
    Effect.provide(Layer.succeed(SheetBotDeliveryClient, { get: () => makeDeliveryBot(delivery) })),
  );

describe("room-order navigation Workflow Definition slice", () => {
  it("registers one policy-v2 contract with six pinned actions", () => {
    const definition = makeRoomOrdersNavigateDefinition();
    expect(RoomOrdersNavigate.authorizationPolicy).toMatchObject({
      version: "2",
      requiredCapabilities: ["workspace.monitor"],
      resource: "message",
      resourceField: "messageId",
    });
    expect(RoomOrderSheetWorkflowContracts).toEqual([RoomOrdersNavigate]);
    expect(definition.workflow.name).toBe(workflowContractKey(RoomOrdersNavigate));
    expect(definition.actions.map(({ workflow }) => workflow.name)).toEqual([
      "roomOrders.navigate.claim-navigation",
      "roomOrders.navigate.load-navigation-view",
      "roomOrders.navigate.commit-navigation",
      "roomOrders.navigate.respond",
      "roomOrders.navigate.edit-room-order-message",
      "roomOrders.navigate.release-navigation-claim",
    ]);
    expect(definition.actions.every(({ version }) => version === "1")).toBe(true);
    expect(RoomOrderSheetWorkflowRegistrations).toEqual([
      expect.objectContaining({ contract: RoomOrdersNavigate, definitionVersion: "1" }),
    ]);
  });

  it.effect("uses stable invocation-derived action, claim, and delivery identities", () =>
    Effect.gen(function* () {
      const definition = makeRoomOrdersNavigateDefinition();
      const actionInput = {
        ...execution,
        claim,
        view,
        committed,
        canonicalProjectionConfirmed: true,
      };
      const first = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(actionInput),
      );
      const replay = yield* Effect.forEach(definition.actions, ({ workflow }) =>
        workflow.executionId(actionInput),
      );
      expect(replay).toEqual(first);
      expect(new Set(first).size).toBe(6);
      expect(makeRoomOrderNavigationClaimId(invocationId)).toContain(String(invocationId));
      expect(makeRoomOrderNavigationDeliveryKey(invocationId, "respond")).not.toBe(
        makeRoomOrderNavigationDeliveryKey(invocationId, "edit-room-order-message"),
      );
    }),
  );

  it.effect("serializes claims by configured-client message and reconciles stable replay", () =>
    Effect.gen(function* () {
      let current = roomOrderRow({ rank: context.rank });
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          claimMessageRoomOrderTentativeUpdate: ({ claimId }) =>
            Effect.sync(() => {
              if (Predicate.isNull(current.tentativeUpdateClaimId)) {
                current = { ...current, tentativeUpdateClaimId: claimId };
              }
            }),
          getMessageRoomOrder: () => Effect.succeed(Option.some(current)),
        },
      };
      const operations = yield* makeOperations(persistence);
      const claimId = makeRoomOrderNavigationClaimId(invocationId);
      const first = yield* operations.claim(
        context,
        claimId,
        RoomOrdersNavigate.authorizationPolicy.policy,
      );
      const replay = yield* operations.claim(
        context,
        claimId,
        RoomOrdersNavigate.authorizationPolicy.policy,
      );
      const competing = yield* operations.claim(
        context,
        `${claimId}:competing`,
        RoomOrdersNavigate.authorizationPolicy.policy,
      );
      expect(first).toMatchObject({ status: "claimed", claimId });
      expect(replay).toEqual(first);
      expect(competing).toMatchObject({
        status: "denied",
        detail: "tentative room order is already being updated.",
      });
    }),
  );

  it.effect("reconciles an ambiguous rank CAS without repeating the commit", () =>
    Effect.gen(function* () {
      let current = roomOrderRow({
        rank: context.rank,
        tentativeUpdateClaimId: claim.claimId,
      });
      let mutationCalls = 0;
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          incrementMessageRoomOrderRank: ({ expectedRank, tentativeUpdateClaimId }) =>
            Effect.sync(() => {
              mutationCalls += 1;
              if (
                current.rank === expectedRank &&
                current.tentativeUpdateClaimId === tentativeUpdateClaimId
              ) {
                current = { ...current, rank: current.rank + 1 };
              }
            }).pipe(Effect.andThen(Effect.die("connection lost after commit"))),
          getMessageRoomOrder: () => Effect.succeed(Option.some(current)),
        },
      };
      const operations = yield* makeOperations(persistence);
      const first = yield* operations.commit(view, RoomOrdersNavigate.authorizationPolicy.policy);
      const replay = yield* operations.commit(view, RoomOrdersNavigate.authorizationPolicy.policy);
      expect(mutationCalls).toBe(2);
      expect(first).toMatchObject({ status: "updated", targetRank: 2 });
      expect(replay).toEqual(first);
      expect(current.rank).toBe(2);
    }),
  );

  it.effect("reports an unapplied rank mutation without treating its own claim as busy", () =>
    Effect.gen(function* () {
      const current = roomOrderRow({
        rank: context.rank,
        tentativeUpdateClaimId: claim.claimId,
      });
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          incrementMessageRoomOrderRank: () => Effect.void,
          getMessageRoomOrder: () => Effect.succeed(Option.some(current)),
        },
      };
      const operations = yield* makeOperations(persistence);
      const result = yield* operations.commit(view, RoomOrdersNavigate.authorizationPolicy.policy);

      expect(result).toMatchObject({
        status: "denied",
        detail: "room order is temporarily unavailable.",
      });
    }),
  );

  it.effect("keeps post-release verification failures non-fatal", () =>
    Effect.gen(function* () {
      let releaseCalls = 0;
      const verificationResults = [
        Option.none<MessageRoomOrderRow>(),
        Option.some(
          roomOrderRow({
            rank: context.rank,
            tentativeUpdateClaimId: claim.claimId,
          }),
        ),
      ];

      for (const verificationResult of verificationResults) {
        const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
        const persistence: TrustedSheetPersistenceShape = {
          ...base,
          roomOrderState: {
            ...base.roomOrderState,
            releaseMessageRoomOrderTentativeUpdateClaim: () =>
              Effect.sync(() => void (releaseCalls += 1)),
            getMessageRoomOrder: () => Effect.succeed(verificationResult),
          },
        };
        const operations = yield* makeOperations(persistence);
        yield* operations.release(committed);
      }

      expect(releaseCalls).toBe(verificationResults.length);
    }),
  );

  it.effect("denies out-of-range navigation before provider rendering or commit", () =>
    Effect.gen(function* () {
      let providerRead = false;
      const current = roomOrderRow({ rank: 2, tentativeUpdateClaimId: claim.claimId });
      const rangeEntry = (rank: number) => ({
        clientPlatform: context.clientPlatform,
        clientId: context.clientId,
        messageId: context.messageId,
        rank,
        position: 0,
        hour: context.hour,
        team: "Team",
        tags: [],
        effectValue: 0,
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
      });
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        roomOrderState: {
          ...base.roomOrderState,
          getMessageRoomOrder: () => Effect.succeed(Option.some(current)),
          getMessageRoomOrderRange: () => Effect.succeed([rangeEntry(1), rangeEntry(2)]),
        },
      };
      const operations = yield* makeOperations(
        persistence,
        {},
        {
          loadEventStart: () => Effect.sync(() => ((providerRead = true), 0)),
        },
      );
      const result = yield* operations.loadView(
        { ...claim, context: { ...context, rank: 2 } },
        "next",
        RoomOrdersNavigate.authorizationPolicy.policy,
      );
      expect(result).toMatchObject({
        status: "denied",
        detail: "room order is already at the requested boundary.",
      });
      expect(providerRead).toBe(false);
    }),
  );

  it.effect("maps missing canonical bot projections to committed delivery rejection", () =>
    Effect.gen(function* () {
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const missingMessage = () =>
        Effect.fail(
          new BotResourceNotFound({
            resource: "room-order message",
            message: "message is unavailable",
          }),
        );
      const operations = yield* makeOperations(base, {
        editMessage: missingMessage,
        respond: missingMessage,
      });
      const error = yield* Effect.flip(
        operations.editRoomOrderMessage(
          { ...committed, context: { ...context, tentative: true } },
          editReceipt.deliveryKey,
          RoomOrdersNavigate.authorizationPolicy.policy,
        ),
      );
      expect(error).toEqual({
        _tag: "DeliveryRejected",
        operation: "roomOrders.navigate.editRoomOrderMessage",
        message: "The room-order message update was rejected",
        committedReference: context.messageId,
        recoveryRequired: true,
      });

      const deniedError = yield* Effect.flip(
        operations.respond(
          {
            ...committed,
            status: "denied",
            detail: "room order could not be updated.",
            targetRank: context.rank,
          },
          responseReference,
          respondReceipt.deliveryKey,
          RoomOrdersNavigate.authorizationPolicy.policy,
        ),
      );
      expect(deniedError).toEqual({
        _tag: "DeliveryRejected",
        operation: "roomOrders.navigate.respond",
        message: "The room-order response was rejected",
        recoveryRequired: false,
      });
    }),
  );

  it.effect("runs normal projection in order and releases only after its receipt", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const result = yield* makeRoomOrdersNavigateWorkflowBody({
        claim: () => Effect.sync(() => (calls.push("claim"), claim)),
        load: () => Effect.sync(() => (calls.push("load"), view)),
        commit: () => Effect.sync(() => (calls.push("commit"), committed)),
        respond: () => Effect.sync(() => (calls.push("respond"), respondReceipt)),
        edit: () => Effect.die("normal edit"),
        release: () => Effect.sync(() => void calls.push("release")),
      })(execution);
      expect(calls).toEqual(["claim", "load", "commit", "respond", "release"]);
      expect(result).toMatchObject({
        messageId: context.messageId,
        messageConversationId: context.conversationId,
        status: "updated",
        deliveryReceipts: [respondReceipt],
      });
    }),
  );

  it.effect("acknowledges a busy denial without loading or committing", () =>
    Effect.gen(function* () {
      const detail = "tentative room order is already being updated.";
      const result = yield* makeRoomOrdersNavigateWorkflowBody({
        claim: () => Effect.succeed({ ...claim, status: "denied" as const, detail }),
        load: () => Effect.die("denied load"),
        commit: () => Effect.die("denied commit"),
        respond: () => Effect.succeed(respondReceipt),
        edit: () => Effect.die("denied edit"),
        release: () => Effect.die("unowned claim release"),
      })(execution);
      expect(result).toMatchObject({
        status: "denied",
        detail,
        deliveryReceipts: [respondReceipt],
      });
    }),
  );

  it.effect("releases an owned stale-rank denial even when its acknowledgement fails", () =>
    Effect.gen(function* () {
      let released = false;
      const deniedView = {
        ...view,
        targetRank: context.rank,
        status: "denied" as const,
        detail: "room order could not be updated.",
        message: { content: "room order could not be updated.", visibility: "ephemeral" as const },
      };
      const deniedCommit = {
        ...committed,
        targetRank: context.rank,
        status: "denied" as const,
        detail: deniedView.detail,
        message: deniedView.message,
      };
      const exit = yield* Effect.exit(
        makeRoomOrdersNavigateWorkflowBody({
          claim: () => Effect.succeed(claim),
          load: () => Effect.succeed(deniedView),
          commit: () => Effect.succeed(deniedCommit),
          respond: () =>
            Effect.fail({
              _tag: "DeliveryRejected" as const,
              operation: "roomOrders.navigate.respond",
              message: "The room-order response was rejected",
              recoveryRequired: false,
            }),
          edit: () => Effect.die("denied edit"),
          release: () => Effect.sync(() => void (released = true)),
        })(execution),
      );
      expect(released).toBe(true);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          _tag: "DeliveryRejected",
          recoveryRequired: false,
        });
      }
    }),
  );

  it.effect("collects tentative response then edit and releases after edit confirmation", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const tentativeContext = { ...context, tentative: true };
      const exit = yield* Effect.exit(
        makeRoomOrdersNavigateWorkflowBody({
          claim: () => Effect.succeed({ ...claim, context: tentativeContext }),
          load: () => Effect.succeed({ ...view, context: tentativeContext }),
          commit: () => Effect.succeed({ ...committed, context: tentativeContext }),
          respond: () =>
            Effect.sync(() => calls.push("respond")).pipe(
              Effect.andThen(Effect.fail(deliveryRejected("respond"))),
            ),
          edit: () => Effect.sync(() => (calls.push("edit"), editReceipt)),
          release: () => Effect.sync(() => void calls.push("release")),
        })(execution),
      );
      expect(calls).toEqual(["respond", "edit", "release"]);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("returns tentative receipts in deterministic projection order", () =>
    Effect.gen(function* () {
      const tentativeContext = { ...context, tentative: true };
      const result = yield* makeRoomOrdersNavigateWorkflowBody({
        claim: () => Effect.succeed({ ...claim, context: tentativeContext }),
        load: () => Effect.succeed({ ...view, context: tentativeContext }),
        commit: () => Effect.succeed({ ...committed, context: tentativeContext }),
        respond: () => Effect.succeed(respondReceipt),
        edit: () => Effect.succeed(editReceipt),
        release: () => Effect.void,
      })(execution);
      expect(result.deliveryReceipts).toEqual([respondReceipt, editReceipt]);
    }),
  );

  it.effect("gives authorization revocation precedence over mixed post-commit failures", () =>
    Effect.gen(function* () {
      const tentativeContext = { ...context, tentative: true };
      const exit = yield* Effect.exit(
        makeRoomOrdersNavigateWorkflowBody({
          claim: () => Effect.succeed({ ...claim, context: tentativeContext }),
          load: () => Effect.succeed({ ...view, context: tentativeContext }),
          commit: () => Effect.succeed({ ...committed, context: tentativeContext }),
          respond: () => Effect.fail(deliveryRejected("respond")),
          edit: () =>
            Effect.fail({
              _tag: "AuthorizationRevoked" as const,
              policy: RoomOrdersNavigate.authorizationPolicy.policy,
            }),
          release: () => Effect.die("unconfirmed projection release"),
        })(execution),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual({
          _tag: "AuthorizationRevoked",
          policy: RoomOrdersNavigate.authorizationPolicy.policy,
        });
      }
    }),
  );

  it.effect("does not cross the commit point when rendering fails", () =>
    Effect.gen(function* () {
      let committedRank = false;
      const exit = yield* Effect.exit(
        makeRoomOrdersNavigateWorkflowBody({
          claim: () => Effect.succeed(claim),
          load: () => Effect.die("render failed"),
          commit: () => Effect.sync(() => ((committedRank = true), committed)),
          respond: () => Effect.die("unused"),
          edit: () => Effect.die("unused"),
          release: () => Effect.die("unused"),
        })(execution),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(committedRank).toBe(false);
    }),
  );

  it.effect("never reports success when a post-commit delivery dies", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        makeRoomOrdersNavigateWorkflowBody({
          claim: () => Effect.succeed(claim),
          load: () => Effect.succeed(view),
          commit: () => Effect.succeed(committed),
          respond: () => Effect.die("ambiguous delivery"),
          edit: () => Effect.die("unused"),
          release: () => Effect.die("unconfirmed projection release"),
        })(execution),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
    }),
  );

  it.effect("preserves the claim when canonical tentative edit is not confirmed", () =>
    Effect.gen(function* () {
      let released = false;
      const tentativeContext = { ...context, tentative: true };
      const exit = yield* Effect.exit(
        makeRoomOrdersNavigateWorkflowBody({
          claim: () => Effect.succeed({ ...claim, context: tentativeContext }),
          load: () => Effect.succeed({ ...view, context: tentativeContext }),
          commit: () => Effect.succeed({ ...committed, context: tentativeContext }),
          respond: () => Effect.succeed(respondReceipt),
          edit: () => Effect.fail(deliveryRejected("edit-room-order-message")),
          release: () => Effect.sync(() => void (released = true)),
        })(execution),
      );
      expect(released).toBe(false);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toEqual(
          deliveryRejected("edit-room-order-message"),
        );
      }
    }),
  );

  it.effect("derives authority from canonical context rather than caller fields", () =>
    Effect.gen(function* () {
      const canonicalWorkspaceId = Schema.decodeUnknownSync(WorkspaceId)("canonical-workspace");
      const canonicalConversationId = "canonical-conversation";
      const base = makeTrustedSheetPersistenceMock(makeSheetApisClient({}));
      const persistence: TrustedSheetPersistenceShape = {
        ...base,
        workspaces: {
          ...base.workspaces,
          getWorkspaceMonitorRoles: () =>
            Effect.succeed([
              {
                workspaceId: canonicalWorkspaceId,
                roleId: "monitor-role",
                createdAt: 1,
                updatedAt: 1,
                deletedAt: null,
              },
            ]),
        },
        roomOrderState: {
          ...base.roomOrderState,
          getMessageRoomOrder: () =>
            Effect.succeed(
              Option.some(
                roomOrderRow({
                  workspaceId: canonicalWorkspaceId,
                  conversationId: canonicalConversationId,
                }),
              ),
            ),
        },
      };
      expect(principal.discordAccount).toBeDefined();
      const accountId = Option.getOrThrow(Option.fromNullishOr(principal.discordAccount)).accountId;
      const bot = {
        cache: {
          getApplication: () => Effect.succeed({ ownerId: "application-owner" }),
          getMember: () =>
            Effect.succeed({
              userId: accountId,
              roleIds: ["monitor-role"],
            }),
          getWorkspace: () =>
            Effect.succeed({
              id: canonicalWorkspaceId,
              name: "Canonical workspace",
              icon: null,
              ownerId: "workspace-owner",
            }),
          listRoles: () => Effect.succeed([]),
        },
      } as unknown as SheetBotHttpClient;
      const authorization = yield* ReadOnlyWorkflowAuthorization.pipe(
        Effect.provide(readOnlyWorkflowAuthorizationLayer),
        Effect.provide(Layer.succeed(SheetBotCacheClient, { get: () => bot })),
        Effect.provide(Layer.succeed(TrustedSheetPersistence, persistence)),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ sheetBotClientId: context.clientId })),
        ),
      );

      const authorized = yield* authorization.authorizeRoomOrdersNavigate(principal, input);
      expect(authorized.workspaceId).toBe(canonicalWorkspaceId);
      expect(authorized.workspaceId).not.toBe(input.workspaceId);
      expect(authorized.conversationId).toBe(canonicalConversationId);
      expect(authorized.conversationId).not.toBe(input.messageConversationId);
    }),
  );

  it.effect("preserves replay-time authorization dependency failures for retry", () =>
    Effect.gen(function* () {
      const dependencyFailure = new BotDependencyUnavailable({ message: "cache unavailable" });
      const exit = yield* authorizeRoomOrdersNavigateWorkflow(execution).pipe(
        Effect.provideService(ReadOnlyWorkflowAuthorization, {
          authorize: () => Effect.die("unused"),
          authorizeSlotOpen: () => Effect.die("unused"),
          authorizeCheckinRespond: () => Effect.die("unused"),
          authorizeRoomOrdersNavigate: () => Effect.fail(dependencyFailure),
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
