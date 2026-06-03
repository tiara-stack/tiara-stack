import { Duration, Effect, Layer, Schedule } from "effect";
import { randomUUID } from "node:crypto";
import { config } from "@/config";
import { isClusterRunnerReady } from "@/services";
import { SmokeWorkflow } from "@/workflows/smoke";

const waitForRunner = isClusterRunnerReady.pipe(
  Effect.repeat({
    while: (ready) => !ready,
    schedule: Schedule.spaced(Duration.seconds(2)),
  }),
);

export const smokeWorkflowTaskLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const enabled = yield* config.workflowsSmokeWorkflowEnabled;
    if (!enabled) {
      return;
    }

    yield* Effect.gen(function* () {
      yield* waitForRunner;
      const runId = yield* Effect.sync(() => randomUUID());
      const result = yield* SmokeWorkflow.execute({ message: "k3d-smoke", runId });
      yield* Effect.logInfo("Ran sheet-workflows smoke workflow", result);
    }).pipe(Effect.withSpan("sheet-workflows.task.smokeWorkflow"), Effect.forkScoped);
  }),
);
