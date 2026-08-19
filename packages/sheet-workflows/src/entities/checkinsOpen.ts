import { type Effect, Layer } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import { CheckinsOpen, InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import { CheckinsOpenResolvedExecution } from "@/workflows/checkins/openSchema";

export const CheckinsOpenEntity = Entity.make("CheckinsOpen", [
  Rpc.make("run", {
    payload: CheckinsOpenResolvedExecution,
    success: CheckinsOpen.success,
    error: InteractiveDeclaredFailure,
  }),
]).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export type CheckinsOpenRunRequest = {
  readonly payload: typeof CheckinsOpenResolvedExecution.Type;
};

export const makeCheckinsOpenEntityLayer = <R>(handler: {
  readonly run: (
    request: CheckinsOpenRunRequest,
  ) => Effect.Effect<typeof CheckinsOpen.success.Type, typeof InteractiveDeclaredFailure.Type, R>;
}) =>
  CheckinsOpenEntity.toLayer(CheckinsOpenEntity.of(handler), {
    maxIdleTime: "5 minutes",
    concurrency: 1,
  }).pipe(Layer.withSpan("sheet-workflows.checkinsOpenEntity"));
