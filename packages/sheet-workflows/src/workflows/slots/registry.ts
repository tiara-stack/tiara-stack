import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import { SlotSheetWorkflowContracts, slotSheetWorkflowDefinitionVersion } from "./catalog";

export type SlotWorkflowRegistration = SheetWorkflowRegistration;

export const SlotSheetWorkflowRegistrations: ReadonlyArray<SlotWorkflowRegistration> =
  Object.freeze(
    SlotSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(slotSheetWorkflowDefinitionVersion),
    ),
  );
