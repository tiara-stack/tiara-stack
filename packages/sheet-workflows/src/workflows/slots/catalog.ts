import { SlotsDeliverList, SlotsPublishButton } from "sheet-workflow-contracts";

export const SlotSheetWorkflowContracts = Object.freeze([
  SlotsPublishButton,
  SlotsDeliverList,
] as const);

export const slotSheetWorkflowDefinitionVersion = "1";
