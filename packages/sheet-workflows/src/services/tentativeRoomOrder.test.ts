import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import * as Data from "effect/Data";
import { makeClientDeliveryMock } from "./testHelpers";
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
