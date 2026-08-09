import type { Query, Transaction } from "@rocicorp/zero";
import { Predicate } from "effect";
import {
  makeWorkflowZeroGroup,
  type WorkflowZeroGroupOptions,
} from "effect-zero-workflow/contract/zero";
import { defaultWorkflowRunListLimit, workflowContractKey } from "effect-zero-workflow/contract";
import type { ActorProvenance, EffectivePrincipal } from "sheet-auth/identity";
import { SheetWorkflowContractCatalog } from "sheet-workflow-contracts";
import type { AnyWorkflowContract } from "effect-zero-workflow/contract";
import { zql, type Schema as SheetZeroSchema } from "sheet-zero-api";
import { enqueueWorkflowContractInvocationInZeroTransaction } from "sheet-zero-api/server";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";

export interface SheetWorkflowZeroContext {
  readonly ownerKey: string;
  readonly principal: EffectivePrincipal;
  readonly actorProvenance?: ActorProvenance | undefined;
}

type SheetWorkflowZeroOptions = WorkflowZeroGroupOptions<SheetZeroSchema, SheetWorkflowZeroContext>;

type SheetWorkflowRunQuery = Query<keyof SheetZeroSchema["tables"], SheetZeroSchema, unknown>;

const asWorkflowRunQuery = <TReturn>(
  query: Query<"workflowRun", SheetZeroSchema, TReturn>,
): SheetWorkflowRunQuery => query as unknown as SheetWorkflowRunQuery;

export type EnqueueSheetWorkflowContract = (options: {
  readonly contract: Parameters<SheetWorkflowZeroOptions["enqueue"]>[0]["contract"];
  readonly request: Parameters<SheetWorkflowZeroOptions["enqueue"]>[0]["request"];
  readonly context: SheetWorkflowZeroContext;
  readonly transaction: Transaction<SheetZeroSchema>;
}) => Promise<void>;

export const enqueueSheetWorkflowContractInvocationInZeroTransaction: typeof enqueueWorkflowContractInvocationInZeroTransaction =
  (transaction, invocation) =>
    enqueueWorkflowContractInvocationInZeroTransaction(transaction, invocation);

const statusesByState = {
  Pending: ["pending", "running"],
  Success: ["succeeded"],
  Failure: ["failed", "cancelled"],
} as const;

const makeOptions = (
  enqueue: EnqueueSheetWorkflowContract,
  workflowRun: typeof zql.workflowRun,
): SheetWorkflowZeroOptions => ({
  enqueue,
  get: ({ contract, context, invocationId }) =>
    asWorkflowRunQuery(
      workflowRun
        .where("runId", "=", invocationId)
        .where("workflowName", "=", workflowContractKey(contract))
        .where("visibilityKey", "=", context.ownerKey)
        .one(),
    ),
  list: ({ contract, context, filter }) => {
    const scoped = workflowRun
      .where("workflowName", "=", workflowContractKey(contract))
      .where("visibilityKey", "=", context.ownerKey);
    const states = filter.states?.flatMap((state) => statusesByState[state]);
    const filtered = Predicate.isUndefined(states) ? scoped : scoped.where("status", "IN", states);
    const ordered = filtered
      .orderBy("createdAt", "desc")
      .orderBy("runId", "desc")
      .limit(filter.limit ?? defaultWorkflowRunListLimit);
    return asWorkflowRunQuery(
      Predicate.isUndefined(filter.cursor)
        ? ordered
        : ordered.start(
            {
              createdAt: filter.cursor.submittedAt.getTime(),
              runId: filter.cursor.invocationId,
            },
            { inclusive: false },
          ),
    );
  },
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
