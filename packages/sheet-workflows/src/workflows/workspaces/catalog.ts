import {
  WorkspacesDeliverWelcome,
  WorkspacesFeatureFlagsSetAndDeliver,
} from "sheet-workflow-contracts";

export const WorkspaceSheetWorkflowContracts = Object.freeze([
  WorkspacesDeliverWelcome,
  WorkspacesFeatureFlagsSetAndDeliver,
] as const);

export const workspaceSheetWorkflowDefinitionVersion = "1";
