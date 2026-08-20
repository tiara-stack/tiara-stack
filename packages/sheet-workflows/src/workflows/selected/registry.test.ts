import { describe, expect, it } from "@effect/vitest";
import { workflowContractZeroGroupIdentifier } from "effect-zero-workflow/contract/transport";
import { AnnouncementSheetWorkflowContracts } from "../announcements/catalog";
import { CalculationSheetWorkflowContracts } from "../calculations/catalog";
import { CheckinSheetWorkflowContracts } from "../checkins/catalog";
import { ConfigurationSheetWorkflowContracts } from "../configuration/catalog";
import { MemberSheetWorkflowContracts } from "../members/catalog";
import { PreferencesSheetWorkflowContracts } from "../preferences/catalog";
import { ReadOnlySheetWorkflowContracts } from "../readOnly/catalog";
import { RoomOrderSheetWorkflowContracts } from "../roomOrders/catalog";
import { ScheduleSheetWorkflowContracts } from "../schedules/catalog";
import { ScreenshotSheetWorkflowContracts } from "../screenshots/catalog";
import { ServiceSheetWorkflowContracts } from "../services/catalog";
import { SlotSheetWorkflowContracts } from "../slots/catalog";
import { TeamSheetWorkflowContracts } from "../teams/catalog";
import { TeamSubmissionsSheetWorkflowContracts } from "../teamSubmissions/catalog";
import { WorkspaceSheetWorkflowContracts } from "../workspaces/catalog";
import { assertRegistrationValidationFails } from "../shared/testHelpers";
import {
  makeSelectedSheetWorkflowZeroGroups,
  SelectedSheetWorkflowContracts,
  SelectedSheetWorkflowRegistrations,
} from "./registry";

describe("selected Sheet Workflow registry", () => {
  it("exposes one isolated Zero group per selected contract", () => {
    expect(SelectedSheetWorkflowContracts).toEqual([
      ...ReadOnlySheetWorkflowContracts,
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
    ]);
    expect(SelectedSheetWorkflowContracts).toHaveLength(35);
    const groups = makeSelectedSheetWorkflowZeroGroups(() => Promise.resolve());
    expect(groups).toHaveLength(SelectedSheetWorkflowContracts.length);
    expect(groups.flatMap(({ endpoints }) => Object.keys(endpoints))).toHaveLength(105);
    expect(groups.map(({ identifier }) => identifier)).toEqual(
      SelectedSheetWorkflowContracts.map(workflowContractZeroGroupIdentifier),
    );
    expect(groups.some(({ identifier }) => identifier === "workflows")).toBe(false);
  });

  it.effect("fails closed for missing and duplicate registrations", () =>
    assertRegistrationValidationFails(
      SelectedSheetWorkflowContracts,
      SelectedSheetWorkflowRegistrations,
    ),
  );
});
