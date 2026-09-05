import {
  SlotsDeliverList,
  SlotsOpen,
  SlotsPublishButton,
  SlotsRefreshButton,
} from "sheet-workflow-contracts";

export const SlotSheetWorkflowContracts = Object.freeze([
  SlotsPublishButton,
  SlotsRefreshButton,
  SlotsDeliverList,
  SlotsOpen,
] as const);

export const slotSheetWorkflowDefinitionVersion = "5";
