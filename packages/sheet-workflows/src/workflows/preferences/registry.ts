import {
  makeSheetWorkflowRegistration,
  type SheetWorkflowRegistration,
} from "../shared/registration";
import {
  PreferencesSheetWorkflowContracts,
  preferencesSheetWorkflowDefinitionVersion,
} from "./catalog";

export type PreferencesWorkflowRegistration = SheetWorkflowRegistration;

export const PreferencesSheetWorkflowRegistrations: ReadonlyArray<PreferencesWorkflowRegistration> =
  Object.freeze(
    PreferencesSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(preferencesSheetWorkflowDefinitionVersion),
    ),
  );
