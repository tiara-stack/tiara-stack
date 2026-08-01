import { Context, Duration, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import { DispatchWorkflowOperations } from "sheet-ingress-api/internal";
import { makeUnknownError, type UnknownError } from "typhoon-core/error";
import { WorkflowZeroClient } from "./workflowZeroClient";

type DispatchWorkflowOperation =
  (typeof DispatchWorkflowOperations)[keyof typeof DispatchWorkflowOperations];
type DispatchWorkflowArguments<Operation extends DispatchWorkflowOperation> =
  Operation["workflow"]["payloadSchema"]["~type.make.in"];
type DispatchWorkflowExecutionId<Operation extends DispatchWorkflowOperation> = (
  payload: DispatchWorkflowArguments<Operation>,
) => Effect.Effect<string>;
type DispatchWorkflowForwarders = {
  readonly [Operation in DispatchWorkflowOperation as Operation["endpointName"]]: (
    args: DispatchWorkflowArguments<Operation>,
  ) => Effect.Effect<
    {
      readonly runId: string;
      readonly operation: Operation["operation"];
      readonly status: "accepted";
    },
    UnknownError
  >;
};

const DispatchPrincipal = Schema.Struct({
  requester: Schema.Struct({
    accountId: Schema.String,
  }),
});

const workflowEnqueueTimeout = Duration.seconds(30);
const workflowEnqueueRetrySchedule = Schedule.exponential(Duration.millis(100));
const workflowDefinitionVersion = "1";

const prepareWorkflowPayload = <Operation extends DispatchWorkflowOperation>(
  operation: Operation,
  value: DispatchWorkflowArguments<Operation>,
) => {
  const schema: Operation["workflow"]["payloadSchema"] = operation.workflow.payloadSchema;
  return Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
    Effect.map((payload) => ({ payload, value })),
  );
};

const workflowExecutionId = <Operation extends DispatchWorkflowOperation>(
  operation: Operation,
  payload: DispatchWorkflowArguments<Operation>,
): Effect.Effect<string> =>
  // TypeScript loses the payload/executionId correlation when indexing the
  // generated union, so restore that operation-local relationship here.
  (operation.workflow.executionId as DispatchWorkflowExecutionId<Operation>)(payload);

export class SheetWorkflowsForwardingClient extends Context.Service<SheetWorkflowsForwardingClient>()(
  "SheetWorkflowsForwardingClient",
  {
    make: Effect.gen(function* () {
      const client = yield* WorkflowZeroClient;

      const enqueue = <const Operation extends DispatchWorkflowOperation>(
        operation: Operation,
        args: DispatchWorkflowArguments<Operation>,
      ) =>
        Effect.gen(function* () {
          const { payload, value } = yield* prepareWorkflowPayload(operation, args).pipe(
            Effect.mapError((error) =>
              makeUnknownError("Invalid workflow dispatch payload", error),
            ),
          );
          const { requester } = yield* Schema.decodeUnknownEffect(DispatchPrincipal)(value).pipe(
            Effect.mapError((error) =>
              makeUnknownError("Invalid workflow dispatch principal", error),
            ),
          );
          const executionId = yield* workflowExecutionId(operation, value);
          // Zero mutations do not return an authoritative server value. Use the
          // workflow's globally stable execution identity as the public run ID,
          // so an idempotent retry observes the same optimistic identity.
          const runId = executionId;
          yield* client
            .enqueueAsCaller({
              caller: {
                principalId: requester.accountId,
              },
              workflow: {
                runId,
                workflowName: operation.workflow.name,
                definitionVersion: workflowDefinitionVersion,
                executionId,
                payload,
              },
            })
            .pipe(
              Effect.retry({
                schedule: workflowEnqueueRetrySchedule,
                times: 4,
                while: Predicate.isTagged("MutatorResultZeroError"),
              }),
              Effect.timeout(workflowEnqueueTimeout),
              Effect.tapError((error) =>
                Effect.logError("Failed to enqueue workflow dispatch through Zero").pipe(
                  Effect.annotateLogs({
                    error,
                    operation: operation.operation,
                    runId,
                    workflowName: operation.workflow.name,
                  }),
                ),
              ),
              Effect.mapError((error) =>
                makeUnknownError("Failed to persist workflow dispatch", error),
              ),
            );
          return {
            runId,
            operation: operation.operation,
            status: "accepted" as const,
          };
        });

      const dispatch = Object.fromEntries(
        Object.values(DispatchWorkflowOperations).map(
          (operation) =>
            [
              operation.endpointName,
              (args: DispatchWorkflowArguments<typeof operation>) => enqueue(operation, args),
            ] as const,
        ),
      ) as DispatchWorkflowForwarders;

      return { dispatch };
    }),
  },
) {
  static layer = Layer.effect(SheetWorkflowsForwardingClient, this.make);
}
