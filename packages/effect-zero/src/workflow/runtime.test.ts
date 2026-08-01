import { Effect, Layer, Ref, Schema } from "effect";
import { expect, layer } from "@effect/vitest";
import { ClusterError } from "effect/unstable/cluster";
import { SqlError } from "effect/unstable/sql";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { reconcileWorkflowRuns, workflowRuntimeLayer } from "./runtime";
import { WorkflowStore, type WorkflowRun } from "./store";

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

const makeLayer = (
  poll: PollMethod,
  marked: Ref.Ref<ReadonlyArray<MarkedRun>>,
  overrides: StoreOverrides = {},
) => {
  const engineLayer = Layer.mock(WorkflowEngine.WorkflowEngine)({ poll });
  const storeLayer = Layer.mock(WorkflowStore)({
    listRuns: overrides.listRuns ?? (() => Effect.succeed([stuckRun])),
    markRun:
      overrides.markRun ??
      ((runId, status, details) =>
        Ref.update(marked, (current) => [...current, { runId, status, error: details?.error }])),
  });

  return reconcileWorkflowRuns().pipe(
    Effect.provide(workflowRuntimeLayer({ workflows: [TestWorkflow] })),
    Effect.provide(engineLayer),
    Effect.provide(storeLayer),
  );
};

const expectMarkedFailed = (marks: ReadonlyArray<MarkedRun>) => {
  expect(marks).toHaveLength(1);
  expect(marks[0]?.runId).toBe("run-1");
  expect(marks[0]?.status).toBe("failed");
  const error = Schema.decodeUnknownSync(Schema.Struct({ message: Schema.String }))(
    marks[0]?.error,
  );
  expect(error.message).toContain("could not be decoded");
};

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

      yield* makeLayer(poll, marked);

      expectMarkedFailed(yield* Ref.get(marked));
    }),
  );

  it.effect("does not mark the run for other poll failures", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      const poll: PollMethod = () => Effect.die(new Error("transient storage outage"));

      yield* makeLayer(poll, marked);

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

      const reconciled = yield* makeLayer(poll, marked, {
        markRun: () => Effect.fail(markError),
      });

      expect(reconciled).toBe(1);
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

      const result = yield* makeLayer(poll, marked, {
        listRuns: () => Effect.fail(listError),
      });

      expect(result).toBe(0);
      expect(yield* Ref.get(marked)).toHaveLength(0);
    }),
  );
});
