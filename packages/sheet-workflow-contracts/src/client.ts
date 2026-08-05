import type {
  AnyWorkflowContract,
  RunReference,
  WorkflowClient,
  WorkflowRun,
} from "effect-zero-workflow/contract";

export type SheetWorkflowClient<
  Contract extends AnyWorkflowContract,
  EnqueueError,
  ObservationError,
  EnqueueRequirements = never,
  ObservationRequirements = never,
> = WorkflowClient<
  Contract,
  EnqueueError,
  ObservationError,
  EnqueueRequirements,
  ObservationRequirements
>;

export type SheetWorkflowRunReference<Contract extends AnyWorkflowContract> =
  RunReference<Contract>;

export type SheetWorkflowRun<Contract extends AnyWorkflowContract> = WorkflowRun<Contract>;
