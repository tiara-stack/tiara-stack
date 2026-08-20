import { TeamSubmissionsDecide, TeamSubmissionsProcess } from "sheet-workflow-contracts";

export const TeamSubmissionsSheetWorkflowContracts = Object.freeze([
  TeamSubmissionsProcess,
  TeamSubmissionsDecide,
] as const);

export const teamSubmissionsSheetWorkflowDefinitionVersion = "1";
export const teamSubmissionsSheetWorkflowActionVersion = "1";
