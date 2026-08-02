import { Cause, Effect, Exit, Layer, Predicate, Ref, Schema } from "effect";
import { expect, it, layer } from "@effect/vitest";
import { ClusterError } from "effect/unstable/cluster";
import { SqlError } from "effect/unstable/sql";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { makeWorkflowRuntime, reconcileWorkflowRuns, workflowRuntimeLayer } from "./runtime";
import { WorkflowStore, type WorkflowRun, type WorkflowRunCursor } from "./store";

const TestWorkflow = Workflow.make({
  name: "example.v1",
  payload: Schema.Struct({ value: Schema.String }),
  idempotencyKey: ({ value }) => value,
});

const stuckRun: WorkflowRun = {
  runId: "run-1",
  workflowName: TestWorkflow.name,
  definitionVersion: "1",
  executionId: "execution-1",
  status: "running",
  result: null,
  error: null,
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

type MarkedRun = {
  readonly runId: string;
  readonly status: string;
  readonly error: unknown;
};

type PollMethod = WorkflowEngine.WorkflowEngine["Service"]["poll"];
type MarkRunMethod = WorkflowStore["Service"]["markRun"];
type ListRunsMethod = WorkflowStore["Service"]["listRuns"];

interface StoreOverrides {
  readonly listRuns?: ListRunsMethod | undefined;
  readonly markRun?: MarkRunMethod | undefined;
}

const runReconcile = (
  poll: PollMethod,
  marked: Ref.Ref<ReadonlyArray<MarkedRun>>,
  overrides: StoreOverrides = {},
  cursor?: Ref.Ref<WorkflowRunCursor | undefined>,
) => {
  const engineLayer = Layer.mock(WorkflowEngine.WorkflowEngine)({ poll });
  const storeLayer = Layer.mock(WorkflowStore)({
    listRuns: overrides.listRuns ?? (() => Effect.succeed([stuckRun])),
    markRun:
      overrides.markRun ??
      ((runId, status, details) =>
        Ref.update(marked, (current) => [...current, { runId, status, error: details?.error }])),
  });

  return reconcileWorkflowRuns({ cursor }).pipe(
    Effect.provide(workflowRuntimeLayer({ workflows: [TestWorkflow] })),
    Effect.provide(engineLayer),
    Effect.provide(storeLayer),
  );
};

const expectMarkedFailed = (marks: ReadonlyArray<MarkedRun>, message: string) => {
  expect(marks).toHaveLength(1);
  expect(marks[0]?.runId).toBe("run-1");
  expect(marks[0]?.status).toBe("failed");
  const error = Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(
    marks[0]?.error,
  );
  expect(error.message).toContain(message);
};

it("rejects duplicate workflow registrations", () => {
  expect(() => makeWorkflowRuntime({ workflows: [TestWorkflow, TestWorkflow] })).toThrow(
    "Duplicate workflow registration: example.v1",
  );
});

layer(Layer.empty)("reconcileWorkflowRuns", (it) => {
  it.effect("marks the run failed when persisted execution state cannot be decoded", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const poll: PollMethod = () =>
        Effect.orDie(
          Effect.fail(
            new ClusterError.MalformedMessage({
              cause: new Error("legacy defect serialization"),
            }),
          ),
        );

      yield* runReconcile(poll, marked);

      expectMarkedFailed(yield* Ref.get(marked), "could not be decoded");
    }),
  );

  it.effect("does not mark the run for other poll failures", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const poll: PollMethod = () => Effect.die(new Error("transient storage outage"));

      yield* runReconcile(poll, marked);

      expect(yield* Ref.get(marked)).toHaveLength(0);
    }),
  );

  it.effect("recovers from a failure to mark an undecodable run as failed", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const poll: PollMethod = () =>
        Effect.orDie(
          Effect.fail(
            new ClusterError.MalformedMessage({
              cause: new Error("legacy defect serialization"),
            }),
          ),
        );
      const markError = new SqlError.SqlError({
        reason: new SqlError.UnknownError({
          cause: new Error("workflow store unavailable"),
          message: "workflow store unavailable",
          operation: "mark workflow run",
        }),
      });
      const attempts = yield* Ref.make(0);

      const listed = yield* runReconcile(poll, marked, {
        markRun: () =>
          Ref.update(attempts, (count) => count + 1).pipe(Effect.andThen(Effect.fail(markError))),
      });

      expect(listed).toBe(1);
      expect(yield* Ref.get(attempts)).toBe(1);
      expect(yield* Ref.get(marked)).toHaveLength(0);
    }),
  );

  it.effect("returns zero when listing workflow runs fails", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const poll: PollMethod = () => Effect.succeedNone;
      const listError = new SqlError.SqlError({
        reason: new SqlError.UnknownError({
          cause: new Error("workflow store unavailable"),
          message: "workflow store unavailable",
          operation: "list workflow runs",
        }),
      });

      const result = yield* runReconcile(poll, marked, {
        listRuns: () => Effect.fail(listError),
      });

      expect(result).toBe(0);
      expect(yield* Ref.get(marked)).toHaveLength(0);
    }),
  );

  it.effect("propagates interruption while reconciling a run", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const exit = yield* Effect.exit(runReconcile(() => Effect.interrupt, marked));

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(yield* Ref.get(marked)).toHaveLength(0);
    }),
  );

  it.effect("propagates interruption while marking an undecodable run failed", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const poll: PollMethod = () =>
        Effect.orDie(
          Effect.fail(
            new ClusterError.MalformedMessage({
              cause: new Error("legacy defect serialization"),
            }),
          ),
        );
      const exit = yield* Effect.exit(
        runReconcile(poll, marked, { markRun: () => Effect.interrupt }),
      );

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(yield* Ref.get(marked)).toHaveLength(0);
    }),
  );

  it.effect("propagates interruption while listing runs", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const exit = yield* Effect.exit(
        runReconcile(() => Effect.succeedNone, marked, {
          listRuns: () => Effect.interrupt,
        }),
      );

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(yield* Ref.get(marked)).toHaveLength(0);
    }),
  );

  it.effect("advances and wraps its reconciliation cursor", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const cursors = yield* Ref.make<ReadonlyArray<WorkflowRunCursor | undefined>>([]);
      const cursor = yield* Ref.make<WorkflowRunCursor | undefined>(undefined);
      const program = runReconcile(
        () => Effect.succeedNone,
        marked,
        {
          listRuns: (_, __, currentCursor) =>
            Ref.update(cursors, (current) => [...current, currentCursor]).pipe(
              Effect.as(Predicate.isUndefined(currentCursor) ? [stuckRun] : []),
            ),
        },
        cursor,
      );

      expect(yield* program).toBe(1);
      expect(yield* program).toBe(0);
      expect(yield* program).toBe(1);
      expect(yield* Ref.get(cursors)).toEqual([
        undefined,
        { runId: stuckRun.runId, updatedAt: stuckRun.updatedAt },
        undefined,
      ]);
    }),
  );
});
