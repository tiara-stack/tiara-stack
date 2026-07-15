import { expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import * as Data from "effect/Data";
import { CheckinGenerateResult } from "sheet-ingress-api/schemas/checkin";
import type { CheckinDispatchPayload } from "sheet-ingress-api/sheet-apis-rpc";
import { makeClientDeliveryMock, text } from "../../testHelpers";
import { deliverCheckin } from "./checkinDelivery";

class CheckinDeliveryTestError extends Data.TaggedError("CheckinDeliveryTestError")<{
  readonly message: string;
}> {}

const payload: CheckinDispatchPayload = {
  client: { platform: "discord", clientId: "discord-main" },
  dispatchRequestId: "dispatch-checkin-delivery-test",
  workspaceId: "workspace-1",
  conversationId: "running-conversation",
};

it.effect("persists before enabling and compensates a failed enablement", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    let enableAttempts = 0;
    const botClient = makeClientDeliveryMock({
      sendMessage: (conversationId) => {
        events.push("send");
        return Effect.succeed({ id: "checkin-message", conversation_id: conversationId });
      },
      updateMessage: () =>
        Effect.sync(() => {
          events.push("enable");
          enableAttempts += 1;
        }).pipe(
          Effect.andThen(Effect.fail(new CheckinDeliveryTestError({ message: "enable failed" }))),
        ),
      deleteMessage: () => {
        events.push("delete-message");
        return Effect.void;
      },
    });
    const messageCheckinService = {
      persistMessageCheckin: () => {
        events.push("persist");
        return Effect.succeed({});
      },
      getMessageCheckinData: () => Effect.succeed(Option.none()),
      removeMessageCheckin: () => {
        events.push("remove-checkin");
        return Effect.void;
      },
    } satisfies Parameters<typeof deliverCheckin>[0]["messageCheckinService"];
    const messageRoomOrderService = {
      persistMessageRoomOrder: () => Effect.die("room order must not be persisted"),
    } satisfies Parameters<typeof deliverCheckin>[0]["messageRoomOrderService"];
    const roomOrderService = {
      generate: () => Effect.die("room order must not be generated"),
    } satisfies Parameters<typeof deliverCheckin>[0]["roomOrderService"];
    const userConfigService = {
      getCheckinDmRecipients: () => Effect.die("check-in DMs must not be loaded"),
      getMonitorDmRecipients: () => Effect.die("monitor DMs must not be loaded"),
    } satisfies Parameters<typeof deliverCheckin>[0]["userConfigService"];

    const fiber = yield* Effect.forkChild(
      deliverCheckin({
        autoCheckinConcurrency: 1,
        botClient,
        createdByUserId: "user-1",
        generated: new CheckinGenerateResult({
          hour: 1,
          runningConversationId: "running-conversation",
          checkinConversationId: "checkin-conversation",
          fillCount: 0,
          roleId: null,
          initialMessage: null,
          monitorCheckinMessage: text("monitor"),
          monitorUserId: null,
          monitorFailureMessage: null,
          fillIds: [],
        }),
        initialMessage: text("check in"),
        messageCheckinService,
        messageRoomOrderService,
        payload,
        roomOrderService,
        userConfigService,
      }).pipe(Effect.exit),
    );
    yield* TestClock.adjust(Duration.seconds(1));
    const exit = yield* Fiber.join(fiber);

    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
    expect(Option.getOrNull(error)).toMatchObject({ message: "enable failed" });
    expect(events.slice(0, 2)).toEqual(["send", "persist"]);
    expect(enableAttempts).toBe(3);
    expect(events).toContain("remove-checkin");
    expect(events).toContain("delete-message");
  }),
);
