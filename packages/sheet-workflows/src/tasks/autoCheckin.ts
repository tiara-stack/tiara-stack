import { Cause, Cron, DateTime, Duration, Effect, Layer, Schedule } from "effect";
import {
  canonicalScheduledHourBucket,
  AutoCheckinSweepWorkflow,
  AutoRoleCleanupSweepWorkflow,
} from "@/workflows/autoCheckinContract";
import { AutonomousTriggerWorkflowClient } from "@/services";

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

export const autoCheckinTaskLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const workflowClient = yield* AutonomousTriggerWorkflowClient;
    const autoCheckinTask = makeScheduledTask({
      effectName: "autoCheckinTask",
      task: "autoCheckin",
      successMessage: "enqueued automatic check-in sweep",
      failureMessage: "automatic check-in sweep enqueue failed",
      enqueue: workflowClient.enqueueAutoCheckinSweep,
    });
    const autoRoleCleanupTask = makeScheduledTask({
      effectName: "autoRoleCleanupTask",
      task: "autoRoleCleanup",
      successMessage: "enqueued automatic role-cleanup sweep",
      failureMessage: "automatic role-cleanup sweep enqueue failed",
      enqueue: workflowClient.enqueueAutoRoleCleanupSweep,
    });

    yield* autoCheckinTask().pipe(
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
    yield* autoRoleCleanupTask().pipe(
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
