import {
  SlotsDeliverList,
  SlotsOpen,
  SlotsPublishButton,
  SlotsRefreshButton,
  SlotsRemoveButton,
} from "sheet-workflow-contracts";

export const SlotSheetWorkflowContracts = Object.freeze([
  SlotsPublishButton,
  SlotsRefreshButton,
  SlotsDeliverList,
  SlotsOpen,
  SlotsRemoveButton,
] as const);

export const slotSheetWorkflowDefinitionVersion = "5";
