import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import { ServiceSheetWorkflowContracts, serviceSheetWorkflowDefinitionVersion } from "./catalog";

export const ServiceSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze(
    ServiceSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(serviceSheetWorkflowDefinitionVersion),
    ),
  );
