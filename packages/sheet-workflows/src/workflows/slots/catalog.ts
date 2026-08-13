import { SlotsDeliverList, SlotsOpen, SlotsPublishButton } from "sheet-workflow-contracts";

export const SlotSheetWorkflowContracts = Object.freeze([
  SlotsPublishButton,
  SlotsDeliverList,
  SlotsOpen,
] as const);

export const slotSheetWorkflowDefinitionVersion = "1";
