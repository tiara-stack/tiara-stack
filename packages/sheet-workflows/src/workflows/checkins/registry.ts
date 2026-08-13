import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import { CheckinSheetWorkflowContracts, checkinSheetWorkflowDefinitionVersion } from "./catalog";

export type CheckinWorkflowRegistration = SheetWorkflowRegistration;

export const CheckinSheetWorkflowRegistrations: ReadonlyArray<CheckinWorkflowRegistration> =
  Object.freeze(
    CheckinSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(checkinSheetWorkflowDefinitionVersion),
    ),
  );
