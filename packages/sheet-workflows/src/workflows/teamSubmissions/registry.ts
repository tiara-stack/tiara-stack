import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import {
  TeamSubmissionsSheetWorkflowContracts,
  teamSubmissionsSheetWorkflowDefinitionVersion,
} from "./catalog";

export type TeamSubmissionsWorkflowRegistration = SheetWorkflowRegistration;

export const TeamSubmissionsSheetWorkflowRegistrations: ReadonlyArray<TeamSubmissionsWorkflowRegistration> =
  Object.freeze(
    TeamSubmissionsSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(teamSubmissionsSheetWorkflowDefinitionVersion),
    ),
  );
