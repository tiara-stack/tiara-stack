import {
  mapWorkflowContractTree,
  type AnyWorkflowContract,
  defaultWorkflowRunListLimit,
  workflowContractKey,
  type WorkflowClient,
} from "effect-zero-workflow/contract";
import {
  makeWorkflowZeroClient,
  makeWorkflowZeroObservationGroup,
  workflowZeroProcedureManifest,
  type WorkflowZeroObservationGroupOptions,
  type WorkflowZeroExecutor,
} from "effect-zero-workflow/contract/zero";
import { workflowContractZeroGroupIdentifier } from "effect-zero-workflow/contract/transport";
import type {
  WorkflowEnqueueError,
  WorkflowObservationError,
} from "effect-zero-workflow/contract/transport";
import {
  CheckinMessagesLoad,
  SheetWorkflowContractCatalog,
  SheetWorkflowContracts,
} from "sheet-workflow-contracts";
import { zql, type Schema } from "./schema";
import type { Query } from "@rocicorp/zero";
import type { ZeroApiGroup } from "typhoon-zero/zeroApi";

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

export interface SheetWorkflowZeroObservationContext {
  readonly ownerKey: string;
}

export const SheetWorkflowZeroObservationContracts = Object.freeze([CheckinMessagesLoad] as const);

type SheetWorkflowRunQuery = Query<"workflowRun", Schema, unknown>;

const asSheetWorkflowRunQuery = <Return>(query: Query<"workflowRun", Schema, Return>) =>
  query as unknown as SheetWorkflowRunQuery;

const observationStatuses = {
  Pending: ["pending", "running"],
  Success: ["succeeded"],
  Failure: ["failed", "cancelled"],
} as const;

export const makeSheetWorkflowZeroObservationOptions = (
  workflowRun: typeof zql.workflowRun,
): WorkflowZeroObservationGroupOptions<Schema, SheetWorkflowZeroObservationContext> => ({
  get: ({ contract, context, invocationId }) =>
    asSheetWorkflowRunQuery(
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
    const states = filter.states?.flatMap((state) => observationStatuses[state]);
    const filtered = states === undefined ? scoped : scoped.where("status", "IN", states);
    const ordered = filtered
      .orderBy("createdAt", "desc")
      .orderBy("runId", "desc")
      .limit(filter.limit ?? defaultWorkflowRunListLimit);
    return asSheetWorkflowRunQuery(
      filter.cursor === undefined
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

const makeSheetWorkflowZeroObservationGroup = (
  contract: AnyWorkflowContract,
  options: WorkflowZeroObservationGroupOptions<Schema, SheetWorkflowZeroObservationContext>,
) => makeWorkflowZeroObservationGroup(contract, options) as ZeroApiGroup.Any;

export type SheetWorkflowZeroObservationGroup = ZeroApiGroup.Any;

export const makeSheetWorkflowZeroObservationGroups = (
  workflowRun: typeof zql.workflowRun = zql.workflowRun,
  contracts: ReadonlyArray<AnyWorkflowContract> = SheetWorkflowZeroObservationContracts,
): ReadonlyArray<SheetWorkflowZeroObservationGroup> => {
  const options = makeSheetWorkflowZeroObservationOptions(workflowRun);
  return contracts.map((contract) => makeSheetWorkflowZeroObservationGroup(contract, options));
};

export const sheetWorkflowZeroObservationGroups = makeSheetWorkflowZeroObservationGroups();

export const sheetWorkflowZeroObservationProcedureManifest = Object.freeze(
  SheetWorkflowZeroObservationContracts.flatMap((contract) => {
    const group = workflowContractZeroGroupIdentifier(contract);
    return [`${group}.get`, `${group}.list`] as const;
  }),
);
