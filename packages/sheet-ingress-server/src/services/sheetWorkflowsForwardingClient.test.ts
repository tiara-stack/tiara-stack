import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashSet,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { Headers } from "effect/unstable/http";
import { DispatchWorkflowOperations, SheetAuthUser } from "sheet-ingress-api/internal";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { UnknownError } from "typhoon-core/error";
import { ZeroApiError } from "typhoon-zero/zeroApi";
import { getIngressRpcHeaders } from "./rpcAuthorizationClient";
import { SheetApisRpcTokens } from "./sheetApisRpcTokens";
import { SheetWorkflowsForwardingClient } from "./sheetWorkflowsForwardingClient";
import { WorkflowZeroClient } from "./workflowZeroClient";

const makeSheetApisRpcTokens = (): Context.Service.Shape<typeof SheetApisRpcTokens> => ({
  getServiceUser: Effect.fn("test.getServiceUser")(() =>
    Effect.succeed({
      accountId: "service",
      userId: "service",
      permissions: HashSet.fromIterable(["service"]),
      scopes: new Set(["service"]) as never,
      token: Redacted.make("unavailable"),
      tokenType: "service",
    }),
  ),
  getServiceToken: Effect.fn("test.getServiceToken")((resource: string) =>
    Effect.succeed(`${resource}-token`),
  ),
  getDelegatedAuthorization: Effect.fn("test.getDelegatedAuthorization")(({ resource, user }) => {
    void user;
    return Effect.succeed(Redacted.make(`${resource}-delegated-token`));
  }),
  withServiceUser: Effect.fn("test.withServiceUser")(function* (effect) {
    const serviceUser = yield* makeSheetApisRpcTokens().getServiceUser();
    return yield* effect.pipe(Effect.provideService(SheetAuthUser, serviceUser));
  }),
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()),
    Effect.provideService(SheetAuthUser, {
      accountId: "discord-user-1",
      userId: "user-1",
      permissions: HashSet.empty(),
      scopes: new Set() as never,
      token: Redacted.make("sheet-auth-session-token"),
      tokenType: "session",
    }),
  );

const runWithoutUser = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(SheetApisRpcTokens, makeSheetApisRpcTokens()));

type WorkflowZeroEnqueue = Context.Service.Shape<typeof WorkflowZeroClient>["enqueueAsCaller"];

const workflowZeroLayer = (enqueueAsCaller: WorkflowZeroEnqueue) =>
  Layer.succeed(WorkflowZeroClient, { enqueueAsCaller });

const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

const checkinPayload = {
  requester: { accountId: "account-1", userId: "user-1" },
  payload: {
    client: { platform: "discord", clientId: "discord-main" },
    dispatchRequestId: "dispatch-checkin",
    workspaceId: "workspace-1",
  },
} satisfies typeof DispatchWorkflowOperations.checkin.workflow.payloadSchema.Type;

const pinTentativePayload = {
  requester: { accountId: "account-1", userId: "user-1" },
  payload: {
    client: { platform: "discord", clientId: "discord-main" },
    workspaceId: "workspace-1",
    messageId: "message-1",
    messageConversationId: "conversation-1",
    interactionResponseToken: "interaction-token",
    interactionResponseDeadlineEpochMs: 4_102_444_800_000,
    interactionResponseType: undefined,
  },
  authorizedRoomOrder: new MessageRoomOrder({
    clientPlatform: "discord",
    clientId: "discord-main",
    messageId: "message-1",
    previousFills: [],
    fills: ["member-1"],
    hour: 1,
    rank: 1,
    tentative: true,
    monitor: Option.none(),
    workspaceId: Option.some("workspace-1"),
    conversationId: Option.some("conversation-1"),
    createdByUserId: Option.some("user-1"),
    sendClaimId: Option.none(),
    sendClaimedAt: Option.none(),
    sentMessageId: Option.none(),
    sentConversationId: Option.none(),
    sentAt: Option.none(),
    tentativeUpdateClaimId: Option.none(),
    tentativeUpdateClaimedAt: Option.none(),
    tentativePinClaimId: Option.none(),
    tentativePinClaimedAt: Option.none(),
    tentativePinnedAt: Option.none(),
    createdAt: Option.none(),
    updatedAt: Option.none(),
    deletedAt: Option.none(),
  }),
} satisfies typeof DispatchWorkflowOperations.roomOrderPinTentativeButton.workflow.payloadSchema.Type;

