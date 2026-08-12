import type { SheetWorkflowRegistration } from "../shared/registration";
import { makeSheetWorkflowRegistration } from "../shared/registration";
import { ScheduleSheetWorkflowContracts, scheduleSheetWorkflowDefinitionVersion } from "./catalog";

export type ScheduleWorkflowRegistration = SheetWorkflowRegistration;

export const ScheduleSheetWorkflowRegistrations: ReadonlyArray<ScheduleWorkflowRegistration> =
  Object.freeze(
    ScheduleSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(scheduleSheetWorkflowDefinitionVersion),
    ),
  );
