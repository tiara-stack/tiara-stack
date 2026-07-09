// fallow-ignore-file code-duplication
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect";
import { Entity, ShardingConfig } from "effect/unstable/cluster";
import { WorkflowEngine } from "effect/unstable/workflow";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { DispatchService, ClientDeliveryClient, SheetApisClient } from "@/services";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { dispatchButtonEntityLayer } from "@/workflows/dispatchRegistry";
import * as Data from "effect/Data";

class SheetWorkflowsEntitiesDispatchButtonTestError extends Data.TaggedError(
  "SheetWorkflowsEntitiesDispatchButtonTestError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
import {
  DispatchButtonEntity,
  type DispatchButtonEntityHandlers,
  makeDispatchButtonEntityLayer,
} from "./dispatchButton";

const requester = {
  accountId: "account-1",
  userId: "user-1",
};

const interactionResponseDeadlineEpochMs = 4_102_444_800_000;
const discordClient = { platform: "discord", clientId: "discord-main" } as const;

const checkinButtonRequest = {
  requester,
  payload: {
    client: discordClient,
    messageId: "message-1",
    interactionResponseToken: "interaction-token",
    interactionResponseDeadlineEpochMs,
  },
};

const slotOpenButtonRequest = {
  requester,
  payload: {
    client: discordClient,
    messageId: "slot-message-1",
    interactionResponseToken: "interaction-token",
    interactionResponseDeadlineEpochMs,
  },
};

const authorizedRoomOrder = new MessageRoomOrder({
  clientPlatform: "discord",
  clientId: "discord-main",
  messageId: "message-1",
  hour: 1,
  previousFills: [],
  fills: [],
  rank: 1,
  tentative: false,
  monitor: Option.none(),
  workspaceId: Option.some("workspace-1"),
  conversationId: Option.some("conversation-1"),
  createdByUserId: Option.some(requester.userId),
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
});

const roomOrderButtonRequest = {
  requester,
  authorizedRoomOrder,
  payload: {
    client: discordClient,
    workspaceId: "workspace-1",
    messageId: "message-1",
    messageConversationId: "conversation-1",
    interactionResponseToken: "interaction-token",
    interactionResponseDeadlineEpochMs,
  },
};

const checkinButtonResult = {
  messageId: "message-1",
  messageConversationId: "conversation-1",
  checkedInMemberId: requester.accountId,
};

const slotOpenButtonResult = {
  messageId: "slot-message-1",
  workspaceId: "workspace-1",
  day: 1,
};

const roomOrderButtonResult = {
  messageId: "message-1",
  messageConversationId: "conversation-1",
  status: "updated" as const,
  detail: null,
};

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100,
});

const defaultHandlers = (
  overrides: Partial<DispatchButtonEntityHandlers> = {},
): DispatchButtonEntityHandlers => ({
  slotOpenButton: () => Effect.succeed(slotOpenButtonResult),
  checkinButton: () => Effect.succeed(checkinButtonResult),
  roomOrderPreviousButton: () => Effect.succeed(roomOrderButtonResult),
  roomOrderNextButton: () => Effect.succeed(roomOrderButtonResult),
  roomOrderSendButton: () =>
    Effect.succeed({
      ...roomOrderButtonResult,
      status: "sent" as const,
    }),
  roomOrderPinTentativeButton: () =>
    Effect.succeed({
      ...roomOrderButtonResult,
      status: "pinned" as const,
    }),
  teamSubmissionConfirmButton: () => Effect.succeed({ status: "confirmed" as const }),
  teamSubmissionRejectButton: () => Effect.succeed({ status: "rejected" as const }),
  ...overrides,
});

const makeClient = (handlers: DispatchButtonEntityHandlers) =>
  Entity.makeTestClient(DispatchButtonEntity, makeDispatchButtonEntityLayer(handlers));

const makeDispatchServiceMock = (
  overrides: Partial<typeof DispatchService.Service>,
): typeof DispatchService.Service =>
  ({
    slotOpenButton: () => Effect.die("Unexpected slotOpenButton call"),
    checkinButton: () => Effect.die("Unexpected checkinButton call"),
    roomOrderPreviousButton: () => Effect.die("Unexpected roomOrderPreviousButton call"),
    roomOrderNextButton: () => Effect.die("Unexpected roomOrderNextButton call"),
    roomOrderSendButton: () => Effect.die("Unexpected roomOrderSendButton call"),
    roomOrderPinTentativeButton: () => Effect.die("Unexpected roomOrderPinTentativeButton call"),
    teamSubmissionConfirmButton: () => Effect.die("Unexpected teamSubmissionConfirmButton call"),
    teamSubmissionRejectButton: () => Effect.die("Unexpected teamSubmissionRejectButton call"),
    ...overrides,
  }) as typeof DispatchService.Service;

