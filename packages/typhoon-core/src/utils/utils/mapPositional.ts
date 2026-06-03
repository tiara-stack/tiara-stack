import { Array, Effect, HashMap, pipe, Tuple } from "effect";

export const hashMapPositional =
  <In, Out, E, R>(f: (a: ReadonlyArray<In>) => Effect.Effect<ReadonlyArray<Out>, E, R>) =>
  <T extends HashMap.HashMap<unknown, In>>(
    map: T,
  ): Effect.Effect<HashMap.HashMap<HashMap.HashMap.Key<T>, Out>, E, R> =>
    pipe(
      Effect.Do,
      Effect.let("entries", () => HashMap.toEntries(map)),
      Effect.let("keys", ({ entries }) => pipe(entries, Array.map(Tuple.get(0)))),
      Effect.let("values", ({ entries }) => pipe(entries, Array.map(Tuple.get(1)))),
      Effect.bind("resultValues", ({ values }) => f(values)),
      Effect.map(
        ({ keys, resultValues }) =>
          pipe(Array.zip(keys, resultValues), HashMap.fromIterable) as HashMap.HashMap<
            HashMap.HashMap.Key<T>,
            Out
          >,
      ),
    );
