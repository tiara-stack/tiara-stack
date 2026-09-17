import { Duration, Effect, Match, Option, Predicate, Stream } from "effect";

export type TerminalWorkflowRun = { readonly result: { readonly _tag: string } };

const observedTerminalRun = <Run extends TerminalWorkflowRun>(
  get: () => Stream.Stream<Option.Option<Run>, unknown, never>,
) =>
  get().pipe(
    Stream.filter((run): run is Option.Some<Run> => Option.isSome(run)),
    Stream.map((run) => run.value),
    Stream.takeUntil((run) => !Predicate.isTagged("Pending")(run.result)),
  );

export const terminalRunFromSubscription = <Run extends TerminalWorkflowRun>(
  get: () => Stream.Stream<Option.Option<Run>, unknown, never>,
  timeout?: Duration.Duration,
): Effect.Effect<Run, unknown> => {
  const terminal = observedTerminalRun(get).pipe(
    Stream.runLast,
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new Error("Workflow observation ended before completion")),
        onSome: (run) =>
          Match.value(run.result).pipe(
            Match.when({ _tag: "Pending" }, () =>
              Effect.fail(new Error("Workflow observation ended before completion")),
            ),
            Match.orElse(() => Effect.succeed(run)),
          ),
      }),
    ),
  );
  return timeout === undefined ? terminal : terminal.pipe(Effect.timeout(timeout));
};
