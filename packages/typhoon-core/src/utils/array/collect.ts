import { Array, Function, HashMap, Option, Struct, Tuple } from "effect";

const toHashMap =
  <A, B, K>({
    keyGetter,
    valueInitializer,
    valueReducer,
  }: {
    keyGetter: (a: A) => K;
    valueInitializer: (a: A) => B;
    valueReducer: (b: NoInfer<B>, a: NoInfer<A>) => NoInfer<B>;
  }) =>
  (a: ReadonlyArray<A>): HashMap.HashMap<K, B> =>
    Array.reduce(a, HashMap.empty<K, B>(), (acc, v) =>
      HashMap.modifyAt(
        acc,
        keyGetter(v),
        Option.match({
          onSome: (mapValue) => Option.some(valueReducer(mapValue, v)),
          onNone: () => Option.some(valueInitializer(v)),
        }),
      ),
    );

const toHashMapByKeyWith =
  <const K extends string | symbol, A extends { [P in K]?: any }, B>({
    key,
    valueInitializer,
    valueReducer,
  }: {
    key: K;
    valueInitializer: (a: A) => B;
    valueReducer: (b: NoInfer<B>, a: NoInfer<A>) => NoInfer<B>;
  }) =>
  (a: ReadonlyArray<A>): HashMap.HashMap<A[K], B> =>
    toHashMap<A, B, A[K]>({
      keyGetter: Struct.get(key),
      valueInitializer: valueInitializer,
      valueReducer: valueReducer,
    })(a);

export const toHashMapByKey =
  <const K extends string | symbol>(key: K) =>
  <A extends { [P in K]?: any }>(a: ReadonlyArray<A>): HashMap.HashMap<A[K], A> =>
    toHashMapByKeyWith<K, A, A>({
      key,
      valueInitializer: Function.identity,
      valueReducer: Function.untupled(Tuple.get(1)),
    })(a);
