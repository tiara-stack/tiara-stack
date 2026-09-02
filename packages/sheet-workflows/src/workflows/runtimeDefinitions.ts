import type { WorkflowDefinition } from "effect-zero-workflow";
import { workflowContractKey } from "effect-zero-workflow/contract";
import { AnnouncementSheetWorkflows } from "./announcements";
import { CalculationSheetWorkflows } from "./calculations/definitions";
import { CheckinSheetWorkflows } from "./checkins";
import { ConfigurationSheetWorkflows } from "./configuration";
import { MemberSheetWorkflows } from "./members";
import { PreferencesSheetWorkflows } from "./preferences";
import { ReadOnlySheetWorkflows } from "./readOnly";
import { RoomOrderSheetWorkflows } from "./roomOrders/definitions";
import { ScheduleSheetWorkflows } from "./schedules";
import { ScreenshotSheetWorkflows } from "./screenshots";
import { ServiceSheetWorkflows } from "./services";
import { SheetConfigurationWorkflows } from "./sheetConfiguration";
import { SlotSheetWorkflows } from "./slots";
import { TeamSheetWorkflows } from "./teams";
import { TeamSubmissionsSheetWorkflows } from "./teamSubmissions";
import { WorkspaceSheetWorkflows } from "./workspaces";
import { SelectedSheetWorkflowRegistrations } from "./selected";

export const sheetWorkflowRuntimeDefinitions: ReadonlyArray<WorkflowDefinition> = Object.freeze([
  ...ReadOnlySheetWorkflows,
  ...SheetConfigurationWorkflows,
  ...PreferencesSheetWorkflows,
  ...ConfigurationSheetWorkflows,
  ...SlotSheetWorkflows,
  ...ScheduleSheetWorkflows,
  ...TeamSheetWorkflows,
  ...CheckinSheetWorkflows,
  ...TeamSubmissionsSheetWorkflows,
  ...RoomOrderSheetWorkflows,
  ...ServiceSheetWorkflows,
  ...WorkspaceSheetWorkflows,
  ...AnnouncementSheetWorkflows,
  ...MemberSheetWorkflows,
  ...ScreenshotSheetWorkflows,
  ...CalculationSheetWorkflows,
]);

const definitionVersionByWorkflowName = new Map(
  SelectedSheetWorkflowRegistrations.map(({ contract, definitionVersion }) => [
    workflowContractKey(contract),
    definitionVersion,
  ]),
);

export const sheetWorkflowRuntimeDefinitionVersion = (workflow: WorkflowDefinition): string =>
  definitionVersionByWorkflowName.get(workflow.name) ?? "1";
