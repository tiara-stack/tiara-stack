import { Cause, Cron, DateTime, Duration, Effect, Layer, Schedule } from "effect";
import {
  canonicalScheduledHourBucket,
  AutoCheckinSweepWorkflow,
  AutoRoleCleanupSweepWorkflow,
} from "@/workflows/autoCheckinContract";
import { AutonomousTriggerWorkflowClient } from "@/services";
import { sheetWorkflowsRuntimePolicy } from "@/config/runtimePolicy";
import { selectAutonomousTriggerSelection } from "@/workflows/autonomousTriggerLayer";

const currentHourBucket = DateTime.now.pipe(
  Effect.map(DateTime.toEpochMillis),
  Effect.map(canonicalScheduledHourBucket),
);

const scheduledEnqueueTimeout = Duration.seconds(30);

const recoverScheduledEnqueueFailure = (message: string, cause: Cause.Cause<unknown>) =>
  Cause.hasInterrupts(cause)
    ? Effect.failCause(cause)
    : Effect.logWarning(message).pipe(Effect.annotateLogs({ cause }));

const makeScheduledTask = (options: {
  readonly effectName: string;
  readonly task: string;
  readonly successMessage: string;
  readonly failureMessage: string;
  readonly enqueue: (scheduledHourBucketEpochMs: number) => Effect.Effect<unknown, unknown>;
}) =>
  Effect.fn(options.effectName, { attributes: { task: options.task } })(function* () {
    const scheduledHourBucketEpochMs = yield* currentHourBucket;
    yield* Effect.annotateCurrentSpan({ scheduledHourBucketEpochMs });
    yield* options.enqueue(scheduledHourBucketEpochMs).pipe(
      Effect.timeout(scheduledEnqueueTimeout),
      Effect.tap(() => Effect.log(options.successMessage)),
      Effect.catchCause((cause) => recoverScheduledEnqueueFailure(options.failureMessage, cause)),
    );
  });

const autoCheckinTask = Layer.effectDiscard(
  Effect.gen(function* () {
    const workflowClient = yield* AutonomousTriggerWorkflowClient;
    const task = makeScheduledTask({
      effectName: "autoCheckinTask",
      task: "autoCheckin",
      successMessage: "enqueued automatic check-in sweep",
      failureMessage: "automatic check-in sweep enqueue failed",
      enqueue: workflowClient.enqueueAutoCheckinSweep,
    });
    yield* task().pipe(
      Effect.annotateLogs({ task: "autoCheckin" }),
      Effect.withSpan("sheet-workflows.task.autoCheckin", {
        attributes: { task: "autoCheckin", workflow: AutoCheckinSweepWorkflow.name },
      }),
      Effect.schedule(
        Schedule.cron(
          Cron.make({
            seconds: [0],
            minutes: [45],
            hours: [],
            days: [],
            months: [],
            weekdays: [],
          }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provide(AutonomousTriggerWorkflowClient.layer));

const autoRoleCleanupTask = Layer.effectDiscard(
  Effect.gen(function* () {
    const workflowClient = yield* AutonomousTriggerWorkflowClient;
    const task = makeScheduledTask({
      effectName: "autoRoleCleanupTask",
      task: "autoRoleCleanup",
      successMessage: "enqueued automatic role-cleanup sweep",
      failureMessage: "automatic role-cleanup sweep enqueue failed",
      enqueue: workflowClient.enqueueAutoRoleCleanupSweep,
    });

    yield* task().pipe(
      Effect.annotateLogs({ task: "autoRoleCleanup" }),
      Effect.withSpan("sheet-workflows.task.autoRoleCleanup", {
        attributes: { task: "autoRoleCleanup", workflow: AutoRoleCleanupSweepWorkflow.name },
      }),
      Effect.schedule(
        Schedule.cron(
          Cron.make({
            seconds: [0],
            minutes: [15],
            hours: [],
            days: [],
            months: [],
            weekdays: [],
          }),
        ),
      ),
      Effect.forkScoped,
    );
  }),
).pipe(Layer.provide(AutonomousTriggerWorkflowClient.layer));

export const autoCheckinTaskLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { autonomousTriggerNames: triggerNames } = yield* sheetWorkflowsRuntimePolicy;
    const taskLayers = {
      all: Layer.merge(autoCheckinTask, autoRoleCleanupTask),
      autoCheckin: autoCheckinTask,
      autoRoleCleanup: autoRoleCleanupTask,
      none: Layer.empty,
    };
    return taskLayers[selectAutonomousTriggerSelection(triggerNames)];
  }),
);
