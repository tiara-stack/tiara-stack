import { describe, expect, it } from "@effect/vitest";
import { workflowContractZeroGroupIdentifier } from "effect-zero-workflow/contract/transport";
import { CheckinSheetWorkflowContracts } from "../checkins/catalog";
import { ConfigurationSheetWorkflowContracts } from "../configuration/catalog";
import { PreferencesSheetWorkflowContracts } from "../preferences/catalog";
import { ReadOnlySheetWorkflowContracts } from "../readOnly/catalog";
import { RoomOrderSheetWorkflowContracts } from "../roomOrders/catalog";
import { ScheduleSheetWorkflowContracts } from "../schedules/catalog";
import { SlotSheetWorkflowContracts } from "../slots/catalog";
import { TeamSheetWorkflowContracts } from "../teams/catalog";
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
      ...RoomOrderSheetWorkflowContracts,
    ]);
    expect(SelectedSheetWorkflowContracts).toHaveLength(24);
    const groups = makeSelectedSheetWorkflowZeroGroups(() => Promise.resolve());
    expect(groups).toHaveLength(SelectedSheetWorkflowContracts.length);
    expect(groups.flatMap(({ endpoints }) => Object.keys(endpoints))).toHaveLength(72);
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
