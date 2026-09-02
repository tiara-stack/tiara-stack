import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import {
  SheetConfigurationWorkflowContracts,
  sheetConfigurationWorkflowDefinitionVersion,
} from "./catalog";

export type SheetConfigurationWorkflowRegistration = SheetWorkflowRegistration;

export const SheetConfigurationWorkflowRegistrations: ReadonlyArray<SheetConfigurationWorkflowRegistration> =
  Object.freeze(
    SheetConfigurationWorkflowContracts.map(
      makeSheetWorkflowRegistration(sheetConfigurationWorkflowDefinitionVersion),
    ),
  );
