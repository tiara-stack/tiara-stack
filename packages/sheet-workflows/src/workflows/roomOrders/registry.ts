import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import {
  RoomOrderSheetWorkflowContracts,
  roomOrderSheetWorkflowDefinitionVersion,
} from "./catalog";

export const RoomOrderSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze(
    RoomOrderSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(roomOrderSheetWorkflowDefinitionVersion),
    ),
  );
