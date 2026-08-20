import { TeamSubmissionsDecide, TeamSubmissionsProcess } from "sheet-workflow-contracts";
import { workflowContractExecutionSchema } from "../shared/execution";

export const TeamSubmissionsProcessExecution =
  workflowContractExecutionSchema(TeamSubmissionsProcess);
export const TeamSubmissionsDecideExecution =
  workflowContractExecutionSchema(TeamSubmissionsDecide);
