import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";
import { AutoCheckinService } from "@/services";
import { autoCheckinWorkflowLayer } from "./autoCheckin";
import {
  AutoCheckinChannelPayload,
  AutoCheckinChannelResult,
  AutoCheckinChannelWorkflow,
} from "./autoCheckinContract";

const payload: AutoCheckinChannelPayload = {
  guildId: "guild-1",
  channelName: "main",
  hour: 3,
  eventStartEpochMs: 1_774_524_000_000,
};

const result: AutoCheckinChannelResult = {
  guildId: payload.guildId,
  channelName: payload.channelName,
  hour: payload.hour,
  status: "sent",
  checkinMessageId: "checkin-message",
  monitorMessageId: "monitor-message",
  tentativeRoomOrderMessageId: "room-order-message",
};

describe("auto check-in workflow", () => {
  it("routes channel processing to AutoCheckinService", async () => {
    const service = {
      enqueueDueChannels: () => Effect.die("Unexpected enqueueDueChannels call"),
      enqueueGuild: () => Effect.die("Unexpected enqueueGuild call"),
      processChannel: (currentPayload: AutoCheckinChannelPayload) =>
        Effect.sync(() => {
          expect(currentPayload).toEqual(payload);
          return result;
        }),
    } satisfies typeof AutoCheckinService.Service;

    await Effect.runPromise(
      AutoCheckinChannelWorkflow.execute(payload).pipe(
        Effect.tap((processed) => Effect.sync(() => expect(processed).toEqual(result))),
        Effect.provide(autoCheckinWorkflowLayer),
        Effect.provideService(AutoCheckinService, service),
        Effect.provide(WorkflowEngine.layerMemory),
      ),
    );
  });

  it.effect(
    "builds deterministic workflow execution ids from guild, event, hour, and channel",
    () =>
      Effect.gen(function* () {
        const baseline = yield* AutoCheckinChannelWorkflow.executionId(payload);
        const same = yield* AutoCheckinChannelWorkflow.executionId({
          ...payload,
        });
        const differentEvent = yield* AutoCheckinChannelWorkflow.executionId({
          ...payload,
          eventStartEpochMs: payload.eventStartEpochMs + 1,
        });
        const differentHour = yield* AutoCheckinChannelWorkflow.executionId({
          ...payload,
          hour: payload.hour + 1,
        });
        const differentGuild = yield* AutoCheckinChannelWorkflow.executionId({
          ...payload,
          guildId: "guild-2",
        });
        const differentChannel = yield* AutoCheckinChannelWorkflow.executionId({
          ...payload,
          channelName: "side",
        });

        expect(same).toBe(baseline);
        expect(differentEvent).not.toBe(baseline);
        expect(differentHour).not.toBe(baseline);
        expect(differentGuild).not.toBe(baseline);
        expect(differentChannel).not.toBe(baseline);
      }),
  );
});
