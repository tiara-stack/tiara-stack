import { Context, type Effect } from "effect";
import {
  AutonomousDeclaredFailure,
  InteractiveDeclaredFailure,
  TeamSubmissionsDecide,
  TeamSubmissionsProcess,
} from "sheet-workflow-contracts";
import type { TeamSubmissionsDecideExecution, TeamSubmissionsProcessExecution } from "./schema";

interface TeamSubmissionsWorkflowOperationsShape {
  readonly process: (
    execution: typeof TeamSubmissionsProcessExecution.Type,
  ) => Effect.Effect<
    typeof TeamSubmissionsProcess.success.Type,
    typeof AutonomousDeclaredFailure.Type
  >;
  readonly decide: (
    execution: typeof TeamSubmissionsDecideExecution.Type,
  ) => Effect.Effect<
    typeof TeamSubmissionsDecide.success.Type,
    typeof InteractiveDeclaredFailure.Type
  >;
}

export class TeamSubmissionsWorkflowOperations extends Context.Service<
  TeamSubmissionsWorkflowOperations,
  TeamSubmissionsWorkflowOperationsShape
>()("sheet-workflows/TeamSubmissionsWorkflowOperations") {}
