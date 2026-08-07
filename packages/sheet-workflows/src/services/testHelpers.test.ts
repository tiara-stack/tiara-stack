import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
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
