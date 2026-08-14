import {
  RoomOrdersCreate,
  RoomOrdersNavigate,
  RoomOrdersPinTentative,
  RoomOrdersSend,
} from "sheet-workflow-contracts";

export const RoomOrderSheetWorkflowContracts = Object.freeze([
  RoomOrdersNavigate,
  RoomOrdersSend,
  RoomOrdersCreate,
  RoomOrdersPinTentative,
] as const);

export const roomOrderSheetWorkflowDefinitionVersion = "1";
