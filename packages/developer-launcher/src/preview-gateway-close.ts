import { type Cause, Clock, Deferred, Duration, Effect, Option, Semaphore } from "effect";

export interface RetryableConnectionFenceAttempt<EClose> {
  readonly closeStageRemainingMs: () => Effect.Effect<number>;
  readonly getCloseCause: () => Cause.Cause<EClose> | undefined;
  readonly setCloseCause: (cause: Cause.Cause<EClose>) => void;
}

/** Retryable close fence; one deadline covers permit wait, adapter close, and durable removal. */
export const makeRetryableConnectionFence = <E, E2 = never, EClose = never>(
  close: (attempt: RetryableConnectionFenceAttempt<EClose>) => Effect.Effect<void, EClose>,
  closed: Deferred.Deferred<void>,
  timeoutError: (attempt: RetryableConnectionFenceAttempt<EClose>) => Effect.Effect<never, E>,
  persistClose: Effect.Effect<void, E2> = Effect.void,
): Effect.Effect<void, E | E2 | EClose> => {
  const closeSemaphore = Semaphore.makeUnsafe(1);
  let closeConfirmed = false;
  return Effect.gen(function* () {
    const startedAtMs = yield* Clock.currentTimeMillis;
    const closeStageDeadlineMs = startedAtMs + 2_500;
    const attemptDeadlineMs = startedAtMs + 5_000;
    let closeCause: Cause.Cause<EClose> | undefined;
    const attempt: RetryableConnectionFenceAttempt<EClose> = {
      closeStageRemainingMs: () =>
        Clock.currentTimeMillis.pipe(Effect.map((now) => Math.max(0, closeStageDeadlineMs - now))),
      getCloseCause: () => closeCause,
      setCloseCause: (cause) => {
        closeCause = cause;
      },
    };
    const closeAttempt = closeSemaphore.withPermit(
      Effect.gen(function* () {
        if (!closeConfirmed) {
          yield* close(attempt).pipe(Effect.interruptible);
          closeConfirmed = true;
        }
        yield* persistClose.pipe(Effect.interruptible);
      }),
    );
    const attemptRemainingMs = yield* Clock.currentTimeMillis.pipe(
      Effect.map((now) => Math.max(0, attemptDeadlineMs - now)),
    );
    const closeConnection = Deferred.succeed(closed, undefined).pipe(
      Effect.andThen(closeAttempt),
      Effect.interruptible,
      Effect.timeoutOption(Duration.millis(attemptRemainingMs)),
      Effect.flatMap(
        Option.match({
          onNone: () => timeoutError(attempt),
          onSome: () => Effect.void,
        }),
      ),
    );
    return yield* closeConnection;
  });
};
