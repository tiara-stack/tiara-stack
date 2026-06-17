import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { Deferred, Effect, Fiber, Option, Ref } from "effect";
import { Entity, ShardingConfig } from "effect/unstable/cluster";
import { WorkflowEngine } from "effect/unstable/workflow";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { DispatchService, IngressBotClient, SheetApisClient } from "@/services";
import { MessageRoomOrder } from "sheet-ingress-api/schemas/messageRoomOrder";
import { dispatchButtonEntityLayer } from "@/workflows/dispatchRegistry";
import {
  DispatchButtonEntity,
  type DispatchButtonEntityHandlers,
  makeDispatchButtonEntityLayer,
} from "./dispatchButton";

const requester = {
  accountId: "account-1",
  userId: "user-1",
};

const interactionDeadlineEpochMs = 4_102_444_800_000;

const checkinButtonRequest = {
  requester,
  payload: {
    messageId: "message-1",
    interactionToken: "interaction-token",
    interactionDeadlineEpochMs,
  },
};

const slotOpenButtonRequest = {
  requester,
  payload: {
    messageId: "slot-message-1",
    interactionToken: "interaction-token",
    interactionDeadlineEpochMs,
  },
};

const authorizedRoomOrder = new MessageRoomOrder({
  messageId: "message-1",
  hour: 1,
  previousFills: [],
  fills: [],
  rank: 1,
  tentative: false,
  monitor: Option.none(),
  guildId: Option.some("guild-1"),
  messageChannelId: Option.some("channel-1"),
  createdByUserId: Option.some(requester.userId),
  sendClaimId: Option.none(),
  sendClaimedAt: Option.none(),
  sentMessageId: Option.none(),
  sentMessageChannelId: Option.none(),
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
    guildId: "guild-1",
    messageId: "message-1",
    messageChannelId: "channel-1",
    interactionToken: "interaction-token",
    interactionDeadlineEpochMs,
  },
};

const checkinButtonResult = {
  messageId: "message-1",
  messageChannelId: "channel-1",
  checkedInMemberId: requester.accountId,
};

const slotOpenButtonResult = {
  messageId: "slot-message-1",
  guildId: "guild-1",
  day: 1,
};

const roomOrderButtonResult = {
  messageId: "message-1",
  messageChannelId: "channel-1",
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
    const updateOriginalInteractionResponseWithFiles = vi.fn(
      (
        _interactionToken: string,
        _payload: unknown,
        _files: ReadonlyArray<{ readonly content: Uint8Array }>,
      ) => Effect.void,
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
      expect(updateOriginalInteractionResponseWithFiles).toHaveBeenCalledWith(
        "interaction-token",
        {
          content:
            "Dispatch failed. Please try again.\nUnexpected error: check-in failed\nFull error is attached.",
          attachments: [{ id: "0", filename: "error.txt" }],
        },
        [
          expect.objectContaining({
            name: "error.txt",
            contentType: "text/plain",
            content: expect.any(Uint8Array),
          }),
        ],
      );
      const [, , files] = updateOriginalInteractionResponseWithFiles.mock.calls[0]!;
      const [file] = files as ReadonlyArray<{ readonly content: Uint8Array }>;
      expect(new TextDecoder().decode(file.content)).toContain("check-in failed");
    }).pipe(
      Effect.provideService(
        DispatchService,
        makeDispatchServiceMock({
          checkinButton: () => Effect.fail(new Error("check-in failed")),
        }),
      ),
      Effect.provideService(IngressBotClient, {
        updateOriginalInteractionResponseWithFiles,
      } as never),
      Effect.provideService(SheetApisClient, sheetApisClientWithCheckinMember),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.provide(TestShardingConfig),
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
      Effect.provideService(
        DispatchService,
        makeDispatchServiceMock({
          checkinButton: () =>
            Effect.fail(markInteractionFailureHandled(new Error("check-in failed"))),
        }),
      ),
      Effect.provideService(IngressBotClient, { updateOriginalInteractionResponse } as never),
      Effect.provideService(SheetApisClient, sheetApisClientWithCheckinMember),
      Effect.provide(WorkflowEngine.layerMemory),
      Effect.provide(TestShardingConfig),
    );
  });
});
