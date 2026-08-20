import { Schema, type Effect } from "effect";
import {
  InvocationConflict,
  InvocationId,
  WorkflowRunListFilter,
  type AnyWorkflowContract,
  type RunReference,
  type WorkflowContractInput,
  type WorkflowRun,
} from "./contract";

const PublicMessage = Schema.Trimmed.check(Schema.isNonEmpty());

export class WorkflowInputRejected extends Schema.TaggedErrorClass<WorkflowInputRejected>()(
  "WorkflowInputRejected",
  { message: PublicMessage },
) {}

export class WorkflowInvocationUnauthorized extends Schema.TaggedErrorClass<WorkflowInvocationUnauthorized>()(
  "WorkflowInvocationUnauthorized",
  { message: PublicMessage },
) {}

export const WorkflowTransportOperation = Schema.Literals(["Enqueue", "Observe"]);
export type WorkflowTransportOperation = Schema.Schema.Type<typeof WorkflowTransportOperation>;

export class WorkflowTransportUnavailable extends Schema.TaggedErrorClass<WorkflowTransportUnavailable>()(
  "WorkflowTransportUnavailable",
  {
    operation: WorkflowTransportOperation,
    retryable: Schema.Boolean,
    message: PublicMessage,
  },
) {}

export class WorkflowObservationUnauthorized extends Schema.TaggedErrorClass<WorkflowObservationUnauthorized>()(
  "WorkflowObservationUnauthorized",
  { message: PublicMessage },
) {}

export class WorkflowObservationInvalidData extends Schema.TaggedErrorClass<WorkflowObservationInvalidData>()(
  "WorkflowObservationInvalidData",
  { message: PublicMessage },
) {}

export const WorkflowEnqueueError = Schema.Union([
  WorkflowInputRejected,
  WorkflowInvocationUnauthorized,
  InvocationConflict,
  WorkflowTransportUnavailable,
]);
export type WorkflowEnqueueError = Schema.Schema.Type<typeof WorkflowEnqueueError>;

export const WorkflowObservationError = Schema.Union([
  WorkflowObservationUnauthorized,
  WorkflowObservationInvalidData,
  WorkflowTransportUnavailable,
]);
export type WorkflowObservationError = Schema.Schema.Type<typeof WorkflowObservationError>;

export const WorkflowEnqueueRequest = <Contract extends AnyWorkflowContract>(contract: Contract) =>
  Schema.Struct({
    invocationId: InvocationId,
    input: contract.input,
  });

export type WorkflowEnqueueRequest<Contract extends AnyWorkflowContract> = {
  readonly invocationId: InvocationId;
  readonly input: WorkflowContractInput<Contract>;
};

export interface WorkflowTransportHandler<Context, Requirements = never> {
  readonly enqueue: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    context: Context,
    request: WorkflowEnqueueRequest<Contract>,
  ) => Effect.Effect<RunReference<Contract>, WorkflowEnqueueError, Requirements>;
  readonly get: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    context: Context,
    invocationId: InvocationId,
  ) => Effect.Effect<WorkflowRun<Contract> | undefined, WorkflowObservationError, Requirements>;
  readonly list: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    context: Context,
    filter?: typeof WorkflowRunListFilter.Type,
  ) => Effect.Effect<ReadonlyArray<WorkflowRun<Contract>>, WorkflowObservationError, Requirements>;
}

const SafePathPart = Schema.String.check(
  Schema.makeFilter((value) =>
    value === "." || value === ".."
      ? `Workflow contract route identifier cannot be "${value}"`
      : undefined,
  ),
);

const ensureSafePathPart = (value: string): string => Schema.decodeUnknownSync(SafePathPart)(value);

const encodePathPart = (value: string): string => encodeURIComponent(ensureSafePathPart(value));

const encodeWorkflowGroupPart = (value: string): string =>
  encodePathPart(ensureSafePathPart(value)).replaceAll(".", "%2E");

export const workflowContractRoutePrefix = (contract: AnyWorkflowContract): string =>
  `/workflows/${encodePathPart(contract.identity)}/v/${encodePathPart(contract.wireVersion)}`;

export const workflowContractRoutes = (contract: AnyWorkflowContract) => {
  const prefix = workflowContractRoutePrefix(contract);
  return Object.freeze({
    enqueue: `${prefix}/enqueue`,
    get: `${prefix}/runs/:invocationId/events`,
    list: `${prefix}/runs/events`,
  });
};

export const workflowContractZeroGroupIdentifier = (contract: AnyWorkflowContract): string =>
  `workflow:${encodeWorkflowGroupPart(contract.identity)}:v:${encodeWorkflowGroupPart(contract.wireVersion)}`;
