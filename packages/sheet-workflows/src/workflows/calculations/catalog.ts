import { CalculationsRecalculateSheet } from "sheet-workflow-contracts";

export const CalculationSheetWorkflowContracts = Object.freeze([
  CalculationsRecalculateSheet,
] as const);

export const calculationSheetWorkflowDefinitionVersion = "1";
export const calculationActionVersion = "1";
// Changing this value splits the entity serialization domain. Only change it as part of a
// drain-and-switch deployment so mixed versions cannot write the same projection concurrently.
export const calculationSerializationVersion = "1";
