import { Effect, Layer } from "effect";
import { ClusterSchema, Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import {
  AutonomousDeclaredFailure,
  InteractiveDeclaredFailure,
  TeamSubmissionsDecide,
  TeamSubmissionsProcess,
} from "sheet-workflow-contracts";
import {
  TeamSubmissionsDecideExecution,
  TeamSubmissionsProcessExecution,
} from "@/workflows/teamSubmissions/schema";
import { TeamSubmissionsWorkflowOperations } from "@/workflows/teamSubmissions/service";

export const TeamSubmissionsEntity = Entity.make("TeamSubmissions", [
  Rpc.make("process", {
    payload: TeamSubmissionsProcessExecution,
    success: TeamSubmissionsProcess.success,
    error: AutonomousDeclaredFailure,
  }),
  Rpc.make("decide", {
    payload: TeamSubmissionsDecideExecution,
    success: TeamSubmissionsDecide.success,
    error: InteractiveDeclaredFailure,
  }),
]).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const makeTeamSubmissionsEntityLayer = () =>
  TeamSubmissionsEntity.toLayer(
    TeamSubmissionsEntity.of({
      process: ({ payload }) =>
        Effect.flatMap(TeamSubmissionsWorkflowOperations, (operations) =>
          operations.process(payload),
        ),
      decide: ({ payload }) =>
        Effect.flatMap(TeamSubmissionsWorkflowOperations, (operations) =>
          operations.decide(payload),
        ),
    }),
    { maxIdleTime: "5 minutes", concurrency: 1 },
  ).pipe(Layer.withSpan("sheet-workflows.teamSubmissionsEntity"));
