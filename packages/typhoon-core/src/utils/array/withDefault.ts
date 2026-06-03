import { Array, Data, Result, Option, Order, pipe, Struct, Record } from "effect";

type SimplifyObject<A> = {
  [K in keyof A]: A[K];
} extends infer B extends object
  ? B
  : never;

type ArrayWithDefaultData<S extends ReadonlyArray<unknown>> = {
  array: S;
  default: () => Array.ReadonlyArray.Infer<S>;
};
const ArrayWithDefaultTaggedClass: new <S extends ReadonlyArray<unknown>>(
  args: Readonly<ArrayWithDefaultData<S>>,
) => Readonly<ArrayWithDefaultData<S>> & {
  readonly _tag: "ArrayWithDefault";
} = Data.TaggedClass("ArrayWithDefault");
export class ArrayWithDefault<
  const S extends ReadonlyArray<unknown>,
> extends ArrayWithDefaultTaggedClass<S> {}

export const wrap =
  <S extends ReadonlyArray<unknown>>(options: { default: () => Array.ReadonlyArray.Infer<S> }) =>
  (array: S) =>
    new ArrayWithDefault({
      array,
      default: options.default,
    });

export const wrapEither =
  <S extends ReadonlyArray<Result.Result<unknown, unknown>>>(options: {
    default: () => Result.Result.Success<Array.ReadonlyArray.Infer<S>>;
  }) =>
  (array: S) =>
    new ArrayWithDefault({
      array: pipe(
        array as ReadonlyArray<
          Result.Result<Result.Result.Success<Array.ReadonlyArray.Infer<S>>, unknown>
        >,
        Array.map(Result.getOrElse(options.default)),
      ),
      default: options.default,
    });

export const wrapOption =
  <S extends ReadonlyArray<Option.Option<unknown>>>(options: {
    default: () => Option.Option.Value<Array.ReadonlyArray.Infer<S>>;
  }) =>
  (array: S) =>
    new ArrayWithDefault({
      array: pipe(
        array as ReadonlyArray<Option.Option<Option.Option.Value<Array.ReadonlyArray.Infer<S>>>>,
        Array.map(Option.getOrElse(options.default)),
      ),
      default: options.default,
    });

export type InferArray<A extends ArrayWithDefault<ReadonlyArray<unknown>>> =
  A extends ArrayWithDefault<infer S> ? S : never;
export type Infer<A extends ArrayWithDefault<ReadonlyArray<unknown>>> = Array.ReadonlyArray.Infer<
  InferArray<A>
>;

export const toArray = <S extends ArrayWithDefault<ReadonlyArray<unknown>>>(a: S) =>
  a.array as InferArray<S>;
export const getDefault = <S extends ArrayWithDefault<ReadonlyArray<unknown>>>(a: S) =>
  a.default() as Infer<S>;

export const zip =
  <T extends ArrayWithDefault<ReadonlyArray<object>>>(b: T) =>
  <S extends ArrayWithDefault<ReadonlyArray<object>>>(a: S) => {
    const arrayA = toArray(a);
    const arrayB = toArray(b);

    const maxLength = Order.max(Order.Number)(Array.length(arrayA), Array.length(arrayB));

    return pipe(
      Array.zip(
        Array.appendAll(
          Array.copy(arrayA),
          Array.makeBy(maxLength - Array.length(arrayA), () => getDefault(a)),
        ),
        Array.appendAll(
          Array.copy(arrayB),
          Array.makeBy(maxLength - Array.length(arrayB), () => getDefault(b)),
        ),
      ),
      Array.map(([a, b]) => ({ ...a, ...b }) as Infer<S> & Infer<T>),
      wrap({ default: () => ({ ...getDefault(a), ...getDefault(b) }) }),
    );
  };

export const zipArray =
  <T extends ArrayWithDefault<ReadonlyArray<ReadonlyArray<unknown>>>>(b: T) =>
  <S extends ArrayWithDefault<ReadonlyArray<ReadonlyArray<unknown>>>>(a: S) => {
    const arrayA = toArray(a);
    const arrayB = toArray(b);

    const maxLength = Order.max(Order.Number)(Array.length(arrayA), Array.length(arrayB));

    return pipe(
      Array.zip(
        Array.appendAll(
          Array.copy(arrayA),
          Array.makeBy(maxLength - Array.length(arrayA), () => getDefault(a)),
        ),
        Array.appendAll(
          Array.copy(arrayB),
          Array.makeBy(maxLength - Array.length(arrayB), () => getDefault(b)),
        ),
      ),
      Array.map(([a, b]) => [...a, ...b] as [...Infer<S>, ...Infer<T>]),
      wrap({
        default: () => [...getDefault(a), ...getDefault(b)] as [...Infer<S>, ...Infer<T>],
      }),
    );
  };

export const map =
  <S extends ArrayWithDefault<ReadonlyArray<unknown>>, B>(mapper: (a: Infer<S>) => B) =>
  (a: S) =>
    pipe(
      toArray(a),
      Array.map(mapper),
      wrap({
        default: () =>
          mapper(getDefault(a)) as Array.ReadonlyArray.Infer<
            Array.ReadonlyArray.With<InferArray<S>, B>
          >,
      }),
    );

export const replaceKeysFromHead =
  <
    S extends ArrayWithDefault<ReadonlyArray<object>>,
    Keys extends Array.NonEmptyReadonlyArray<
      {
        [K in keyof Infer<S>]: Infer<S>[K] extends Option.Option<unknown> ? K : never;
      }[keyof Infer<S>] &
        (string | symbol)
    >,
  >(
    ...keys: Keys
  ) =>
  (a: S): S =>
    pipe(
      a,
      zip(
        pipe(
          [] as SimplifyObject<Pick<Infer<S>, Keys[number]>>[],
          wrap({
            default: () =>
              pipe(
                Array.head(toArray(a)) as Option.Option<Infer<S>>,
                Option.map(Struct.pick(keys)),
                (v) =>
                  pipe(
                    keys,
                    Array.map((key) => [key, Option.flatMap(v, Struct.get(key as never))] as const),
                    Record.fromEntries,
                  ),
              ) as SimplifyObject<Pick<Infer<S>, Keys[number]>>,
          }),
        ) as ArrayWithDefault<ReadonlyArray<SimplifyObject<Pick<Infer<S>, Keys[number]>>>>,
      ),
    ) as unknown as S;
