import type { WorkflowInvocationStore } from "effect-zero-workflow";
import type { EnqueueSheetWorkflowContract, SheetWorkflowZeroContext } from "sheet-zero-server";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";
import { ReadOnlyWorkflowAuthorization } from "../readOnly/authorization";
import { ReadOnlySheetWorkflowContracts, ReadOnlySheetWorkflowRegistrations } from "../readOnly";
import {
  makeSheetWorkflowRegistration,
  makeSheetWorkflowRegistrationValidationLayer,
  makeSheetWorkflowTransportHandler,
  makeSheetWorkflowZeroGroupsFor,
  type SheetWorkflowRegistration,
} from "../shared/registration";
import {
  PreferencesSheetWorkflowContracts,
  preferencesSheetWorkflowDefinitionVersion,
} from "./catalog";

export type PreferencesWorkflowRegistration = SheetWorkflowRegistration;

export const PreferencesSheetWorkflowRegistrations: ReadonlyArray<PreferencesWorkflowRegistration> =
  Object.freeze(
    PreferencesSheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(preferencesSheetWorkflowDefinitionVersion),
    ),
  );

export const SelectedSheetWorkflowContracts = Object.freeze([
  ...ReadOnlySheetWorkflowContracts,
  ...PreferencesSheetWorkflowContracts,
] as const);

export const SelectedSheetWorkflowRegistrations: ReadonlyArray<PreferencesWorkflowRegistration> =
  Object.freeze([...ReadOnlySheetWorkflowRegistrations, ...PreferencesSheetWorkflowRegistrations]);

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
