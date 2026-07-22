import { Schema, Struct } from "effect";

interface StructGetter<S extends object> extends Struct.Lambda {
  <Key extends keyof S>(key: Key): S[Key];
  readonly "~lambda.out": this["~lambda.in"] extends keyof S ? S[this["~lambda.in"]] : never;
}

export const structGetter = <S extends object>(struct: S) =>
  Struct.lambda<StructGetter<S>>((key) => Struct.get(struct, key));

type ReadonlyTupleOf_<
  T,
  N extends number,
  R extends ReadonlyArray<unknown>,
> = `${N}` extends `-${number}`
  ? never
  : R["length"] extends N
    ? R
    : ReadonlyTupleOf_<T, N, [T, ...R]>;

export type ReadonlyTupleOf<N extends number, T> = N extends N
  ? number extends N
    ? ReadonlyArray<T>
    : ReadonlyTupleOf_<T, N, []>
  : never;

type StructSchemaHelper<
  A extends ReadonlyArray<string>,
  B extends ReadonlyArray<Schema.Top>,
> = A extends readonly [infer AHead extends string, ...infer ATail extends ReadonlyArray<string>]
  ? B extends readonly [
      infer BHead extends Schema.Top,
      ...infer BTail extends ReadonlyArray<Schema.Top>,
    ]
    ? { [K in AHead]: BHead } & StructSchemaHelper<ATail, BTail>
    : {}
  : {};

export type StructSchema<
  Keys extends ReadonlyArray<string>,
  Fields extends ReadonlyArray<Schema.Top>,
> = StructSchemaHelper<Keys, Fields>;

export type TupleFieldsSchema<Fields extends ReadonlyArray<Schema.Top>> = Fields extends readonly [
  infer Head extends Schema.Top,
  ...infer Tail extends ReadonlyArray<Schema.Top>,
]
  ? [Schema.toEncoded<Head>, ...TupleFieldsSchema<Tail>]
  : [];

export type EncodedTupleFields<Fields extends ReadonlyArray<Schema.Top>> = Fields extends readonly [
  infer Head extends Schema.Top,
  ...infer Tail extends ReadonlyArray<Schema.Top>,
]
  ? [Schema.Codec.Encoded<Head>, ...EncodedTupleFields<Tail>]
  : [];

export type StructValueSchema<Keys extends ReadonlyArray<string>, Value extends Schema.Top> = {
  [K in Keys[number]]: Value;
};

export type TupleValuesSchema<
  Keys extends ReadonlyArray<string>,
  Value extends Schema.Top,
> = ReadonlyTupleOf<Keys["length"], Schema.toEncoded<Value>>;
