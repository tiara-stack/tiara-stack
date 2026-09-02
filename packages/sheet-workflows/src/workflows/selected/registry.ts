import type { WorkflowInvocationStore } from "effect-zero-workflow";
import type { EnqueueSheetWorkflowContract, SheetWorkflowZeroContext } from "sheet-zero-server";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";
import { AnnouncementSheetWorkflowContracts } from "../announcements/catalog";
import { AnnouncementSheetWorkflowRegistrations } from "../announcements/registry";
import { CalculationSheetWorkflowContracts } from "../calculations/catalog";
import { CalculationSheetWorkflowRegistrations } from "../calculations/registry";
import { CheckinSheetWorkflowContracts } from "../checkins/catalog";
import { CheckinSheetWorkflowRegistrations } from "../checkins/registry";
import { ConfigurationSheetWorkflowContracts } from "../configuration/catalog";
import { ConfigurationSheetWorkflowRegistrations } from "../configuration/registry";
import { MemberSheetWorkflowContracts } from "../members/catalog";
import { MemberSheetWorkflowRegistrations } from "../members/registry";
import { PreferencesSheetWorkflowContracts } from "../preferences/catalog";
import { PreferencesSheetWorkflowRegistrations } from "../preferences/registry";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { ReadOnlySheetWorkflowContracts } from "../readOnly/catalog";
import { ReadOnlySheetWorkflowRegistrations } from "../readOnly/registry";
import { SheetConfigurationWorkflowRegistrations } from "../sheetConfiguration/registry";
import { SheetConfigurationWorkflowContracts } from "../sheetConfiguration/catalog";
import { RoomOrderSheetWorkflowContracts } from "../roomOrders/catalog";
import { RoomOrderSheetWorkflowRegistrations } from "../roomOrders/registry";
import { ScheduleSheetWorkflowContracts } from "../schedules/catalog";
import { ScheduleSheetWorkflowRegistrations } from "../schedules/registry";
import { ScreenshotSheetWorkflowContracts } from "../screenshots/catalog";
import { ScreenshotSheetWorkflowRegistrations } from "../screenshots/registry";
import { ServiceSheetWorkflowContracts } from "../services/catalog";
import { ServiceSheetWorkflowRegistrations } from "../services/registry";
import { SlotSheetWorkflowContracts } from "../slots/catalog";
import { SlotSheetWorkflowRegistrations } from "../slots/registry";
import { TeamSheetWorkflowContracts } from "../teams/catalog";
import { TeamSheetWorkflowRegistrations } from "../teams/registry";
import { TeamSubmissionsSheetWorkflowContracts } from "../teamSubmissions/catalog";
import { TeamSubmissionsSheetWorkflowRegistrations } from "../teamSubmissions/registry";
import { WorkspaceSheetWorkflowContracts } from "../workspaces/catalog";
import { WorkspaceSheetWorkflowRegistrations } from "../workspaces/registry";
import {
  makeSheetWorkflowRegistrationValidationLayer,
  makeSheetWorkflowTransportHandler,
  makeSheetWorkflowZeroGroupsFor,
  type SheetWorkflowRegistration,
} from "../shared/registration";

export const SelectedSheetWorkflowContracts = Object.freeze([
  ...ReadOnlySheetWorkflowContracts,
  ...SheetConfigurationWorkflowContracts,
  ...PreferencesSheetWorkflowContracts,
  ...ConfigurationSheetWorkflowContracts,
  ...SlotSheetWorkflowContracts,
  ...ScheduleSheetWorkflowContracts,
  ...TeamSheetWorkflowContracts,
  ...CheckinSheetWorkflowContracts,
  ...TeamSubmissionsSheetWorkflowContracts,
  ...RoomOrderSheetWorkflowContracts,
  ...ServiceSheetWorkflowContracts,
  ...WorkspaceSheetWorkflowContracts,
  ...AnnouncementSheetWorkflowContracts,
  ...MemberSheetWorkflowContracts,
  ...ScreenshotSheetWorkflowContracts,
  ...CalculationSheetWorkflowContracts,
] as const);

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
