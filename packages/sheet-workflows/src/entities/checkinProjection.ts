import { type Effect, Layer } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import { EditMessageReceipt } from "sheet-bot-api";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { CheckinCommittedExecution } from "@/workflows/checkins/schema";

export const CheckinProjectionEntity = Entity.make("CheckinProjection", [
  Rpc.make("project", {
    payload: CheckinCommittedExecution,
    success: EditMessageReceipt,
    error: InteractiveDeclaredFailure,
  }),
]).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export type CheckinProjectionRequest = {
  readonly payload: typeof CheckinCommittedExecution.Type;
};

export const makeCheckinProjectionEntityLayer = <R>(handler: {
  readonly project: (
    request: CheckinProjectionRequest,
  ) => Effect.Effect<typeof EditMessageReceipt.Type, typeof InteractiveDeclaredFailure.Type, R>;
}) =>
  CheckinProjectionEntity.toLayer(CheckinProjectionEntity.of(handler), {
    maxIdleTime: "5 minutes",
    concurrency: 1,
  }).pipe(Layer.withSpan("sheet-workflows.checkinProjectionEntity"));
