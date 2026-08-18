import { type Effect, Layer } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import { CalculationDeclaredFailure, CalculationsRecalculateSheet } from "sheet-workflow-contracts";
import { CanonicalCalculationExecution } from "@/workflows/calculations/schema";

const CalculationProjectionRunRpc = Rpc.make("run", {
  payload: CanonicalCalculationExecution,
  success: CalculationsRecalculateSheet.success,
  error: CalculationDeclaredFailure,
});

export const CalculationProjectionEntity = Entity.make("CalculationProjection", [
  CalculationProjectionRunRpc,
])
  .annotate(ClusterSchema.ShardGroup, () => "dispatch")
  .annotate(ClusterSchema.Persisted, true);

export type CalculationProjectionRunRequest = Parameters<
  Parameters<typeof CalculationProjectionEntity.of>[0]["run"]
>[0];

export const makeCalculationProjectionEntityLayer = <R>(handler: {
  readonly run: (
    request: CalculationProjectionRunRequest,
  ) => Effect.Effect<
    typeof CalculationsRecalculateSheet.success.Type,
    typeof CalculationDeclaredFailure.Type,
    R
  >;
}) =>
  CalculationProjectionEntity.toLayer(CalculationProjectionEntity.of(handler), {
    maxIdleTime: "5 minutes",
    concurrency: 1,
  }).pipe(Layer.withSpan("sheet-workflows.calculationProjectionEntity"));