const sheetApisClientWithCheckinMember = {
  get: () =>
    ({
      messageCheckin: {
        getMessageCheckinMembers: () =>
          Effect.succeed([
            {
              messageId: checkinButtonRequest.payload.messageId,
              memberId: requester.accountId,
              checkinAt: Option.none(),
              checkinClaimId: Option.none(),
              createdAt: Option.none(),
              updatedAt: Option.none(),
              deletedAt: Option.none(),
            },
          ]),
      },
    }) as unknown as ReturnType<typeof SheetApisClient.Service.get>,
} satisfies typeof SheetApisClient.Service;

describe("dispatch button entity", () => {
  it.effect("serializes same-message button operations", () =>
    Effect.gen(function* () {
      const events = yield* Ref.make<Array<string>>([]);
      const calls = yield* Ref.make(0);
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const clientFor = yield* makeClient(
        defaultHandlers({
          checkinButton: () =>
            Effect.gen(function* () {
              const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
              if (call === 1) {
                yield* Ref.update(events, (items) => [...items, "first-start"]);
                yield* Deferred.succeed(firstStarted, void 0);
                yield* Deferred.await(releaseFirst);
                yield* Ref.update(events, (items) => [...items, "first-end"]);
              } else {
                yield* Ref.update(events, (items) => [...items, "second-start"]);
                yield* Deferred.succeed(secondStarted, void 0);
                yield* Ref.update(events, (items) => [...items, "second-end"]);
              }
              return checkinButtonResult;
            }),
        }),
      );
      const client = yield* clientFor("message-1");

      const first = yield* client
        .checkinButton({ request: checkinButtonRequest, executionId: "execution-1" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const second = yield* client
        .checkinButton({ request: checkinButtonRequest, executionId: "execution-2" })
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      expect(yield* Ref.get(events)).toEqual(["first-start"]);

      yield* Deferred.succeed(releaseFirst, void 0);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      expect(yield* Ref.get(events)).toEqual([
        "first-start",
        "first-end",
        "second-start",
        "second-end",
      ]);
    }).pipe(Effect.provide(TestShardingConfig)),
  );

  it.effect("allows different-message button operations concurrently", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const clientFor = yield* makeClient(
        defaultHandlers({
          checkinButton: () =>
            Effect.gen(function* () {
              const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
              if (call === 1) {
                yield* Deferred.succeed(firstStarted, void 0);
                yield* Deferred.await(releaseFirst);
              } else {
                yield* Deferred.succeed(secondStarted, void 0);
              }
              return checkinButtonResult;
            }),
        }),
      );

      const firstClient = yield* clientFor("message-1");
      const secondClient = yield* clientFor("message-2");
      const first = yield* firstClient
        .checkinButton({ request: checkinButtonRequest, executionId: "execution-1" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const second = yield* secondClient
        .checkinButton({
          request: {
            ...checkinButtonRequest,
            payload: { ...checkinButtonRequest.payload, messageId: "message-2" },
          },
          executionId: "execution-2",
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(secondStarted);
      expect(yield* Ref.get(calls)).toBe(2);
      yield* Deferred.succeed(releaseFirst, void 0);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
    }).pipe(Effect.provide(TestShardingConfig)),
  );

  it.effect("routes all configured button RPCs", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<Array<string>>([]);
      const record = (operation: string) => Ref.update(calls, (items) => [...items, operation]);
      const clientFor = yield* makeClient(
        defaultHandlers({
          slotOpenButton: () => record("slotOpenButton").pipe(Effect.as(slotOpenButtonResult)),
          checkinButton: () => record("checkinButton").pipe(Effect.as(checkinButtonResult)),
          roomOrderPreviousButton: () =>
            record("roomOrderPreviousButton").pipe(Effect.as(roomOrderButtonResult)),
          roomOrderNextButton: () =>
            record("roomOrderNextButton").pipe(Effect.as(roomOrderButtonResult)),
          roomOrderSendButton: () =>
            record("roomOrderSendButton").pipe(
              Effect.as({ ...roomOrderButtonResult, status: "sent" as const }),
            ),
          roomOrderPinTentativeButton: () =>
            record("roomOrderPinTentativeButton").pipe(
              Effect.as({ ...roomOrderButtonResult, status: "pinned" as const }),
            ),
        }),
      );
      const slotOpenClient = yield* clientFor(slotOpenButtonRequest.payload.messageId);
      const checkinClient = yield* clientFor(checkinButtonRequest.payload.messageId);
      const roomOrderClient = yield* clientFor(roomOrderButtonRequest.payload.messageId);

      yield* slotOpenClient.slotOpenButton({
        request: slotOpenButtonRequest,
        executionId: "slot-open",
      });
      yield* checkinClient.checkinButton({ request: checkinButtonRequest, executionId: "checkin" });
      yield* roomOrderClient.roomOrderPreviousButton({
        request: roomOrderButtonRequest,
        executionId: "previous",
      });
      yield* roomOrderClient.roomOrderNextButton({
        request: roomOrderButtonRequest,
        executionId: "next",
      });
      yield* roomOrderClient.roomOrderSendButton({
        request: roomOrderButtonRequest,
        executionId: "send",
      });
      yield* roomOrderClient.roomOrderPinTentativeButton({
        request: roomOrderButtonRequest,
        executionId: "pin",
      });

      expect(yield* Ref.get(calls)).toEqual([
        "slotOpenButton",
        "checkinButton",
        "roomOrderPreviousButton",
        "roomOrderNextButton",
        "roomOrderSendButton",
        "roomOrderPinTentativeButton",
      ]);
    }).pipe(Effect.provide(TestShardingConfig)),
  );

  it.effect("preserves normalized failure behavior", () => {
    const updateOriginalInteractionResponse = vi.fn(
      (_interactionResponseToken: string, _payload: unknown) => Effect.void,
    );
    return Effect.gen(function* () {
      const clientFor = yield* Entity.makeTestClient(
        DispatchButtonEntity,
        dispatchButtonEntityLayer,
      );
      const client = yield* clientFor(checkinButtonRequest.payload.messageId);
      const exit = yield* client
        .checkinButton({ request: checkinButtonRequest, executionId: "execution-1" })
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(updateOriginalInteractionResponse).toHaveBeenCalledWith("interaction-token", {
        content:
          "Dispatch failed. Please try again.\nUnexpected error: check-in failed\nFull error is attached.",
        files: [
          expect.objectContaining({
            name: "error.txt",
            contentType: "text/plain",
            content: expect.any(Uint8Array),
          }),
        ],
      });
      const [, responsePayload] = updateOriginalInteractionResponse.mock.calls[0]!;
      const [file] = (
        responsePayload as { readonly files: ReadonlyArray<{ readonly content: Uint8Array }> }
      ).files;
      expect(new TextDecoder().decode(file.content)).toContain("check-in failed");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            DispatchService,
            makeDispatchServiceMock({
              checkinButton: () =>
                Effect.fail(
                  new SheetWorkflowsEntitiesDispatchButtonTestError({
                    message: "check-in failed",
                  }),
                ),
            }),
          ),
          Layer.succeed(ClientDeliveryClient, {
            updateOriginalInteractionResponse,
          } as never),
          Layer.succeed(SheetApisClient, sheetApisClientWithCheckinMember),
          WorkflowEngine.layerMemory,
          TestShardingConfig,
        ),
      ),
    );
  });

  it.effect("preserves handled interaction failure behavior", () => {
    const updateOriginalInteractionResponse = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const clientFor = yield* Entity.makeTestClient(
        DispatchButtonEntity,
        dispatchButtonEntityLayer,
      );
      const client = yield* clientFor(checkinButtonRequest.payload.messageId);
      const exit = yield* client
        .checkinButton({ request: checkinButtonRequest, executionId: "execution-1" })
        .pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(updateOriginalInteractionResponse).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(
            DispatchService,
            makeDispatchServiceMock({
              checkinButton: () =>
                Effect.fail(markInteractionFailureHandled(new Error("check-in failed"))),
            }),
          ),
          Layer.succeed(ClientDeliveryClient, { updateOriginalInteractionResponse } as never),
          Layer.succeed(SheetApisClient, sheetApisClientWithCheckinMember),
          WorkflowEngine.layerMemory,
          TestShardingConfig,
        ),
      ),
    );
  });
});
