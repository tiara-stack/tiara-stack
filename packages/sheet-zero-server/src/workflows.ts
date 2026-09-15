import type { Transaction } from "@rocicorp/zero";
import {
  makeWorkflowZeroGroup,
  type WorkflowZeroGroupOptions,
} from "effect-zero-workflow/contract/zero";
import type { ActorProvenance, EffectivePrincipal } from "sheet-auth/identity";
import { SheetWorkflowContractCatalog } from "sheet-workflow-contracts";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import { zql, type Schema as SheetZeroSchema } from "sheet-zero-api";
import { enqueueWorkflowContractInvocationInZeroTransaction } from "sheet-zero-api/server";
import { makeSheetWorkflowZeroObservationOptions } from "sheet-zero-api/workflows";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";

export interface SheetWorkflowZeroContext {
  readonly ownerKey: string;
  readonly principal: EffectivePrincipal;
  readonly actorProvenance?: ActorProvenance | undefined;
}

type SheetWorkflowZeroOptions = WorkflowZeroGroupOptions<SheetZeroSchema, SheetWorkflowZeroContext>;

export type EnqueueSheetWorkflowContract = (options: {
  readonly contract: Parameters<SheetWorkflowZeroOptions["enqueue"]>[0]["contract"];
  readonly request: Parameters<SheetWorkflowZeroOptions["enqueue"]>[0]["request"];
  readonly context: SheetWorkflowZeroContext;
  readonly transaction: Transaction<SheetZeroSchema>;
}) => Promise<void>;

export const enqueueSheetWorkflowContractInvocationInZeroTransaction: typeof enqueueWorkflowContractInvocationInZeroTransaction =
  (transaction, invocation) =>
    enqueueWorkflowContractInvocationInZeroTransaction(transaction, invocation);

const makeOptions = (
  enqueue: EnqueueSheetWorkflowContract,
  workflowRun: typeof zql.workflowRun,
): SheetWorkflowZeroOptions => ({
  enqueue,
  ...makeSheetWorkflowZeroObservationOptions(workflowRun),
});

/**
 * Builds the canonical Sheet Zero groups for every published Workflow Contract.
 * The caller supplies the server-authoritative enqueue implementation so the
 * groups cannot be mounted before Workflow Definitions and authorization are registered.
 */
export const makeSheetWorkflowZeroGroups = (
  enqueue: EnqueueSheetWorkflowContract,
  workflowRun: typeof zql.workflowRun = zql.workflowRun,
  contracts: ReadonlyArray<AnyWorkflowContract> = SheetWorkflowContractCatalog,
): ReadonlyArray<ZeroApiGroup.Any> => {
  const options = makeOptions(enqueue, workflowRun);
  return contracts.map((contract) => makeWorkflowZeroGroup(contract, options));
};
