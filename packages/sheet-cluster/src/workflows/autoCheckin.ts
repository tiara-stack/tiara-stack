import { Effect } from "effect";
import { Activity } from "effect/unstable/workflow";
import { AutoCheckinService } from "@/services";
import {
  AutoCheckinChannelPayload,
  AutoCheckinChannelResult,
  AutoCheckinChannelWorkflow,
} from "./autoCheckinContract";

export { AutoCheckinChannelPayload, AutoCheckinChannelResult, AutoCheckinChannelWorkflow };

export const autoCheckinWorkflowLayer = AutoCheckinChannelWorkflow.toLayer(
  Effect.fn("AutoCheckinChannelWorkflow.handler")(function* (payload, executionId) {
    const service = yield* AutoCheckinService;
    return yield* Activity.make({
      name: `autoCheckin.channel.${executionId}.execute`,
      success: AutoCheckinChannelResult,
      error: AutoCheckinChannelWorkflow.errorSchema,
      execute: service.processChannel(payload),
    });
  }),
);
