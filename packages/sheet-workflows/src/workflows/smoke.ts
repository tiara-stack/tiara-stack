import { Effect, Schema } from "effect";
import { ClusterSchema } from "effect/unstable/cluster";
import { Activity, Workflow } from "effect/unstable/workflow";

const SmokeWorkflowPayload = Schema.Struct({
  message: Schema.String,
  runId: Schema.String,
});

type SmokeWorkflowPayload = Schema.Schema.Type<typeof SmokeWorkflowPayload>;

const SmokeWorkflowResult = Schema.Struct({
  message: Schema.String,
  runId: Schema.String,
  executionId: Schema.String,
});

type SmokeWorkflowResult = Schema.Schema.Type<typeof SmokeWorkflowResult>;

export const SmokeWorkflow = Workflow.make({
  name: "smoke.echo",
  payload: SmokeWorkflowPayload,
  success: SmokeWorkflowResult,
  error: Schema.Unknown,
  idempotencyKey: ({ message, runId }) => `smoke:${message}:${runId}`,
}).annotate(ClusterSchema.ShardGroup, () => "dispatch");

export const smokeWorkflowLayer = SmokeWorkflow.toLayer(
  Effect.fn("SmokeWorkflow.handler")(function* (payload, executionId) {
    return yield* Activity.make({
      name: `smoke.echo.${executionId}.execute`,
      success: SmokeWorkflowResult,
      error: SmokeWorkflow.errorSchema,
      execute: Effect.succeed({
        message: payload.message,
        runId: payload.runId,
        executionId,
      }).pipe(
        Effect.tap((result) => Effect.logInfo("Completed sheet-workflows smoke workflow", result)),
      ),
    });
  }),
);
