import { Array, Function, Option, pipe, Struct, Types } from "effect";

type OptionFields<A> = {
  [K in keyof A as A[K] extends Option.Option<any> ? K : never]: A[K] extends Option.Option<any>
    ? A[K]
    : never;
};

type OptionFieldValues<A> = {
  [K in keyof A as A[K] extends Option.Option<any> ? K : never]: A[K] extends Option.Option<any>
    ? Option.Option.Value<A[K]>
    : never;
};

export type GetSomeFields<A, F extends keyof OptionFields<A>> = Option.Option<
  Types.Simplify<Omit<A, F> & Pick<OptionFieldValues<A>, F>>
>;

export const getSomeFields = Function.dual<
  <const A extends object, const F extends keyof OptionFields<A>>(
    fields: Array.NonEmptyReadonlyArray<F>,
  ) => (a: A) => GetSomeFields<A, F>,
  <const A extends object, const F extends keyof OptionFields<A>>(
    a: A,
    fields: Array.NonEmptyReadonlyArray<F>,
  ) => GetSomeFields<A, F>
>(
  2,
  <A extends object, const F extends keyof OptionFields<A>>(
    a: A,
    fields: Array.NonEmptyReadonlyArray<F>,
  ) =>
    pipe(
      Option.all(
        Struct.pick(
          a,
          fields,
        ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Pick<
          OptionFields<A>,
          F
        > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Option.Option<
        Pick<OptionFieldValues<A>, F>
      > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      Option.map((v) => ({ ...a, ...v })),
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as GetSomeFields<
      A,
      F
    > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
);
