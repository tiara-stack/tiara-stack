import { RoomOrdersCreate, RoomOrdersNavigate, RoomOrdersSend } from "sheet-workflow-contracts";

export const RoomOrderSheetWorkflowContracts = Object.freeze([
  RoomOrdersNavigate,
  RoomOrdersSend,
  RoomOrdersCreate,
] as const);

export const roomOrderSheetWorkflowDefinitionVersion = "1";
