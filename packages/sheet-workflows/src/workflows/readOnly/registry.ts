import type { WorkflowInvocationStore } from "effect-zero-workflow";
import type { SheetWorkflowZeroContext } from "sheet-zero-server";
import type { EnqueueSheetWorkflowContract } from "sheet-zero-server";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";
import {
  makeSheetWorkflowRegistration,
  makeSheetWorkflowTransportHandler,
  makeSheetWorkflowZeroEnqueue,
  makeSheetWorkflowZeroGroupsFor,
  type SheetWorkflowRegistration,
} from "../shared/registration";
import { ReadOnlyWorkflowAuthorization } from "./authorization";
import { ReadOnlySheetWorkflowContracts, readOnlySheetWorkflowDefinitionVersion } from "./catalog";

export type ReadOnlyWorkflowRegistration = SheetWorkflowRegistration;

export const ReadOnlySheetWorkflowRegistrations: ReadonlyArray<ReadOnlyWorkflowRegistration> =
  Object.freeze(
    ReadOnlySheetWorkflowContracts.map(
      makeSheetWorkflowRegistration(readOnlySheetWorkflowDefinitionVersion),
    ),
  );

export const makeReadOnlyWorkflowTransportHandler = (
  store: WorkflowInvocationStore<
    SheetWorkflowZeroContext["principal"],
    ReadOnlyWorkflowAuthorization,
    NonNullable<SheetWorkflowZeroContext["actorProvenance"]>
  >,
) =>
  makeSheetWorkflowTransportHandler(
    ReadOnlySheetWorkflowContracts,
    ReadOnlySheetWorkflowRegistrations,
    store,
  );

export const makeReadOnlySheetWorkflowZeroEnqueue = makeSheetWorkflowZeroEnqueue(
  ReadOnlySheetWorkflowContracts,
  ReadOnlySheetWorkflowRegistrations,
);

export const makeReadOnlySheetWorkflowZeroGroups = (
  enqueue: EnqueueSheetWorkflowContract,
  workflowRun?: Parameters<typeof makeSheetWorkflowZeroGroupsFor>[2],
): ReadonlyArray<ZeroApiGroup.Any> =>
  makeSheetWorkflowZeroGroupsFor(ReadOnlySheetWorkflowContracts, enqueue, workflowRun);
