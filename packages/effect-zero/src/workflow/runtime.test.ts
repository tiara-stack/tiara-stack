import { Effect, Layer, Ref, Schema } from "effect";
import { expect, layer } from "@effect/vitest";
import { ClusterError } from "effect/unstable/cluster";
import { Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { reconcileWorkflowRuns, workflowRuntimeLayer } from "./runtime";
import { WorkflowStore, type WorkflowRun, type WorkflowStoreService } from "./store";

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

const engineLayerOf = (service: Pick<WorkflowEngine.WorkflowEngine["Service"], "poll">) =>
  Layer.succeed(WorkflowEngine.WorkflowEngine, {
    ...service,
  } as WorkflowEngine.WorkflowEngine["Service"]);

const makeLayer = (poll: PollMethod, marked: Ref.Ref<ReadonlyArray<MarkedRun>>) => {
  const engineLayer = engineLayerOf({ poll });

  const storeLayer = Layer.succeed(WorkflowStore, {
    enqueue: () => Effect.die("unused"),
    enqueueCommand: () => Effect.die("unused"),
    claim: () => Effect.die("unused"),
    getRun: () => Effect.die("unused"),
    listRuns: () => Effect.succeed([stuckRun]),
    markCommandDelivered: () => Effect.die("unused"),
    retryCommand: () => Effect.die("unused"),
    failCommand: () => Effect.die("unused"),
    markRun: (runId, status, details) =>
      Ref.update(marked, (current) => [...current, { runId, status, error: details?.error }]),
  } satisfies WorkflowStoreService);

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
  const error = marks[0]?.error as { message?: unknown };
  expect(String(error?.message)).toContain("could not be decoded");
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

  it.effect("marks the run failed for a typed MalformedMessage poll error", () =>
    Effect.gen(function* () {
      const marked = yield* Ref.make<ReadonlyArray<MarkedRun>>([]);
      // The remote runner path surfaces the decode failure as a typed error
      // instead of a defect. `Effect.fail` cannot be assigned to the
      // defect-only `poll` signature, so fail through the generic effect
      // type and let the reconciler observe the Fail cause.
      const poll: PollMethod = () =>
        Effect.fail<never>(
          new ClusterError.MalformedMessage({
            cause: new Error("legacy reply serialization"),
          }) as never,
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
});
