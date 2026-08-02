import { Cause, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import { expect, layer } from "@effect/vitest";
import { Workflow } from "effect/unstable/workflow";
import {
  WorkflowStore,
  type EnqueueWorkflow,
  type EnqueueWorkflowCommand,
  type WorkflowRun,
  type WorkflowStoreService,
} from "effect-zero-workflow";
import {
  DispatchWorkflowCommandBadRequestError,
  DispatchWorkflowRunNotFoundError,
} from "sheet-ingress-api/internal";
import {
  createDispatchWorkflowEvent,
  enqueueDispatchWorkflow,
  enqueueDispatchWorkflowCommand,
} from "./workflowCommands";

const TestWorkflow = Workflow.make({
  name: "test.workflow.v1",
  payload: Schema.Struct({
    payload: Schema.Struct({
      client: Schema.Struct({
        platform: Schema.String,
        clientId: Schema.String,
      }),
      workspaceId: Schema.optional(Schema.String),
    }),
    requester: Schema.Struct({
      accountId: Schema.String,
      userId: Schema.String,
    }),
    value: Schema.String,
  }),
  idempotencyKey: ({ value }) => value,
});

interface TestWorkflowStore extends WorkflowStoreService {
  readonly enqueued: Ref.Ref<Option.Option<EnqueueWorkflow>>;
  readonly enqueuedCommand: Ref.Ref<Option.Option<EnqueueWorkflowCommand>>;
  readonly run: Ref.Ref<Option.Option<WorkflowRun>>;
}

const TestWorkflowStoreLayer = Layer.sync(WorkflowStore, (): TestWorkflowStore => {
  const enqueued = Ref.makeUnsafe(Option.none<EnqueueWorkflow>());
  const enqueuedCommand = Ref.makeUnsafe(Option.none<EnqueueWorkflowCommand>());
  const run = Ref.makeUnsafe(
    Option.some<WorkflowRun>({
      runId: "invocation-1",
      workflowName: TestWorkflow.name,
      definitionVersion: "1",
      executionId: "execution-1",
      status: "running",
      result: null,
      error: null,
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  );

  return {
    enqueued,
    enqueuedCommand,
    run,
    enqueue: (input) =>
      Ref.set(enqueued, Option.some(input)).pipe(
        Effect.as({ runId: input.runId, executionId: input.executionId }),
      ),
    enqueueCommand: (command) => Ref.set(enqueuedCommand, Option.some(command)),
    claim: () => Effect.die("unused"),
    getRun: () => Ref.get(run).pipe(Effect.map(Option.getOrUndefined)),
    listRuns: () => Effect.die("unused"),
    markCommandDelivered: () => Effect.die("unused"),
    retryCommand: () => Effect.die("unused"),
    failCommand: () => Effect.die("unused"),
    markRun: () => Effect.die("unused"),
  };
});

const testWorkflowStore = WorkflowStore.pipe(Effect.map((store) => store as TestWorkflowStore));

layer(TestWorkflowStoreLayer)("workflow command acceptance", (it) => {
  it.effect("preserves the caller-generated invocation id", () =>
    Effect.gen(function* () {
      const store = yield* testWorkflowStore;
      const payload = {
        payload: {
          client: { platform: "discord", clientId: "main" },
          workspaceId: "workspace-1",
        },
        requester: { accountId: "account-1", userId: "user-1" },
        value: "request-1",
      };
      const expectedExecutionId = yield* TestWorkflow.executionId(payload);
      const runId = "invocation-1";

      const invocationId = yield* enqueueDispatchWorkflow(TestWorkflow, payload, runId);

      expect(invocationId).toBe(runId);
      const command = Option.getOrThrow(yield* Ref.get(store.enqueued));
      expect(command).toMatchObject({
        workflowName: "test.workflow.v1",
        definitionVersion: "1",
        executionId: expectedExecutionId,
        idempotencyKey: expectedExecutionId,
        visibilityKey: "account:account-1",
        principal: { accountId: "account-1" },
        payload,
      });
      expect(command.runId).toBe(runId);
    }),
  );

  it.effect("scopes visibility to the authenticated account", () =>
    Effect.gen(function* () {
      const store = yield* testWorkflowStore;
      const payload = {
        payload: {
          client: { platform: "discord", clientId: "secondary" },
        },
        requester: { accountId: "account-2", userId: "user-2" },
        value: "request-2",
      };

      yield* enqueueDispatchWorkflow(TestWorkflow, payload);

      expect(Option.getOrThrow(yield* Ref.get(store.enqueued)).visibilityKey).toBe(
        "account:account-2",
      );
    }),
  );

  it.effect("persists lifecycle commands instead of calling the engine directly", () =>
    Effect.gen(function* () {
      const store = yield* testWorkflowStore;

      yield* enqueueDispatchWorkflowCommand(TestWorkflow, "invocation-1", "event-1", "event", {
        eventId: "mailbox-event-1",
        value: { reviewer: "account-2" },
      });

      expect(Option.getOrThrow(yield* Ref.get(store.enqueuedCommand))).toEqual({
        commandId: "event-1",
        runId: "invocation-1",
        kind: "event",
        payload: {
          eventId: "mailbox-event-1",
          value: { reviewer: "account-2" },
        },
      });
    }),
  );

  it.effect("creates a mailbox event tied to the stored workflow execution", () =>
    Effect.gen(function* () {
      const eventId = yield* createDispatchWorkflowEvent(
        TestWorkflow,
        "invocation-1",
        "approval-1",
      );

      expect(eventId).toEqual(expect.any(String));
    }),
  );

  it.effect("returns a typed bad request for an invalid command payload", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        enqueueDispatchWorkflowCommand(TestWorkflow, "invocation-1", "event-1", "event", undefined),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(failure).toBeInstanceOf(DispatchWorkflowCommandBadRequestError);
      expect(failure).toMatchObject({ runId: "invocation-1" });
    }),
  );

  it.effect("returns a typed not found error for an unknown workflow run", () =>
    Effect.gen(function* () {
      const store = yield* testWorkflowStore;
      yield* Ref.set(store.run, Option.none());

      const exit = yield* Effect.exit(
        createDispatchWorkflowEvent(TestWorkflow, "missing-run", "approval-1"),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(failure).toBeInstanceOf(DispatchWorkflowRunNotFoundError);
      expect(failure).toMatchObject({ runId: "missing-run" });
    }),
  );
});
