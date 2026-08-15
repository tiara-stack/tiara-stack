import { type Effect, Layer } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import { InteractiveDeclaredFailure } from "sheet-workflow-contracts";
import {
  WorkspaceFeatureFlagExecution,
  WorkspaceFeatureFlagState,
} from "@/workflows/workspaces/featureFlagSchema";

export const WorkspaceFeatureFlagEntity = Entity.make("WorkspaceFeatureFlag", [
  Rpc.make("set", {
    payload: WorkspaceFeatureFlagExecution,
    success: WorkspaceFeatureFlagState,
    error: InteractiveDeclaredFailure,
  }),
]).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export type WorkspaceFeatureFlagSetRequest = {
  readonly payload: typeof WorkspaceFeatureFlagExecution.Type;
};

export const makeWorkspaceFeatureFlagEntityLayer = <R>(handler: {
  readonly set: (
    request: WorkspaceFeatureFlagSetRequest,
  ) => Effect.Effect<
    typeof WorkspaceFeatureFlagState.Type,
    typeof InteractiveDeclaredFailure.Type,
    R
  >;
}) =>
  WorkspaceFeatureFlagEntity.toLayer(WorkspaceFeatureFlagEntity.of(handler), {
    maxIdleTime: "5 minutes",
    concurrency: 1,
  }).pipe(Layer.withSpan("sheet-workflows.workspaceFeatureFlagEntity"));
