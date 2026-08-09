import { Cause, Effect, Layer, Random, Ref, Schema } from "effect";
import {
  defineEvent,
  enqueueWorkflowDefinition,
  reconcileWorkflowRuns,
  WorkflowStore,
  workflowRuntimeCommandExecutorLayer,
  workflowRuntimeLayer,
  type WorkflowCommandKindType,
  type WorkflowDefinition,
  type WorkflowJson,
  type WorkflowRunCursor,
  type WorkflowStoreService,
} from "effect-zero-workflow";
import {
  DispatchWorkflowCommandBadRequestError,
  DispatchWorkflowRunNotFoundError,
} from "sheet-ingress-api/internal";
import { DispatchClusterWorkflows } from "@/workflows/dispatchWorkflows";
import {
  isReadOnlySheetWorkflowName,
  materializeReadOnlyWorkflowFailure,
  ReadOnlySheetWorkflows,
} from "@/workflows/readOnly";

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
  workflows: [...DispatchClusterWorkflows.all, ...ReadOnlySheetWorkflows],
  events: [DispatchMailboxEvent],
  definitionVersion: () => "1",
  materializeFailure: (workflow, cause) =>
    isReadOnlySheetWorkflowName(workflow.name)
      ? materializeReadOnlyWorkflowFailure(workflow, cause)
      : { message: Cause.pretty(cause) },
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

const requireWorkflowRun = (
  store: WorkflowStoreService,
  workflow: WorkflowDefinition,
  runId: string,
) =>
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
  workflow: WorkflowDefinition,
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
  workflow: WorkflowDefinition,
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
  workflow: WorkflowDefinition,
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

export const reconcileDispatchWorkflowRuns = (cursor: Ref.Ref<WorkflowRunCursor | undefined>) =>
  reconcileWorkflowRuns({ cursor }).pipe(Effect.provide(dispatchRuntimeLayer));
