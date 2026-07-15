import { Effect, Option } from "effect";

export const requireSome = <A, E, R>(
  value: Option.Option<A>,
  onNone: () => Effect.Effect<never, E, R>,
): Effect.Effect<A, E, R> =>
  Option.match(value, {
    onSome: Effect.succeed,
    onNone,
  });
