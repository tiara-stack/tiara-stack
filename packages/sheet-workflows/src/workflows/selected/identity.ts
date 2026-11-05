import { workflowContractKey, type AnyWorkflowContract } from "effect-zero-workflow/contract";
import {
  AnnouncementSheetWorkflowContracts,
  announcementSheetWorkflowDefinitionVersion,
} from "../announcements/catalog";
import {
  CalculationSheetWorkflowContracts,
  calculationSheetWorkflowDefinitionVersion,
} from "../calculations/catalog";
import {
  CheckinSheetWorkflowContracts,
  checkinSheetWorkflowDefinitionVersion,
} from "../checkins/catalog";
import {
  ConfigurationSheetWorkflowContracts,
  configurationSheetWorkflowDefinitionVersion,
} from "../configuration/catalog";
import {
  MemberSheetWorkflowContracts,
  memberSheetWorkflowDefinitionVersion,
} from "../members/catalog";
import {
  PreferencesSheetWorkflowContracts,
  preferencesSheetWorkflowDefinitionVersion,
} from "../preferences/catalog";
import {
  ReadOnlySheetWorkflowContracts,
  readOnlySheetWorkflowDefinitionVersion,
} from "../readOnly/catalog";
import {
  RoomOrderSheetWorkflowContracts,
  roomOrderSheetWorkflowDefinitionVersion,
} from "../roomOrders/catalog";
import {
  ScheduleSheetWorkflowContracts,
  scheduleSheetWorkflowDefinitionVersion,
} from "../schedules/catalog";
import {
  ScreenshotSheetWorkflowContracts,
  screenshotWorkflowDefinitionVersion,
} from "../screenshots/catalog";
import {
  ServiceSheetWorkflowContracts,
  serviceSheetWorkflowDefinitionVersion,
} from "../services/catalog";
import {
  SheetConfigurationWorkflowContracts,
  sheetConfigurationWorkflowDefinitionVersion,
} from "../sheetConfiguration/catalog";
import { SlotSheetWorkflowContracts, slotSheetWorkflowDefinitionVersion } from "../slots/catalog";
import { TeamSheetWorkflowContracts, teamSheetWorkflowDefinitionVersion } from "../teams/catalog";
import {
  TeamSubmissionsSheetWorkflowContracts,
  teamSubmissionsSheetWorkflowDefinitionVersion,
} from "../teamSubmissions/catalog";
import {
  WorkspaceSheetWorkflowContracts,
  workspaceSheetWorkflowDefinitionVersion,
} from "../workspaces/catalog";

export type SelectedSheetWorkflowRegistrationIdentity = {
  readonly contract: AnyWorkflowContract;
  readonly definitionVersion: string;
};

const identifyRegistrations = (
  contracts: ReadonlyArray<AnyWorkflowContract>,
  definitionVersion: string,
): ReadonlyArray<SelectedSheetWorkflowRegistrationIdentity> =>
  contracts.map((contract) => ({ contract, definitionVersion }));

export const selectedSheetWorkflowIdentityRegistrations: ReadonlyArray<SelectedSheetWorkflowRegistrationIdentity> =
  Object.freeze([
    ...identifyRegistrations(
      ReadOnlySheetWorkflowContracts,
      readOnlySheetWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(
      SheetConfigurationWorkflowContracts,
      sheetConfigurationWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(
      PreferencesSheetWorkflowContracts,
      preferencesSheetWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(
      ConfigurationSheetWorkflowContracts,
      configurationSheetWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(SlotSheetWorkflowContracts, slotSheetWorkflowDefinitionVersion),
    ...identifyRegistrations(
      ScheduleSheetWorkflowContracts,
      scheduleSheetWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(TeamSheetWorkflowContracts, teamSheetWorkflowDefinitionVersion),
    ...identifyRegistrations(CheckinSheetWorkflowContracts, checkinSheetWorkflowDefinitionVersion),
    ...identifyRegistrations(
      TeamSubmissionsSheetWorkflowContracts,
      teamSubmissionsSheetWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(
      RoomOrderSheetWorkflowContracts,
      roomOrderSheetWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(ServiceSheetWorkflowContracts, serviceSheetWorkflowDefinitionVersion),
    ...identifyRegistrations(
      WorkspaceSheetWorkflowContracts,
      workspaceSheetWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(
      AnnouncementSheetWorkflowContracts,
      announcementSheetWorkflowDefinitionVersion,
    ),
    ...identifyRegistrations(MemberSheetWorkflowContracts, memberSheetWorkflowDefinitionVersion),
    ...identifyRegistrations(ScreenshotSheetWorkflowContracts, screenshotWorkflowDefinitionVersion),
    ...identifyRegistrations(
      CalculationSheetWorkflowContracts,
      calculationSheetWorkflowDefinitionVersion,
    ),
  ]);

export const SelectedSheetWorkflowContracts: ReadonlyArray<AnyWorkflowContract> = Object.freeze(
  selectedSheetWorkflowIdentityRegistrations.map(({ contract }) => contract),
);

/** Definition identities expected from the selected runtime, without loading handler modules. */
export const selectedSheetWorkflowRuntimeDefinitionIdentities = Object.freeze(
  selectedSheetWorkflowIdentityRegistrations.map(({ contract, definitionVersion }) => ({
    name: workflowContractKey(contract),
    definitionVersion,
  })),
);
