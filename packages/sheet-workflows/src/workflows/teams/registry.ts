import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import { TeamSheetWorkflowContracts, teamSheetWorkflowDefinitionVersion } from "./catalog";

export type TeamWorkflowRegistration = SheetWorkflowRegistration;

export const TeamSheetWorkflowRegistrations: ReadonlyArray<TeamWorkflowRegistration> =
  Object.freeze(
    TeamSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(teamSheetWorkflowDefinitionVersion),
    ),
  );
