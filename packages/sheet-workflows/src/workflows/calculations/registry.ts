import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import {
  calculationSheetWorkflowDefinitionVersion,
  CalculationSheetWorkflowContracts,
} from "./catalog";

export const CalculationSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze(
    CalculationSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(calculationSheetWorkflowDefinitionVersion),
    ),
  );
