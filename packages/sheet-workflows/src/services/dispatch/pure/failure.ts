import { Cause, Effect } from "effect";

export const recoverNonInterruptCause = <A, E, E2, R>(
  cause: Cause.Cause<E>,
  recover: (cause: Cause.Cause<E>) => Effect.Effect<A, E2, R>,
): Effect.Effect<A, E | E2, R> =>
  Cause.hasInterrupts(cause) || Cause.hasDies(cause) ? Effect.failCause(cause) : recover(cause);
