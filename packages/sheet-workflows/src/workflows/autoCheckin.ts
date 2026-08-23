import { Effect, Layer } from "effect";
import { Activity, Workflow } from "effect/unstable/workflow";
import { AutonomousTriggerService } from "@/services";
import {
  AutoCheckinSweepWorkflow,
  AutoRoleCleanupSweepWorkflow,
  type AutonomousSweepResult,
} from "./autoCheckinContract";

type AutonomousSweepWorkflow = Workflow.Workflow<
  string,
  typeof AutoCheckinSweepWorkflow.payloadSchema,
  typeof AutoCheckinSweepWorkflow.successSchema,
  typeof AutoCheckinSweepWorkflow.errorSchema
>;

const makeAutonomousSweepLayer = (options: {
  readonly workflow: AutonomousSweepWorkflow;
  readonly activityName: string;
  readonly spanName: string;
  readonly sweep: (
    service: typeof AutonomousTriggerService.Service,
    scheduledHourBucketEpochMs: number,
  ) => Effect.Effect<AutonomousSweepResult, unknown>;
}) =>
  options.workflow.toLayer(
    Effect.fn(`${options.workflow.name}.handler`)(function* (payload, executionId) {
      const service = yield* AutonomousTriggerService;
      const attributes = {
        executionId,
        scheduledHourBucketEpochMs: payload.scheduledHourBucketEpochMs,
      };
      return yield* Activity.make({
        name: options.activityName,
        success: options.workflow.successSchema,
        error: options.workflow.errorSchema,
        execute: options.sweep(service, payload.scheduledHourBucketEpochMs),
      }).pipe(Effect.annotateLogs(attributes), Effect.withSpan(options.spanName, { attributes }));
    }),
  );

const autoCheckinSweepLayer = makeAutonomousSweepLayer({
  workflow: AutoCheckinSweepWorkflow,
  activityName: "autoCheckin.sweep.execute",
  spanName: "AutoCheckinSweepWorkflow.execute",
  sweep: (service, scheduledHourBucketEpochMs) =>
    service.sweepAutoCheckin(scheduledHourBucketEpochMs),
});

const autoRoleCleanupSweepLayer = makeAutonomousSweepLayer({
  workflow: AutoRoleCleanupSweepWorkflow,
  activityName: "autoRoleCleanup.sweep.execute",
  spanName: "AutoRoleCleanupSweepWorkflow.execute",
  sweep: (service, scheduledHourBucketEpochMs) =>
    service.sweepAutoRoleCleanup(scheduledHourBucketEpochMs),
});

export const autonomousTriggerWorkflowLayer = Layer.merge(
  autoCheckinSweepLayer,
  autoRoleCleanupSweepLayer,
);
