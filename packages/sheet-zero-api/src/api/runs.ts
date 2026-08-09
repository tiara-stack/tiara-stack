import { makeZeroWorkflowComponent, type ZeroWorkflowComponent } from "effect-zero-workflow";
import { schema, zql } from "../schema";

export const sheetZeroTablePrefix = "sheet_db";

type SheetWorkflowComponent = ZeroWorkflowComponent<typeof schema>;

const workflowComponent: SheetWorkflowComponent = makeZeroWorkflowComponent({
  schema,
  workflowRun: zql.workflowRun,
  tablePrefix: sheetZeroTablePrefix,
  delegatedContext: (principalId) => ({
    principalId,
    visibilityKey: `account:${principalId}`,
  }),
});

export const enqueueWorkflowCommandInZeroTransaction: SheetWorkflowComponent["enqueueWorkflowCommandInZeroTransaction"] =
  workflowComponent.enqueueWorkflowCommandInZeroTransaction;
export const enqueueWorkflowContractInvocationInZeroTransaction: SheetWorkflowComponent["enqueueContractInvocationInZeroTransaction"] =
  workflowComponent.enqueueContractInvocationInZeroTransaction;
export const enqueueWorkflowEventInZeroTransaction: SheetWorkflowComponent["enqueueWorkflowEventInZeroTransaction"] =
  workflowComponent.enqueueWorkflowEventInZeroTransaction;
export const enqueueWorkflowInZeroTransaction: SheetWorkflowComponent["enqueueWorkflowInZeroTransaction"] =
  workflowComponent.enqueueWorkflowInZeroTransaction;
export const mutateWithWorkflow: SheetWorkflowComponent["mutateWithWorkflow"] =
  workflowComponent.mutateWithWorkflow;

export type RunsGroup = SheetWorkflowComponent["runsGroup"];

export const runsGroup: RunsGroup = workflowComponent.runsGroup;
