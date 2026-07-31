import { Cause, Context, Duration, Effect, Layer, Option } from "effect";
import type { WorkflowCommand, WorkflowJson } from "./store";
import { WorkflowStore } from "./store";

export interface WorkflowCommandExecutorService {
  readonly execute: (command: WorkflowCommand) => Effect.Effect<void, unknown>;
}

export class WorkflowCommandExecutor extends Context.Service<
  WorkflowCommandExecutor,
  WorkflowCommandExecutorService
>()("effect-zero/workflow/WorkflowCommandExecutor") {}

export const workflowCommandExecutorLayer = (
  execute: WorkflowCommandExecutorService["execute"],
): Layer.Layer<WorkflowCommandExecutor> => Layer.succeed(WorkflowCommandExecutor, { execute });

export type WorkflowDispatcherOptions = {
  readonly workerId?: string | undefined;
  readonly batchSize?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly retryDelay?: ((attempt: number) => Duration.Input) | undefined;
  readonly pollInterval?: Duration.Input | undefined;
};

const errorJson = (cause: Cause.Cause<unknown>): WorkflowJson => {
  const error = Cause.findErrorOption(cause);
  return {
    message: Option.isSome(error) ? String(error.value) : Cause.pretty(cause),
  };
};

export const dispatchWorkflowCommandBatch = (
  options: WorkflowDispatcherOptions = {},
): Effect.Effect<number, never, WorkflowStore | WorkflowCommandExecutor> =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const executor = yield* WorkflowCommandExecutor;
    const commands = yield* store
      .claim(options.batchSize ?? 25, options.workerId ?? "workflow-dispatcher")
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Failed to claim workflow commands", cause).pipe(Effect.as([])),
        ),
      );

    yield* Effect.forEach(
      commands,
      (command) =>
        executor.execute(command).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => {
              const error = errorJson(cause);
              const maxAttempts = options.maxAttempts ?? command.maxAttempts;
              return command.attempts >= maxAttempts
                ? store.failCommand(command, error).pipe(
                    Effect.flatMap((settled) =>
                      settled
                        ? store.markRun(command.runId, "failed", { error })
                        : Effect.logWarning("Ignored stale workflow failure").pipe(
                            Effect.annotateLogs({
                              commandId: command.commandId,
                              leaseToken: command.leaseToken,
                            }),
                          ),
                    ),
                  )
                : store
                    .retryCommand(
                      command,
                      options.retryDelay?.(command.attempts) ??
                        Duration.seconds(Math.min(2 ** command.attempts, 300)),
                      error,
                    )
                    .pipe(
                      Effect.flatMap((settled) =>
                        settled
                          ? Effect.void
                          : Effect.logWarning("Ignored stale workflow retry").pipe(
                              Effect.annotateLogs({
                                commandId: command.commandId,
                                leaseToken: command.leaseToken,
                              }),
                            ),
                      ),
                    );
            },
            onSuccess: () =>
              store.markCommandDelivered(command).pipe(
                Effect.flatMap((settled) =>
                  settled
                    ? Effect.void
                    : Effect.logWarning("Ignored stale workflow delivery").pipe(
                        Effect.annotateLogs({
                          commandId: command.commandId,
                          leaseToken: command.leaseToken,
                        }),
                      ),
                ),
              ),
          }),
          Effect.catchCause((cause) =>
            Effect.logError("Failed to persist workflow command delivery", cause).pipe(
              Effect.annotateLogs({
                commandId: command.commandId,
                runId: command.runId,
              }),
            ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
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
