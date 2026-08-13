import { RoomOrdersNavigate, RoomOrdersSend } from "sheet-workflow-contracts";

export const RoomOrderSheetWorkflowContracts = Object.freeze([
  RoomOrdersNavigate,
  RoomOrdersSend,
] as const);

export const roomOrderSheetWorkflowDefinitionVersion = "1";
