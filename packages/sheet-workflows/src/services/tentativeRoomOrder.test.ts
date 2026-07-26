import { expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber } from "effect";
import * as Data from "effect/Data";
import { TestClock } from "effect/testing";
import { MessageRoomOrderRange } from "sheet-ingress-api/schemas/messageRoomOrder";
import { RoomOrderGenerateResult } from "sheet-ingress-api/schemas/roomOrder";
import { makeClientDeliveryMock, normalizePayloadText, text } from "./testHelpers";
import { sendTentativeRoomOrder } from "./tentativeRoomOrder";

class TentativeRoomOrderTestError extends Data.TaggedError("TentativeRoomOrderTestError")<{
  readonly message: string;
}> {}

const runTentativeRoomOrder = (generate: () => Effect.Effect<never, unknown>) =>
  sendTentativeRoomOrder({
    workspaceId: "workspace-1",
    runningConversationId: "conversation-1",
    hour: 1,
    fillCount: 5,
    createdByUserId: "user-1",
    client: { platform: "discord", clientId: "discord-main" },
    botClient: makeClientDeliveryMock(),
    roomOrderService: { generate },
    messageRoomOrderService: {
      persistMessageRoomOrder: () => Effect.die("unexpected room-order persistence"),
    },
    logPrefix: "",
  });

it.effect("recovers ordinary tentative room-order generation failures", () =>
  Effect.gen(function* () {
    const result = yield* runTentativeRoomOrder(() =>
      Effect.fail(new TentativeRoomOrderTestError({ message: "generation failed" })),
    );

    expect(result).toBeNull();
  }),
);

it.effect("preserves tentative room-order generation interrupts", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      runTentativeRoomOrder(() => Effect.failCause(Cause.interrupt(19))),
    );

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  }),
);

it.effect("persists a placeholder before publishing tentative room-order controls", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const messages: Array<unknown> = [];
    const botClient = makeClientDeliveryMock({
      sendMessage: (conversationId, message) => {
        events.push("send");
        messages.push(normalizePayloadText(message));
        return Effect.succeed({ id: "message-1", conversation_id: conversationId });
      },
      updateMessage: (_conversationId, _messageId, message) => {
        events.push("update");
        messages.push(normalizePayloadText(message));
        return Effect.succeed({ id: "message-1", conversation_id: "conversation-1" });
      },
    });
    const result = yield* sendTentativeRoomOrder({
      workspaceId: "workspace-1",
      runningConversationId: "conversation-1",
      hour: 1,
      fillCount: 5,
      createdByUserId: "user-1",
      client: { platform: "discord", clientId: "discord-main" },
      botClient,
      roomOrderService: {
        generate: () =>
          Effect.succeed(
            new RoomOrderGenerateResult({
              content: text("room order"),
              runningConversationId: "conversation-1",
              range: new MessageRoomOrderRange({ minRank: 1, maxRank: 1 }),
              rank: 1,
              hour: 1,
              monitor: null,
              previousFills: [],
              fills: ["user-1"],
              entries: [],
            }),
          ),
      },
      messageRoomOrderService: {
        persistMessageRoomOrder: () => {
          events.push("persist");
          return Effect.void;
        },
      },
      logPrefix: "",
    });

    expect(result).toEqual({
      messageId: "message-1",
      messageConversationId: "conversation-1",
    });
    expect(events).toEqual(["send", "persist", "update"]);
    expect(messages[0]).toEqual({
      content: "Generating room order message...",
    });
    expect(messages[1]).toMatchObject({
      content: "(tentative)\nroom order",
      components: [
        {
          components: [
            expect.objectContaining({ actionId: "interaction:roomOrder:previous" }),
            expect.objectContaining({ actionId: "interaction:roomOrder:next" }),
            expect.objectContaining({ actionId: "interaction:roomOrder:pinTentative" }),
          ],
        },
      ],
    });
  }),
);

it.effect("retries a failed tentative room-order finalization after persistence", () =>
  Effect.gen(function* () {
    let persistCalls = 0;
    let updateCalls = 0;
    const botClient = makeClientDeliveryMock({
      sendMessage: (conversationId) =>
        Effect.succeed({ id: "message-1", conversation_id: conversationId }),
      updateMessage: () =>
        Effect.suspend(() => {
          updateCalls += 1;
          return Effect.fail(new TentativeRoomOrderTestError({ message: "finalization failed" }));
        }),
    });
    const program = sendTentativeRoomOrder({
      workspaceId: "workspace-1",
      runningConversationId: "conversation-1",
      hour: 1,
      fillCount: 5,
      createdByUserId: "user-1",
      client: { platform: "discord", clientId: "discord-main" },
      botClient,
      roomOrderService: {
        generate: () =>
          Effect.succeed(
            new RoomOrderGenerateResult({
              content: text("room order"),
              runningConversationId: "conversation-1",
              range: new MessageRoomOrderRange({ minRank: 1, maxRank: 1 }),
              rank: 1,
              hour: 1,
              monitor: null,
              previousFills: [],
              fills: ["user-1"],
              entries: [],
            }),
          ),
      },
      messageRoomOrderService: {
        persistMessageRoomOrder: () => {
          persistCalls += 1;
          return Effect.void;
        },
      },
      logPrefix: "",
    });

    const fiber = yield* Effect.forkChild(program);
    yield* TestClock.adjust(Duration.seconds(1));
    const result = yield* Fiber.join(fiber);

    expect(result).toBeNull();
    expect(persistCalls).toBe(1);
    expect(updateCalls).toBe(3);
  }),
);
