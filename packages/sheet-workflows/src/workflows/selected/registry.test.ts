import { describe, expect, it } from "@effect/vitest";
import { workflowContractZeroGroupIdentifier } from "effect-zero-workflow/contract/transport";
import { ConfigurationSheetWorkflowContracts } from "../configuration/catalog";
import { PreferencesSheetWorkflowContracts } from "../preferences/catalog";
import { ReadOnlySheetWorkflowContracts } from "../readOnly/catalog";
import { SlotSheetWorkflowContracts } from "../slots/catalog";
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
    ]);
    expect(SelectedSheetWorkflowContracts).toHaveLength(16);
    const groups = makeSelectedSheetWorkflowZeroGroups(() => Promise.resolve());
    expect(groups).toHaveLength(SelectedSheetWorkflowContracts.length);
    expect(groups.flatMap(({ endpoints }) => Object.keys(endpoints))).toHaveLength(48);
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
