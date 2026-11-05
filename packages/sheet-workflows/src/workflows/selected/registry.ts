import type { WorkflowInvocationStore } from "effect-zero-workflow";
import type { EnqueueSheetWorkflowContract, SheetWorkflowZeroContext } from "sheet-zero-server";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";
import { AnnouncementSheetWorkflowRegistrations } from "../announcements/registry";
import { CalculationSheetWorkflowRegistrations } from "../calculations/registry";
import { CheckinSheetWorkflowRegistrations } from "../checkins/registry";
import { ConfigurationSheetWorkflowRegistrations } from "../configuration/registry";
import { MemberSheetWorkflowRegistrations } from "../members/registry";
import { PreferencesSheetWorkflowRegistrations } from "../preferences/registry";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { ReadOnlySheetWorkflowRegistrations } from "../readOnly/registry";
import { SheetConfigurationWorkflowRegistrations } from "../sheetConfiguration/registry";
import { RoomOrderSheetWorkflowRegistrations } from "../roomOrders/registry";
import { ScheduleSheetWorkflowRegistrations } from "../schedules/registry";
import { ScreenshotSheetWorkflowRegistrations } from "../screenshots/registry";
import { ServiceSheetWorkflowRegistrations } from "../services/registry";
import { SlotSheetWorkflowRegistrations } from "../slots/registry";
import { TeamSheetWorkflowRegistrations } from "../teams/registry";
import { TeamSubmissionsSheetWorkflowRegistrations } from "../teamSubmissions/registry";
import { WorkspaceSheetWorkflowRegistrations } from "../workspaces/registry";
import { SelectedSheetWorkflowContracts } from "./identity";
export { SelectedSheetWorkflowContracts } from "./identity";
import {
  makeSheetWorkflowRegistrationValidationLayer,
  makeSheetWorkflowTransportHandler,
  makeSheetWorkflowZeroGroupsFor,
  type SheetWorkflowRegistration,
} from "../shared/registration";

export const SelectedSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze([
    ...ReadOnlySheetWorkflowRegistrations,
    ...SheetConfigurationWorkflowRegistrations,
    ...PreferencesSheetWorkflowRegistrations,
    ...ConfigurationSheetWorkflowRegistrations,
    ...SlotSheetWorkflowRegistrations,
    ...ScheduleSheetWorkflowRegistrations,
    ...TeamSheetWorkflowRegistrations,
    ...CheckinSheetWorkflowRegistrations,
    ...TeamSubmissionsSheetWorkflowRegistrations,
    ...RoomOrderSheetWorkflowRegistrations,
    ...ServiceSheetWorkflowRegistrations,
    ...WorkspaceSheetWorkflowRegistrations,
    ...AnnouncementSheetWorkflowRegistrations,
    ...MemberSheetWorkflowRegistrations,
    ...ScreenshotSheetWorkflowRegistrations,
    ...CalculationSheetWorkflowRegistrations,
  ]);

export const selectedSheetWorkflowRegistrationValidationLayer =
  makeSheetWorkflowRegistrationValidationLayer(
    SelectedSheetWorkflowContracts,
    SelectedSheetWorkflowRegistrations,
  );

export const makeSelectedWorkflowTransportHandler = (
  store: WorkflowInvocationStore<
    SheetWorkflowZeroContext["principal"],
    ReadOnlyWorkflowAuthorization,
    NonNullable<SheetWorkflowZeroContext["actorProvenance"]>
  >,
) =>
  makeSheetWorkflowTransportHandler(
    SelectedSheetWorkflowContracts,
    SelectedSheetWorkflowRegistrations,
    store,
  );

export const makeSelectedSheetWorkflowZeroGroups = (
  enqueue: EnqueueSheetWorkflowContract,
  workflowRun?: Parameters<typeof makeSheetWorkflowZeroGroupsFor>[2],
): ReadonlyArray<ZeroApiGroup.Any> =>
  makeSheetWorkflowZeroGroupsFor(SelectedSheetWorkflowContracts, enqueue, workflowRun);
