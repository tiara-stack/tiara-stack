import type { HttpClient } from "effect/unstable/http";
import {
  type InvocationId,
  mapWorkflowContractTree,
  type AnyWorkflowContract,
  type WorkflowClient,
  type WorkflowContractInput,
} from "effect-zero-workflow/contract";
import { makeWorkflowHttpEnqueueClient } from "effect-zero-workflow/contract/http";
import type { WorkflowEnqueueError } from "effect-zero-workflow/contract/transport";
import { SheetWorkflowContracts } from "sheet-workflow-contracts";
import type { SheetWorkflowHttpClientOptions } from "./options";

type EnqueueClient<Contract extends AnyWorkflowContract> = {
  readonly enqueue: (
    input: WorkflowContractInput<Contract>,
    options: { readonly invocationId: InvocationId },
  ) => ReturnType<WorkflowClient<Contract, WorkflowEnqueueError, never>["enqueue"]>;
};

type WorkflowEnqueueClientTree<Node> = Node extends AnyWorkflowContract
  ? EnqueueClient<Node>
  : { readonly [Key in keyof Node]: WorkflowEnqueueClientTree<Node[Key]> };

export type SheetWorkflowEnqueueClients = WorkflowEnqueueClientTree<typeof SheetWorkflowContracts>;

export const makeSheetWorkflowEnqueueClients = (
  httpClient: HttpClient.HttpClient,
  options: SheetWorkflowHttpClientOptions,
): SheetWorkflowEnqueueClients =>
  mapWorkflowContractTree(SheetWorkflowContracts, (contract) =>
    Object.freeze({
      enqueue: (
        input: WorkflowContractInput<typeof contract>,
        enqueueOptions: { readonly invocationId: InvocationId },
      ) => makeWorkflowHttpEnqueueClient(contract, httpClient, options)(input, enqueueOptions),
    }),
  ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as SheetWorkflowEnqueueClients /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

export type { SheetWorkflowHttpClientOptions } from "./options";
