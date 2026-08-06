import {
  mapWorkflowContractTree,
  type AnyWorkflowContract,
  type WorkflowClient,
} from "effect-zero-workflow/contract";
import {
  makeWorkflowZeroClient,
  workflowZeroProcedureManifest,
  type WorkflowZeroExecutor,
} from "effect-zero-workflow/contract/zero";
import type {
  WorkflowEnqueueError,
  WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import { SheetWorkflowContractCatalog, SheetWorkflowContracts } from "sheet-workflow-contracts";

type WorkflowClientTree<Node, Requirements> = Node extends AnyWorkflowContract
  ? WorkflowClient<Node, WorkflowEnqueueError, WorkflowObservationError, Requirements, Requirements>
  : { readonly [Key in keyof Node]: WorkflowClientTree<Node[Key], Requirements> };

export type SheetWorkflowZeroClients<Requirements = never> = WorkflowClientTree<
  typeof SheetWorkflowContracts,
  Requirements
>;

export const makeSheetWorkflowZeroClients = <Requirements = never>(
  executor: WorkflowZeroExecutor<Requirements>,
): SheetWorkflowZeroClients<Requirements> =>
  mapWorkflowContractTree(SheetWorkflowContracts, (contract) =>
    makeWorkflowZeroClient(contract, executor),
  ) as SheetWorkflowZeroClients<Requirements>;

export const sheetWorkflowZeroProcedureManifest = workflowZeroProcedureManifest(
  SheetWorkflowContractCatalog,
);
