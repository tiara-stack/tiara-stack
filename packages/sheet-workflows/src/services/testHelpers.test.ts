import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import {
  makeClientDeliveryMock,
  makeSheetApisClient,
  makeTrustedSheetPersistenceMock,
} from "./testHelpers";

it.effect("resolves spread delivery overrides through the bound client", () =>
  Effect.gen(function* () {
    const expected = { id: "message-1", conversation_id: "conversation-1" };
    const client = {
      ...makeClientDeliveryMock(),
      sendMessage: () => Effect.succeed(expected),
    };

    const delivered = yield* client.forClient(undefined).sendMessage("conversation-1", {});

    expect(delivered).toEqual(expected);
  }),
);

it.effect("preserves tagged keys nested inside persistence JSON", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(1_234);
    const nestedValue = { _tag: "custom-payload", value: "kept" };
    const persistence = makeTrustedSheetPersistenceMock(
      makeSheetApisClient({
        messageCheckin: {
          getMessageCheckinData: () =>
            Effect.succeed(
              Option.some({
                _tag: "MessageCheckin",
                initialMessage: [nestedValue],
                runningConversationId: "running-1",
              }),
            ),
        },
      }),
    );

    const row = Option.getOrThrow(
      yield* persistence.checkinState.getMessageCheckinData({
        clientPlatform: "discord",
        clientId: "client-1",
        messageId: "message-1",
      }),
    );

    expect(row).not.toHaveProperty("_tag");
    expect(row.initialMessage).toEqual([nestedValue]);
    expect(row.createdAt).toBe(1_234);
    expect(row.updatedAt).toBe(1_234);
  }),
);

it.effect("checks tentative room-order ownership after a cold-cache load", () =>
  Effect.gen(function* () {
    let markCalls = 0;
    let markRequest: unknown;
    const persistence = makeTrustedSheetPersistenceMock(
      makeSheetApisClient({
        messageRoomOrder: {
          getMessageRoomOrder: () =>
            Effect.succeed(
              Option.some({
                _tag: "MessageRoomOrder",
                workspaceId: "workspace-1",
                conversationId: "conversation-1",
              }),
            ),
          markMessageRoomOrderTentative: (request: unknown) =>
            Effect.sync(() => {
              markCalls += 1;
              markRequest = request;
            }),
        },
      }),
    );

    yield* persistence.roomOrderState.markMessageRoomOrderTentative({
      clientPlatform: "discord",
      clientId: "client-1",
      messageId: "message-1",
      workspaceId: "workspace-2",
      conversationId: "conversation-1",
    });

    expect(markCalls).toBe(0);

    yield* persistence.roomOrderState.markMessageRoomOrderTentative({
      clientPlatform: "discord",
      clientId: "client-1",
      messageId: "message-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
    });

    expect(markCalls).toBe(1);
    expect(markRequest).toMatchObject({
      payload: {
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
      },
    });
  }),
);

it.effect("serializes insert-only room-order binds by message key", () =>
  Effect.gen(function* () {
    const firstReadStarted = yield* Deferred.make<void>();
    const releaseRead = yield* Deferred.make<void>();
    const readRequests: Array<unknown> = [];
    let persistCalls = 0;
    const persistence = makeTrustedSheetPersistenceMock(
      makeSheetApisClient({
        messageRoomOrder: {
          getMessageRoomOrder: ({ query }: { readonly query: unknown }) =>
            Effect.gen(function* () {
              readRequests.push(query);
              if (readRequests.length === 1) {
                yield* Deferred.succeed(firstReadStarted, void 0);
              }
              yield* Deferred.await(releaseRead);
              return Option.none();
            }),
          persistMessageRoomOrder: ({ payload }: { readonly payload: any }) =>
            Effect.sync(() => {
              persistCalls += 1;
              return {
                _tag: "MessageRoomOrder",
                clientPlatform: payload.clientPlatform,
                clientId: payload.clientId,
                messageId: payload.messageId,
                ...payload.data,
              };
            }),
        },
      }),
    );
    const key = {
      clientPlatform: "discord",
      clientId: "client-1",
      messageId: "message-1",
    } as const;
    const first = yield* persistence.roomOrderState
      .bindMessageRoomOrderIfAbsent({
        ...key,
        data: {
          previousFills: [],
          fills: ["first"],
          hour: 1,
          rank: 0,
          tentative: false,
          monitor: null,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "user-1",
        },
        entries: [],
      })
      .pipe(Effect.forkScoped);
    yield* Deferred.await(firstReadStarted);
    const second = yield* persistence.roomOrderState
      .bindMessageRoomOrderIfAbsent({
        ...key,
        data: {
          previousFills: [],
          fills: ["second"],
          hour: 2,
          rank: 0,
          tentative: false,
          monitor: null,
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          createdByUserId: "user-2",
        },
        entries: [],
      })
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseRead, void 0);
    yield* Effect.all([Fiber.join(first), Fiber.join(second)]);

    expect(persistCalls).toBe(1);
    expect(readRequests).toEqual([key]);
    expect(
      Option.getOrThrow(yield* persistence.roomOrderState.getMessageRoomOrder(key)),
    ).toMatchObject({
      fills: ["first"],
      hour: 1,
      createdByUserId: "user-1",
    });
  }),
);
