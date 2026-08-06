import { Effect, Option, Predicate, Schema, Stream } from "effect";
import {
  InvocationId,
  WorkflowRunListFilter,
  makeWorkflowRunSchema,
  type AnyWorkflowContract,
  type RunReference,
  type WorkflowRun,
} from "./contract";
import { encodeWorkflowSse } from "./contract-http";
import {
  WorkflowEnqueueRequest,
  WorkflowInputRejected,
  WorkflowObservationInvalidData,
  workflowContractRoutes,
  type WorkflowEnqueueError,
  type WorkflowObservationError,
  type WorkflowTransportHandler,
} from "./contract-transport";

export interface WorkflowHttpServerExecutor<Context, Requirements = never> {
  readonly enqueue: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    context: Context,
    request: WorkflowEnqueueRequest<Contract>,
  ) => Effect.Effect<RunReference<Contract>, WorkflowEnqueueError, Requirements>;
  readonly get: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    context: Context,
    invocationId: InvocationId,
  ) => Stream.Stream<Option.Option<WorkflowRun<Contract>>, WorkflowObservationError, Requirements>;
  readonly list: <Contract extends AnyWorkflowContract>(
    contract: Contract,
    context: Context,
    filter: typeof WorkflowRunListFilter.Type,
  ) => Stream.Stream<ReadonlyArray<WorkflowRun<Contract>>, WorkflowObservationError, Requirements>;
}

/**
 * Adapts snapshot Effects to one-shot observation streams. Each get or list request emits at most
 * one event and then closes; a pending run will not emit later state changes without a new request.
 */
export const workflowHttpServerExecutorFromHandler = <Context, Requirements = never>(
  handler: WorkflowTransportHandler<Context, Requirements>,
): WorkflowHttpServerExecutor<Context, Requirements> => ({
  enqueue: (contract, context, request) => handler.enqueue(contract, context, request),
  get: (contract, context, invocationId) =>
    Stream.fromEffect(handler.get(contract, context, invocationId)).pipe(
      Stream.map(Option.fromUndefinedOr),
    ),
  list: (contract, context, filter) => Stream.fromEffect(handler.list(contract, context, filter)),
});

const invalidObservationRequest = () =>
  new WorkflowObservationInvalidData({ message: "Workflow observation request is invalid" });

export const makeWorkflowHttpRouteHandlers = <
  Contract extends AnyWorkflowContract,
  Context,
  Requirements = never,
>(
  contract: Contract,
  executor: WorkflowHttpServerExecutor<Context, Requirements>,
) => {
  const routes = workflowContractRoutes(contract);
  const getEvent = Schema.OptionFromNullishOr(makeWorkflowRunSchema(contract));
  const listEvent = Schema.Array(makeWorkflowRunSchema(contract));

  return Object.freeze({
    contract,
    routes,
    enqueue: (context: Context, request: unknown) =>
      Schema.decodeUnknownEffect(WorkflowEnqueueRequest(contract))(request).pipe(
        Effect.mapError(() => new WorkflowInputRejected({ message: "Workflow input is invalid" })),
        Effect.flatMap((decoded) =>
          executor.enqueue(contract, context, decoded as WorkflowEnqueueRequest<Contract>),
        ),
      ),
    get: (context: Context, invocationId: unknown) =>
      Stream.unwrap(
        Schema.decodeUnknownEffect(InvocationId)(invocationId).pipe(
          Effect.mapError(invalidObservationRequest),
          Effect.map((decoded) => executor.get(contract, context, decoded)),
        ),
      ).pipe(Stream.mapEffect((event) => encodeWorkflowSse(getEvent, event))),
    list: (context: Context, filter: unknown = {}) =>
      Stream.unwrap(
        Schema.decodeUnknownEffect(WorkflowRunListFilter)(filter).pipe(
          Effect.mapError(invalidObservationRequest),
          Effect.map((decoded) => executor.list(contract, context, decoded)),
        ),
      ).pipe(Stream.mapEffect((event) => encodeWorkflowSse(listEvent, event))),
  });
};

export const makeWorkflowHttpRouteCatalog = <Context, Requirements = never>(
  contracts: ReadonlyArray<AnyWorkflowContract>,
  executor: WorkflowHttpServerExecutor<Context, Requirements>,
) => {
  const routes = contracts.map((contract) => makeWorkflowHttpRouteHandlers(contract, executor));
  const paths = new Set<string>();
  for (const route of routes) {
    for (const path of Object.values(route.routes)) {
      if (paths.has(path)) {
        throw new Error(`Duplicate workflow HTTP route: ${path}`);
      }
      paths.add(path);
    }
  }
  return Object.freeze(routes);
};

export const workflowEnqueueErrorStatus = (error: WorkflowEnqueueError): number => {
  if (Predicate.isTagged("WorkflowInputRejected")(error)) return 400;
  if (Predicate.isTagged("WorkflowInvocationUnauthorized")(error)) return 403;
  if (Predicate.isTagged("InvocationConflict")(error)) return 409;
  return 503;
};

export const workflowObservationErrorStatus = (error: WorkflowObservationError): number => {
  if (Predicate.isTagged("WorkflowObservationUnauthorized")(error)) return 403;
  if (Predicate.isTagged("WorkflowObservationInvalidData")(error)) return 400;
  return 503;
};
