import { Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Workflow } from "effect/unstable/workflow";

export const scheduledHourMillis = 3_600_000;

export const canonicalScheduledHourBucket = (epochMs: number): number => {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError("scheduled hour bucket must be finite");
  }
  return Math.floor(epochMs / scheduledHourMillis) * scheduledHourMillis;
};

const AutonomousSweepPayload = Schema.Struct({
  scheduledHourBucketEpochMs: Schema.Int,
});

type AutonomousSweepPayload = typeof AutonomousSweepPayload.Type;

const autonomousSweepResult = Schema.Struct({
  scheduledHourBucketEpochMs: Schema.Int,
  acceptedInvocationCount: Schema.Int,
});

export type AutonomousSweepResult = typeof autonomousSweepResult.Type;

const sweepIdempotencyKey = (kind: string, payload: AutonomousSweepPayload) =>
  `${kind}:${canonicalScheduledHourBucket(payload.scheduledHourBucketEpochMs)}`;

export const AutoCheckinSweepWorkflow = Workflow.make({
  name: "autoCheckin.sweep",
  payload: AutonomousSweepPayload,
  success: autonomousSweepResult,
  error: Schema.Unknown,
  idempotencyKey: (payload) => sweepIdempotencyKey("auto-checkin-sweep", payload),
}).annotate(ClusterSchema.ShardGroup, () => "autoCheckin");

export const AutoRoleCleanupSweepWorkflow = Workflow.make({
  name: "autoRoleCleanup.sweep",
  payload: AutonomousSweepPayload,
  success: autonomousSweepResult,
  error: Schema.Unknown,
  idempotencyKey: (payload) => sweepIdempotencyKey("auto-role-cleanup-sweep", payload),
}).annotate(ClusterSchema.ShardGroup, () => "autoCheckin");
