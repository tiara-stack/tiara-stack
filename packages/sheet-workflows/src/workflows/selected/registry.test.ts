import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { workflowContractZeroGroupIdentifier } from "effect-zero-workflow/contract/transport";
import { AnnouncementSheetWorkflowContracts } from "../announcements/catalog";
import { CalculationSheetWorkflowContracts } from "../calculations/catalog";
import { CheckinSheetWorkflowContracts } from "../checkins/catalog";
import { ConfigurationSheetWorkflowContracts } from "../configuration/catalog";
import { MemberSheetWorkflowContracts } from "../members/catalog";
import { PreferencesSheetWorkflowContracts } from "../preferences/catalog";
import { ReadOnlySheetWorkflowContracts } from "../readOnly/catalog";
import { SheetConfigurationWorkflowContracts } from "../sheetConfiguration/catalog";
import { RoomOrderSheetWorkflowContracts } from "../roomOrders/catalog";
import { ScheduleSheetWorkflowContracts } from "../schedules/catalog";
import { ScreenshotSheetWorkflowContracts } from "../screenshots/catalog";
import { ServiceSheetWorkflowContracts } from "../services/catalog";
import { SlotSheetWorkflowContracts } from "../slots/catalog";
import { TeamSheetWorkflowContracts } from "../teams/catalog";
import { TeamSubmissionsSheetWorkflowContracts } from "../teamSubmissions/catalog";
import { WorkspaceSheetWorkflowContracts } from "../workspaces/catalog";
import { assertRegistrationValidationFails } from "../shared/testHelpers";
import { sheetWorkflowRuntimeDefinitions } from "../runtimeDefinitions";
import {
  sheetWorkflowCatalogDigestFor,
  sheetWorkflowContractCatalogDigest,
  selectedSheetWorkflowActionVersions,
  selectedSheetWorkflowDurableFormatVersions,
} from "../catalogIdentity";
import {
  makeSelectedSheetWorkflowZeroGroups,
  SelectedSheetWorkflowContracts,
  SelectedSheetWorkflowRegistrations,
} from "./registry";

describe("selected Sheet Workflow registry", () => {
  it("exposes one isolated Zero group per selected contract", () => {
    expect(SelectedSheetWorkflowContracts).toEqual([
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
    ]);
    expect(SelectedSheetWorkflowContracts).toHaveLength(51);
    const groups = makeSelectedSheetWorkflowZeroGroups(() => Promise.resolve());
    expect(groups).toHaveLength(SelectedSheetWorkflowContracts.length);
    expect(groups.flatMap(({ endpoints }) => Object.keys(endpoints))).toHaveLength(153);
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

  it("binds the compatibility digest to schemas and Action Versions", () => {
    const first = SelectedSheetWorkflowRegistrations[0]!;
    const changedVersion = SelectedSheetWorkflowRegistrations.map((registration) =>
      registration === first
        ? { ...registration, definitionVersion: `${registration.definitionVersion}-changed` }
        : registration,
    );
    const changedSchema = SelectedSheetWorkflowRegistrations.map((registration) =>
      registration === first
        ? {
            ...registration,
            contract: {
              ...registration.contract,
              input: Schema.Struct({ compatibilityRevision: Schema.String }),
            },
          }
        : registration,
    );
    const changedActionVersion = selectedSheetWorkflowActionVersions.map((entry, index) =>
      index === 0 ? { ...entry, version: `${entry.version}-changed` } : entry,
    );
    const changedDurableFormatVersion = selectedSheetWorkflowDurableFormatVersions.map(
      (entry, index) => (index === 0 ? { ...entry, version: `${entry.version}-changed` } : entry),
    );
    const changedRuntimeDefinitionSet = sheetWorkflowRuntimeDefinitions.slice(1);

    expect(sheetWorkflowCatalogDigestFor(SelectedSheetWorkflowRegistrations)).toBe(
      sheetWorkflowContractCatalogDigest,
    );
    expect(
      sheetWorkflowCatalogDigestFor(
        SelectedSheetWorkflowRegistrations,
        selectedSheetWorkflowActionVersions,
        selectedSheetWorkflowDurableFormatVersions,
        sheetWorkflowRuntimeDefinitions,
      ),
    ).toBe(sheetWorkflowContractCatalogDigest);
    expect(sheetWorkflowCatalogDigestFor(changedVersion)).not.toBe(
      sheetWorkflowContractCatalogDigest,
    );
    expect(sheetWorkflowCatalogDigestFor(changedSchema)).not.toBe(
      sheetWorkflowContractCatalogDigest,
    );
    expect(
      sheetWorkflowCatalogDigestFor(SelectedSheetWorkflowRegistrations, changedActionVersion),
    ).not.toBe(sheetWorkflowContractCatalogDigest);
    expect(
      sheetWorkflowCatalogDigestFor(
        SelectedSheetWorkflowRegistrations,
        selectedSheetWorkflowActionVersions,
        changedDurableFormatVersion,
      ),
    ).not.toBe(sheetWorkflowContractCatalogDigest);
    expect(
      sheetWorkflowCatalogDigestFor(
        SelectedSheetWorkflowRegistrations,
        selectedSheetWorkflowActionVersions,
        selectedSheetWorkflowDurableFormatVersions,
        changedRuntimeDefinitionSet,
      ),
    ).not.toBe(sheetWorkflowContractCatalogDigest);
  });
});
