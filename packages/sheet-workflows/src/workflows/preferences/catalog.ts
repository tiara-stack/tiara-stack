import { PreferencesDeliverStatus, PreferencesUpdateAndDeliver } from "sheet-workflow-contracts";

export const PreferencesSheetWorkflowContracts = Object.freeze([
  PreferencesDeliverStatus,
  PreferencesUpdateAndDeliver,
] as const);

export const preferencesSheetWorkflowDefinitionVersion = "1";