describe("SheetWorkflowsForwardingClient", () => {
  it.effect("builds sheet-workflows ingress headers with a delegated bearer token", () =>
    Effect.gen(function* () {
      const headers = yield* run(getIngressRpcHeaders({ serviceTokenResource: "sheet-workflows" }));

      expect(Option.getOrUndefined(Headers.get(headers, "authorization"))).toBe(
        "Bearer sheet-workflows-delegated-token",
      );
      expect(Option.isNone(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(true);
      expect(Option.isNone(Headers.get(headers, "x-sheet-auth-session-token"))).toBe(true);
      expect(Option.isNone(Headers.get(headers, "x-sheet-auth-token"))).toBe(true);
    }),
  );

  it.effect("builds sheet-bot ingress headers with a service bearer token", () =>
    Effect.gen(function* () {
      const headers = yield* runWithoutUser(
        getIngressRpcHeaders({ serviceTokenResource: "sheet-bot" }),
      );

      expect(Option.getOrUndefined(Headers.get(headers, "authorization"))).toBe(
        "Bearer sheet-bot-token",
      );
      expect(Option.isNone(Headers.get(headers, "x-sheet-ingress-auth"))).toBe(true);
    }),
  );

  it.effect("generates every dispatch method and enqueues checkin through Zero", () =>
    Effect.gen(function* () {
      const enqueueAsCaller = vi.fn<WorkflowZeroEnqueue>(() => Effect.void);
      const client = yield* SheetWorkflowsForwardingClient.make.pipe(
        Effect.provide(workflowZeroLayer(enqueueAsCaller)),
      );

      expect(Object.keys(client.dispatch).sort()).toEqual(
        Object.values(DispatchWorkflowOperations)
          .map(({ endpointName }) => endpointName)
          .sort(),
      );
      expectTypeOf<ReturnType<typeof client.dispatch.checkin>>().toMatchTypeOf<
        Effect.Effect<{ readonly operation: "checkin" }, UnknownError, never>
      >();

      const result = yield* client.dispatch.checkin(checkinPayload);
      const executionId =
        yield* DispatchWorkflowOperations.checkin.workflow.executionId(checkinPayload);
      const encodedPayload = yield* Schema.encodeUnknownEffect(
        DispatchWorkflowOperations.checkin.workflow.payloadSchema,
      )(checkinPayload).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)));

      expect(result).toEqual({
        runId: executionId,
        operation: "checkin",
        status: "accepted",
      });
      expect(enqueueAsCaller).toHaveBeenCalledWith({
        caller: {
          principalId: "account-1",
        },
        workflow: {
          runId: result.runId,
          workflowName: DispatchWorkflowOperations.checkin.workflow.name,
          definitionVersion: "1",
          executionId,
          payload: encodedPayload,
        },
      });
      expect(enqueueAsCaller).toHaveBeenCalledOnce();
    }),
  );

  it.effect("encodes an already-decoded room-order pin payload", () =>
    Effect.gen(function* () {
      const enqueueAsCaller = vi.fn<WorkflowZeroEnqueue>(() => Effect.void);
      const client = yield* SheetWorkflowsForwardingClient.make.pipe(
        Effect.provide(workflowZeroLayer(enqueueAsCaller)),
      );

      const result = yield* client.dispatch.roomOrderPinTentativeButton(pinTentativePayload);
      const encodedPayload = enqueueAsCaller.mock.calls[0]?.[0].workflow.payload;

      yield* Schema.decodeUnknownEffect(Schema.Json)(encodedPayload);

      expect(encodedPayload).toMatchObject({
        payload: {
          client: { clientId: "discord-main" },
          workspaceId: "workspace-1",
          messageId: "message-1",
        },
      });
      expect(result).toMatchObject({
        operation: "roomOrderPinTentativeButton",
        status: "accepted",
      });
      expect(encodedPayload).not.toHaveProperty("payload.interactionResponseType");
      expect(enqueueAsCaller.mock.calls[0]?.[0].caller).toEqual({ principalId: "account-1" });
      expect(enqueueAsCaller.mock.calls[0]?.[0].workflow.workflowName).toBe(
        DispatchWorkflowOperations.roomOrderPinTentativeButton.workflow.name,
      );
      expect(enqueueAsCaller).toHaveBeenCalledOnce();
    }),
  );

  it.effect("preserves Zero enqueue failures in the typed error channel", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const enqueueAttempts = yield* Queue.unbounded<number>();
      const enqueueAsCaller = vi.fn<WorkflowZeroEnqueue>(() =>
        Effect.gen(function* () {
          attempts += 1;
          yield* Queue.offer(enqueueAttempts, attempts);
          return yield* Effect.fail(
            new ZeroApiError.MutatorResultZeroError({
              type: "zero",
              message: "offline",
            }),
          );
        }),
      );
      const client = yield* SheetWorkflowsForwardingClient.make.pipe(
        Effect.provide(workflowZeroLayer(enqueueAsCaller)),
      );

      const fiber = yield* client.dispatch
        .checkin(checkinPayload)
        .pipe(Effect.forkChild({ startImmediately: true }));

      for (let expectedAttempt = 1; expectedAttempt <= 5; expectedAttempt += 1) {
        expect(yield* Queue.take(enqueueAttempts)).toBe(expectedAttempt);
        if (expectedAttempt < 5) {
          yield* TestClock.adjust(Duration.seconds(1));
        }
      }
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(failure(exit)).toMatchObject({
        _tag: "UnknownError",
        message: "Failed to persist workflow dispatch",
      });
      expect(attempts).toBe(5);
    }),
  );

  it.effect("maps workflow enqueue timeouts to the typed error channel", () =>
    Effect.gen(function* () {
      const enqueueStarted = yield* Deferred.make<void>();
      const enqueueAsCaller = vi.fn<WorkflowZeroEnqueue>(() =>
        Deferred.succeed(enqueueStarted, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const client = yield* SheetWorkflowsForwardingClient.make.pipe(
        Effect.provide(workflowZeroLayer(enqueueAsCaller)),
      );

      const fiber = yield* client.dispatch.checkin(checkinPayload).pipe(Effect.forkChild);
      yield* Deferred.await(enqueueStarted);
      yield* TestClock.adjust(Duration.seconds(31));
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(failure(exit)).toMatchObject({
        _tag: "UnknownError",
        message: "Failed to persist workflow dispatch",
      });
    }),
  );
});
