import { Array, Option, pipe, Schema, SchemaGetter } from "effect";

type ReadonlyTupleOf_<
  T,
  N extends number,
  R extends ReadonlyArray<unknown>,
> = `${N}` extends `-${number}`
  ? never
  : R["length"] extends N
    ? R
    : ReadonlyTupleOf_<T, N, [T, ...R]>;
type ReadonlyTupleOf<N extends number, T> = N extends N
  ? number extends N
    ? ReadonlyArray<T>
    : ReadonlyTupleOf_<T, N, []>
  : never;

type OptionArrayToOptionTupleSchema<Count extends number, Value extends Schema.Top> = Schema.Codec<
  ReadonlyTupleOf<Count, Option.Option<Schema.Schema.Type<Value>>>,
  ReadonlyArray<Option.Option<Schema.Codec.Encoded<Value>>>,
  Schema.Codec.DecodingServices<Value>,
  Schema.Codec.EncodingServices<Value>
> & {
  readonly count: Count;
  readonly value: Value;
};

export const OptionArrayToOptionTupleSchema = <
  const Count extends number,
  const Value extends Schema.Top,
>(
  count: Count,
  value: Value,
) => {
  const ArraySchema = Schema.Array(Schema.Option(Schema.toEncoded(value)));
  const TupleSchema = Schema.Tuple(
    Array.makeBy(count, () =>
      Schema.Option(value),
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as ReadonlyTupleOf<
      Count,
      Schema.Option<Value>
    > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
  );

  const schema = ArraySchema.pipe(
    Schema.decodeTo(TupleSchema, {
      decode: SchemaGetter.transform(
        (array) =>
          Array.makeBy(count, (index) =>
            pipe(Array.get(array, index), Option.flatten),
          ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Schema.Tuple.Encoded<
            ReadonlyTupleOf<Count, Schema.Option<Value>>
          > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      ),
      encode: SchemaGetter.passthrough(),
    }),
  ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as OptionArrayToOptionTupleSchema<
    Count,
    Value
  > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

  return Object.assign(schema, { count, value });
};
