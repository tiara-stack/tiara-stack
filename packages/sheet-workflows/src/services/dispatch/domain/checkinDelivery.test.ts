import { expect, it } from "@effect/vitest";
import { Cause, Duration, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import * as Data from "effect/Data";
import { CheckinGenerateResult } from "sheet-ingress-api/schemas/checkin";
import type { CheckinDispatchPayload } from "sheet-ingress-api/sheet-apis-rpc";
import { generatingCheckinMessage } from "sheet-message-content/checkinPrompt";
import { makeClientDeliveryMock, text } from "../../testHelpers";
import { deliverCheckin, deliverPersistedCheckinMessage } from "./checkinDelivery";

class CheckinDeliveryTestError extends Data.TaggedError("CheckinDeliveryTestError")<{
  readonly message: string;
}> {}

const payload: CheckinDispatchPayload = {
  client: { platform: "discord", clientId: "discord-main" },
  dispatchRequestId: "dispatch-checkin-delivery-test",
  workspaceId: "workspace-1",
  conversationId: "running-conversation",
};

it.effect("persists a placeholder before finalizing and compensates a failed finalization", () =>
  Effect.gen(function* () {
    const events: Array<string> = [];
    const sentPayloads: Array<unknown> = [];
    const updatedPayloads: Array<unknown> = [];
    let finalizationAttempts = 0;
    const botClient = makeClientDeliveryMock({
      sendMessage: (conversationId, payload) => {
        events.push("send");
        sentPayloads.push(payload);
        return Effect.succeed({ id: "checkin-message", conversation_id: conversationId });
      },
      updateMessage: (_conversationId, _messageId, payload) =>
        Effect.sync(() => {
          events.push("finalize");
          updatedPayloads.push(payload);
          finalizationAttempts += 1;
        }).pipe(
          Effect.andThen(Effect.fail(new CheckinDeliveryTestError({ message: "finalize failed" }))),
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
          monitorConversationId: null,
          fillCount: 0,
          roleId: null,
          initialMessage: null,
          monitorCheckinMessage: text("monitor"),
          monitorUserId: null,
          monitorCheckinRequired: false,
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
    expect(Option.getOrNull(error)).toMatchObject({ message: "finalize failed" });
    expect(events.slice(0, 2)).toEqual(["send", "persist"]);
    expect(sentPayloads[0]).toMatchObject({
      content: [
        { type: "text", text: "check in" },
        { type: "text", text: "\n" },
        {
          type: "subtle",
          parts: [{ type: "text", text: "Controls are being prepared..." }],
        },
      ],
    });
    expect(sentPayloads[0]).not.toHaveProperty("components");
    expect(finalizationAttempts).toBe(3);
    expect(updatedPayloads[0]).toMatchObject({
      content: [{ type: "text", text: "check in" }],
      components: [
        {
          components: [
            expect.objectContaining({ actionId: "interaction:checkin", disabled: false }),
          ],
        },
      ],
    });
    expect(events).toContain("remove-checkin");
    expect(events).toContain("delete-message");
  }),
);

it.effect("retries placeholder deletion when check-in persistence fails", () =>
  Effect.gen(function* () {
    let deleteAttempts = 0;
    const botClient = makeClientDeliveryMock({
      sendMessage: (conversationId) =>
        Effect.succeed({ id: "checkin-message", conversation_id: conversationId }),
      deleteMessage: () =>
        Effect.suspend(() => {
          deleteAttempts += 1;
          return deleteAttempts < 3
            ? Effect.fail(new CheckinDeliveryTestError({ message: "delete failed" }))
            : Effect.void;
        }),
    });
    const messageCheckinService = {
      persistMessageCheckin: () =>
        Effect.fail(new CheckinDeliveryTestError({ message: "persistence failed" })),
      getMessageCheckinData: () => Effect.die("ordinary persistence failures do not reconcile"),
      removeMessageCheckin: () => Effect.die("persistence failures do not remove stored state"),
    } satisfies Parameters<typeof deliverPersistedCheckinMessage>[0]["messageCheckinService"];
    const fiber = yield* Effect.forkChild(
      deliverPersistedCheckinMessage({
        botClient,
        checkinConversationId: "checkin-conversation",
        messageCheckinService,
        persistence: {
          data: {
            initialMessage: text("check in"),
            hour: 1,
            runningConversationId: "running-conversation",
            roleId: null,
            workspaceId: "workspace-1",
            conversationId: "checkin-conversation",
            createdByUserId: null,
          },
          memberIds: [],
        },
        placeholderMessage: generatingCheckinMessage(text("check in")),
      }).pipe(Effect.exit),
    );

    yield* TestClock.adjust(Duration.seconds(1));
    const exit = yield* Fiber.join(fiber);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(deleteAttempts).toBe(3);
  }),
);
