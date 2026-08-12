import type { WorkflowInvocationStore } from "effect-zero-workflow";
import type { EnqueueSheetWorkflowContract, SheetWorkflowZeroContext } from "sheet-zero-server";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";
import { ConfigurationSheetWorkflowContracts } from "../configuration/catalog";
import { ConfigurationSheetWorkflowRegistrations } from "../configuration/registry";
import { PreferencesSheetWorkflowContracts } from "../preferences/catalog";
import { PreferencesSheetWorkflowRegistrations } from "../preferences/registry";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { ReadOnlySheetWorkflowContracts } from "../readOnly/catalog";
import { ReadOnlySheetWorkflowRegistrations } from "../readOnly/registry";
import { ScheduleSheetWorkflowContracts } from "../schedules/catalog";
import { ScheduleSheetWorkflowRegistrations } from "../schedules/registry";
import { SlotSheetWorkflowContracts } from "../slots/catalog";
import { SlotSheetWorkflowRegistrations } from "../slots/registry";
import {
  makeSheetWorkflowRegistrationValidationLayer,
  makeSheetWorkflowTransportHandler,
  makeSheetWorkflowZeroGroupsFor,
  type SheetWorkflowRegistration,
} from "../shared/registration";

export const SelectedSheetWorkflowContracts = Object.freeze([
  ...ReadOnlySheetWorkflowContracts,
  ...PreferencesSheetWorkflowContracts,
  ...ConfigurationSheetWorkflowContracts,
  ...SlotSheetWorkflowContracts,
  ...ScheduleSheetWorkflowContracts,
] as const);

export const SelectedSheetWorkflowRegistrations: ReadonlyArray<SheetWorkflowRegistration> =
  Object.freeze([
    ...ReadOnlySheetWorkflowRegistrations,
    ...PreferencesSheetWorkflowRegistrations,
    ...ConfigurationSheetWorkflowRegistrations,
    ...SlotSheetWorkflowRegistrations,
    ...ScheduleSheetWorkflowRegistrations,
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
