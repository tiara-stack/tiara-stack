import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import {
  WorkspaceSheetWorkflowContracts,
  workspaceSheetWorkflowDefinitionVersion,
} from "./catalog";

export const WorkspaceSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze(
    WorkspaceSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(workspaceSheetWorkflowDefinitionVersion),
    ),
  );
