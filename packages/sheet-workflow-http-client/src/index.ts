import type { HttpClient } from "effect/unstable/http";
import {
  mapWorkflowContractTree,
  type AnyWorkflowContract,
  type WorkflowClient,
} from "effect-zero-workflow/contract";
import { makeWorkflowHttpClient } from "effect-zero-workflow/contract/http";
import type {
  WorkflowEnqueueError,
  WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import { SheetWorkflowContracts } from "sheet-workflow-contracts";
import type { SheetWorkflowHttpClientOptions } from "./options";

type WorkflowHttpClientTree<Node> = Node extends AnyWorkflowContract
  ? WorkflowClient<Node, WorkflowEnqueueError, WorkflowObservationError>
  : { readonly [Key in keyof Node]: WorkflowHttpClientTree<Node[Key]> };

export type SheetWorkflowHttpClients = WorkflowHttpClientTree<typeof SheetWorkflowContracts>;

export const makeSheetWorkflowHttpClients = (
  httpClient: HttpClient.HttpClient,
  options: SheetWorkflowHttpClientOptions,
): SheetWorkflowHttpClients =>
  mapWorkflowContractTree(SheetWorkflowContracts, (contract) =>
    makeWorkflowHttpClient(contract, httpClient, options),
  ) as SheetWorkflowHttpClients;

export type { SheetWorkflowHttpClientOptions } from "./options";
export { sheetWorkflowHttpRouteManifest } from "./routes";
