import { CheckinsRespond, CheckinsTestAuto } from "sheet-workflow-contracts";

export const CheckinSheetWorkflowContracts = Object.freeze([
  CheckinsRespond,
  CheckinsTestAuto,
] as const);

export const checkinSheetWorkflowDefinitionVersion = "1";
export const autoCheckinTestWorkflowDefinitionVersion = "1";
export const autoCheckinTestActionVersion = "1";
