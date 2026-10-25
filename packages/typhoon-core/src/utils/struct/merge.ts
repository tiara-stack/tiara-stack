import { Array, pipe } from "effect";

type Merge<S extends Array.NonEmptyReadonlyArray<object>> = S extends readonly [
  infer A extends object,
  ...infer Rest extends Array.NonEmptyReadonlyArray<object>,
]
  ? A & Merge<Rest>
  : S extends readonly [infer A extends object]
    ? A
    : never;

export const merge = <const S extends Array.NonEmptyReadonlyArray<object>>(objects: S) =>
  pipe(
    Array.tailNonEmpty(objects),
    Array.match({
      onEmpty: () => Array.headNonEmpty(objects),
      onNonEmpty: (tail): object => ({
        ...Array.headNonEmpty(objects),
        ...(merge(tail) as object),
      }),
    }),
  ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Merge<S> /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
