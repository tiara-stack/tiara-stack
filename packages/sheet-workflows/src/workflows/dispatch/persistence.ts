import { Cause, Duration, Effect, Schedule, Schema } from "effect";
import { ClusterError } from "effect/unstable/cluster";

const isClusterPersistenceDefect = Schema.is(ClusterError.PersistenceError);

export const isClusterPersistenceCause = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every(
    (reason) => Cause.isDieReason(reason) && isClusterPersistenceDefect(reason.defect),
  );

export const retryClusterPersistenceCause = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  remainingAttempts = 3,
  retryDelay = Duration.millis(250),
): Effect.Effect<A, E, R> => {
  const retrySchedule = Schedule.exponential(retryDelay).pipe(
    Schedule.jittered,
    Schedule.reduce(
      () => 0,
      (retryAttempt) => retryAttempt + 1,
    ),
    Schedule.tapOutput((retryAttempt) =>
      Effect.logWarning("Retrying dispatch workflow activity after cluster persistence error").pipe(
        Effect.annotateLogs({ attemptLimit: remainingAttempts, retryAttempt }),
      ),
    ),
  );

  return effect.pipe(
    // Effect.fail intentionally places the full Cause in the failure value channel
    // so Effect.retry's while predicate can inspect defects and interrupts. The
    // final Effect.catch unwraps that value with Effect.failCause to restore the
    // original failure mode after retry exhaustion.
    Effect.matchCauseEffect({
      onFailure: Effect.fail,
      onSuccess: Effect.succeed,
    }),
    Effect.retry({
      schedule: retrySchedule,
      times: Math.max(remainingAttempts - 1, 0),
      while: isClusterPersistenceCause,
    }),
    Effect.catch((cause) => Effect.failCause(cause)),
  );
};
