import { describe, expect, it } from "@effect/vitest";
import { Context, Effect } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { WorkflowEngine } from "effect/unstable/workflow";
import { AutoCheckinService } from "@/services";
import { autoCheckinWorkflowLayer } from "./autoCheckin";
import {
  AutoCheckinConversationResult,
  AutoCheckinConversationWorkflow,
} from "./autoCheckinContract";
import type { AutoCheckinConversationPayload } from "./autoCheckinContract";

const payload: AutoCheckinConversationPayload = {
  workspaceId: "workspace-1",
  conversationName: "main",
  hour: 3,
  eventStartEpochMs: 1_774_524_000_000,
};

const result: AutoCheckinConversationResult = {
  workspaceId: payload.workspaceId,
  conversationName: payload.conversationName,
  hour: payload.hour,
  status: "sent",
  checkinMessageId: "checkin-message",
  monitorMessageId: "monitor-message",
  tentativeRoomOrderMessageId: "room-order-message",
};

describe("auto check-in workflow", () => {
  it("assigns the workflow to the configured autoCheckin shard group", () => {
    const shardGroup = Context.get(
      AutoCheckinConversationWorkflow.annotations,
      ClusterSchema.ShardGroup,
    );
    expect(shardGroup(undefined as never)).toBe("autoCheckin");
  });

  it("routes conversation processing to AutoCheckinService", async () => {
    const service = {
      enqueueDueConversations: () => Effect.die("Unexpected enqueueDueConversations call"),
      enqueueWorkspace: () => Effect.die("Unexpected enqueueWorkspace call"),
      processConversation: (currentPayload: AutoCheckinConversationPayload) =>
        Effect.sync(() => {
          expect(currentPayload).toEqual(payload);
          return result;
        }),
    } satisfies typeof AutoCheckinService.Service;

    await Effect.runPromise(
      AutoCheckinConversationWorkflow.execute(payload).pipe(
        Effect.tap((processed) => Effect.sync(() => expect(processed).toEqual(result))),
        Effect.provide(autoCheckinWorkflowLayer),
        Effect.provideService(AutoCheckinService, service),
        Effect.provide(WorkflowEngine.layerMemory),
      ),
    );
  });

  it.effect(
    "builds deterministic workflow execution ids from workspace, event, hour, and conversation",
    () =>
      Effect.gen(function* () {
        const baseline = yield* AutoCheckinConversationWorkflow.executionId(payload);
        const same = yield* AutoCheckinConversationWorkflow.executionId({
          ...payload,
        });
        const differentEvent = yield* AutoCheckinConversationWorkflow.executionId({
          ...payload,
          eventStartEpochMs: payload.eventStartEpochMs + 1,
        });
        const differentHour = yield* AutoCheckinConversationWorkflow.executionId({
          ...payload,
          hour: payload.hour + 1,
        });
        const differentWorkspace = yield* AutoCheckinConversationWorkflow.executionId({
          ...payload,
          workspaceId: "workspace-2",
        });
        const differentConversation = yield* AutoCheckinConversationWorkflow.executionId({
          ...payload,
          conversationName: "side",
        });

        expect(same).toBe(baseline);
        expect(differentEvent).not.toBe(baseline);
        expect(differentHour).not.toBe(baseline);
        expect(differentWorkspace).not.toBe(baseline);
        expect(differentConversation).not.toBe(baseline);
      }),
  );
});
