import { DateTime, Effect, Option, Match } from "effect";
import { use, useMemo } from "react";

export const makeZoned = (timeZone: DateTime.TimeZone, timestamp?: number) =>
  Option.fromNullable(timestamp).pipe(
    Option.flatMap(DateTime.make),
    Option.match({
      onSome: Effect.succeed,
      onNone: () => DateTime.now,
    }),
    Effect.map(DateTime.setZone(timeZone)),
  );

export const zoneId = (timeZone: DateTime.TimeZone) =>
  Match.value(timeZone).pipe(
    Match.tagsExhaustive({
      Offset: ({ offset }) => offset,
      Named: ({ id }) => id,
    }),
  );

export const useZoned = (timeZone: DateTime.TimeZone, timestamp?: number) => {
  const promise = useMemo(() => makeZoned(timeZone, timestamp), [zoneId(timeZone), timestamp]);
  return use(Effect.runPromise(promise));
};
