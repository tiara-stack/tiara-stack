import { Effect, Layer, Random, Schema } from "effect";
import { type Workflow } from "effect/unstable/workflow";
import {
  defineEvent,
  enqueueWorkflowDefinition,
  reconcileWorkflowRuns,
  WorkflowStore,
  workflowRuntimeCommandExecutorLayer,
  workflowRuntimeLayer,
  type WorkflowCommandKindType,
  type WorkflowJson,
  type WorkflowStoreService,
} from "effect-zero/workflow";
import {
  DispatchWorkflowCommandBadRequestError,
  DispatchWorkflowRunNotFoundError,
} from "sheet-ingress-api/internal";
import { DispatchClusterWorkflows } from "@/workflows/dispatchWorkflows";

const DispatchWorkflowPrincipal = Schema.Struct({
  requester: Schema.Struct({
    accountId: Schema.String,
  }),
});

const DispatchMailboxEvent = defineEvent({
  name: "sheet-workflows.dispatch.mailbox",
  value: Schema.Json,
});

const dispatchRuntimeLayer = workflowRuntimeLayer({
  workflows: DispatchClusterWorkflows.all,
  events: [DispatchMailboxEvent],
  definitionVersion: () => "1",
});

const invocationContext = (payload: unknown) =>
  Schema.decodeUnknownEffect(DispatchWorkflowPrincipal)(payload).pipe(
    Effect.map(({ requester }) => ({
      principal: {
        accountId: requester.accountId,
      } satisfies WorkflowJson,
      visibilityKey: `account:${requester.accountId}`,
    })),
  );

const requireWorkflowRun = (store: WorkflowStoreService, workflow: Workflow.Any, runId: string) =>
  Effect.gen(function* () {
    const run = yield* store.getRun(runId).pipe(Effect.orDie);
    if (!run || run.runId !== runId || run.workflowName !== workflow.name) {
      return yield* Effect.fail(
        new DispatchWorkflowRunNotFoundError({
          runId,
          message: `Workflow run not found for ${workflow.name}: ${runId}`,
        }),
      );
    }
    return run;
  });

export const enqueueDispatchWorkflow = (
  workflow: Workflow.Any,
  payload: unknown,
  requestedRunId?: string,
) =>
  Effect.gen(function* () {
    const context = yield* invocationContext(payload);
    const runId = requestedRunId ?? (yield* Random.nextUUIDv4);
    const run = yield* enqueueWorkflowDefinition(workflow, payload, {
      runId,
      ...context,
    });
    return run.runId;
  }).pipe(Effect.provide(dispatchRuntimeLayer));

export const enqueueDispatchWorkflowCommand = (
  workflow: Workflow.Any,
  runId: string,
  commandId: string,
  kind: WorkflowCommandKindType,
  payload: unknown,
) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    yield* requireWorkflowRun(store, workflow, runId);
    const encodedPayload = yield* Schema.decodeUnknownEffect(Schema.Json)(payload).pipe(
      Effect.mapError(
        (error) =>
          new DispatchWorkflowCommandBadRequestError({
            runId,
            message: error.message,
          }),
      ),
    );
    yield* store
      .enqueueCommand({
        commandId,
        runId,
        kind,
        payload: encodedPayload,
      })
      .pipe(Effect.orDie);
  });

export const createDispatchWorkflowEvent = (
  workflow: Workflow.Any,
  runId: string,
  eventKey: string,
) =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const run = yield* requireWorkflowRun(store, workflow, runId);
    return DispatchMailboxEvent.create({
      workflow,
      executionId: run.executionId,
      eventKey,
    });
  });

export const workflowCommandExecutorLayer = workflowRuntimeCommandExecutorLayer.pipe(
  Layer.provide(dispatchRuntimeLayer),
);

export const reconcileDispatchWorkflowRuns = reconcileWorkflowRuns().pipe(
  Effect.provide(dispatchRuntimeLayer),
);
