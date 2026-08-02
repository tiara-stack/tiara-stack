import { Cause, Context, Duration, Effect, Layer, Option, Predicate, Schema } from "effect";
import type { WorkflowCommand, WorkflowJson } from "./store";
import { WorkflowStore } from "./store";

export interface WorkflowCommandExecutorService {
  readonly execute: (command: WorkflowCommand) => Effect.Effect<void, unknown>;
}

export class WorkflowCommandExecutor extends Context.Service<
  WorkflowCommandExecutor,
  WorkflowCommandExecutorService
>()("effect-zero-workflow/WorkflowCommandExecutor") {}

export const workflowCommandExecutorLayer = (
  execute: WorkflowCommandExecutorService["execute"],
): Layer.Layer<WorkflowCommandExecutor> => Layer.succeed(WorkflowCommandExecutor, { execute });

export type WorkflowDispatcherOptions = {
  readonly workerId?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly concurrency?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly retryDelay?: ((attempt: number) => Duration.Input) | undefined;
  readonly pollInterval?: Duration.Input | undefined;
};

const errorJson = (cause: Cause.Cause<unknown>): WorkflowJson => {
  const error = Cause.findErrorOption(cause);
  const message = Option.match(error, {
    onNone: () => Cause.pretty(cause),
    onSome: (value) =>
      Predicate.isError(value)
        ? value.message
        : Option.match(Schema.decodeUnknownOption(Schema.Json)(value), {
            onNone: () => Cause.pretty(cause),
            onSome: (json) => (Predicate.isString(json) ? json : JSON.stringify(json)),
          }),
  });
  return {
    message,
  };
};

const logIfStale = (settled: boolean, message: string, command: WorkflowCommand) =>
  settled
    ? Effect.void
    : Effect.logWarning(message).pipe(
        Effect.annotateLogs({
          commandId: command.commandId,
          leaseToken: command.leaseToken,
        }),
      );

const defaultRetryDelay = (attempt: number): Duration.Duration => {
  const cappedExponentialSeconds = Math.min(2 ** attempt, 300);
  const jitterFactor = 0.5 + Math.random() * 0.5;
  return Duration.seconds(cappedExponentialSeconds * jitterFactor);
};

export const dispatchWorkflowCommandBatch = (
  options: WorkflowDispatcherOptions = {},
): Effect.Effect<number, never, WorkflowStore | WorkflowCommandExecutor> =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const executor = yield* WorkflowCommandExecutor;
    const requestedBatchSize = options.batchSize;
    const batchSize =
      Predicate.isUndefined(requestedBatchSize) || !Number.isFinite(requestedBatchSize)
        ? 25
        : Math.max(1, Math.trunc(requestedBatchSize));
    const requestedConcurrency = options.concurrency;
    const concurrency =
      Predicate.isUndefined(requestedConcurrency) || !Number.isFinite(requestedConcurrency)
        ? Math.min(batchSize, 25)
        : Math.min(100, Math.max(1, Math.trunc(requestedConcurrency)));
    const commands = yield* store
      .claim(batchSize, options.workerId ?? "workflow-dispatcher")
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logError("Failed to claim workflow commands", cause).pipe(Effect.as([])),
        ),
      );

    yield* Effect.forEach(
      commands,
      (command) =>
        executor.execute(command).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => {
              if (Cause.hasInterrupts(cause)) {
                return Effect.interrupt;
              }
              const error = errorJson(cause);
              const maxAttempts = Math.min(
                command.maxAttempts,
                Predicate.isUndefined(options.maxAttempts) || !Number.isFinite(options.maxAttempts)
                  ? command.maxAttempts
                  : Math.max(1, Math.trunc(options.maxAttempts)),
              );
              return command.attempts >= maxAttempts
                ? store
                    .failCommand(command, error)
                    .pipe(
                      Effect.flatMap((settled) =>
                        logIfStale(settled, "Ignored stale workflow failure", command),
                      ),
                    )
                : store
                    .retryCommand(
                      command,
                      options.retryDelay?.(command.attempts) ?? defaultRetryDelay(command.attempts),
                      error,
                    )
                    .pipe(
                      Effect.flatMap((settled) =>
                        logIfStale(settled, "Ignored stale workflow retry", command),
                      ),
                    );
            },
            onSuccess: () =>
              store
                .markCommandDelivered(command)
                .pipe(
                  Effect.flatMap((settled) =>
                    logIfStale(settled, "Ignored stale workflow delivery", command),
                  ),
                ),
          }),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logError("Failed to persist workflow command delivery", cause).pipe(
                  Effect.annotateLogs({
                    commandId: command.commandId,
                    runId: command.runId,
                  }),
                ),
          ),
        ),
      { concurrency, discard: true },
    );

    return commands.length;
  });

export const runWorkflowCommandDispatcher = (
  options: WorkflowDispatcherOptions = {},
): Effect.Effect<never, never, WorkflowStore | WorkflowCommandExecutor> => {
  const pollInterval = options.pollInterval ?? Duration.seconds(1);
  return dispatchWorkflowCommandBatch(options).pipe(
    Effect.flatMap((dispatched) => (dispatched === 0 ? Effect.sleep(pollInterval) : Effect.void)),
    Effect.forever,
  );
};
