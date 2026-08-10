import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import {
  ConfigurationSheetWorkflowContracts,
  configurationSheetWorkflowDefinitionVersion,
} from "./catalog";

export type ConfigurationWorkflowRegistration = SheetWorkflowRegistration;

export const ConfigurationSheetWorkflowRegistrations: ReadonlyArray<ConfigurationWorkflowRegistration> =
  Object.freeze(
    ConfigurationSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(configurationSheetWorkflowDefinitionVersion),
    ),
  );
