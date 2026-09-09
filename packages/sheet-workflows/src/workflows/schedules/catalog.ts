import {
  SchedulesDeliverChannelFillers,
  SchedulesDeliverUserSchedule,
} from "sheet-workflow-contracts";

export const ScheduleSheetWorkflowContracts = Object.freeze([
  SchedulesDeliverUserSchedule,
  SchedulesDeliverChannelFillers,
] as const);

export const scheduleSheetWorkflowDefinitionVersion = "2";
