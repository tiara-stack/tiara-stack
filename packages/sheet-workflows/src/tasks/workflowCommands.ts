import { Config, Duration, Effect, Layer, Ref, Schedule } from "effect";
import {
  runWorkflowCommandDispatcher,
  type WorkflowDispatcherOptions,
  type WorkflowRunCursor,
} from "effect-zero-workflow";
import {
  reconcileDispatchWorkflowRuns,
  workflowCommandExecutorLayer,
} from "@/services/workflowCommands";

const dispatcherOptions = {
  batchSize: 25,
  maxAttempts: 10,
  pollInterval: Duration.seconds(1),
  retryDelay: (attempt) => Duration.seconds(Math.min(2 ** attempt, 300)),
} satisfies WorkflowDispatcherOptions;

const reconciliationSchedule = Schedule.spaced(Duration.seconds(2));

export const workflowCommandTaskLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const workerId = yield* Config.string("HOSTNAME").pipe(Config.withDefault("sheet-workflows"));
    yield* runWorkflowCommandDispatcher({ ...dispatcherOptions, workerId }).pipe(
      Effect.withSpan("sheet-workflows.task.workflowCommandDispatcher"),
      Effect.forkScoped,
    );
    const reconciliationCursor = yield* Ref.make<WorkflowRunCursor | undefined>(undefined);
    yield* reconcileDispatchWorkflowRuns(reconciliationCursor).pipe(
      Effect.repeat({ schedule: reconciliationSchedule }),
      Effect.withSpan("sheet-workflows.task.workflowRunReconciler"),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provide(workflowCommandExecutorLayer));
