import { Array, pipe, Record, Schema, SchemaGetter, Tuple } from "effect";
import {
  type EncodedTupleFields,
  type ReadonlyTupleOf,
  type StructSchema,
  structGetter,
  type StructValueSchema,
  type TupleFieldsSchema,
  type TupleValuesSchema,
} from "./structTupleShared";

type TupleToStructSchema<
  Keys extends ReadonlyArray<string>,
  Fields extends ReadonlyTupleOf<Keys["length"], Schema.Top>,
> = Schema.Codec<Schema.Struct.Type<StructSchema<Keys, Fields>>, EncodedTupleFields<Fields>> & {
  readonly keys: Keys;
  readonly fields: Fields;
};

export const TupleToStructSchema = <
  Keys extends ReadonlyArray<string>,
  Fields extends ReadonlyTupleOf<Keys["length"], Schema.Top>,
>(
  keys: Keys,
  fields: Fields,
): TupleToStructSchema<Keys, Fields> => {
  const TupleSchema = Schema.Tuple(
    pipe(
      fields,
      Tuple.map(Schema.toEncoded),
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as TupleFieldsSchema<Fields> /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
  );
  const StructSchema = Schema.Struct(
    Object.fromEntries(
      Array.zip(keys, fields),
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as StructSchema<
      Keys,
      Fields
    > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
  );

  const schema = TupleSchema.pipe(
    Schema.decodeTo(StructSchema, {
      decode: SchemaGetter.transform(
        (tuple) =>
          pipe(
            Array.zip(keys, tuple),
            Record.fromEntries,
          ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Schema.Struct.Encoded<
            StructSchema<Keys, Fields>
          > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      ),
      encode: SchemaGetter.transform(
        (struct) =>
          pipe(
            keys,
            Tuple.map(structGetter(struct)),
          ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Schema.Tuple.Type<
            TupleFieldsSchema<Fields>
          > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      ),
    }),
  ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as TupleToStructSchema<
    Keys,
    Fields
  > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

  return Object.assign(schema, { keys, fields });
};

type EncodedTupleValues<
  Keys extends ReadonlyArray<string>,
  Value extends Schema.Top,
> = ReadonlyTupleOf<Keys["length"], Schema.Codec.Encoded<Value>>;

type TupleToStructValueSchema<
  Keys extends ReadonlyArray<string>,
  Value extends Schema.Top,
> = Schema.Codec<
  Schema.Struct.Type<StructValueSchema<Keys, Value>>,
  EncodedTupleValues<Keys, Value>
> & {
  readonly keys: Keys;
  readonly value: Value;
};

export const TupleToStructValueSchema = <
  const Keys extends ReadonlyArray<string>,
  Value extends Schema.Top,
>(
  keys: Keys,
  value: Value,
) => {
  const TupleSchema = Schema.Tuple(
    Array.makeBy(keys.length, () =>
      Schema.toEncoded(value),
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as TupleValuesSchema<
      Keys,
      Value
    > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
  );
  const StructSchema = Schema.Struct(
    Object.fromEntries(
      pipe(
        keys,
        Array.map((key) => [key, value]),
      ),
    ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as StructValueSchema<
      Keys,
      Value
    > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
  );

  const schema = TupleSchema.pipe(
    Schema.decodeTo(StructSchema, {
      decode: SchemaGetter.transform(
        (tuple) =>
          pipe(
            Array.zip(keys, tuple),
            Record.fromEntries,
          ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Schema.Struct.Encoded<
            StructValueSchema<Keys, Value>
          > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      ),
      encode: SchemaGetter.transform(
        (struct) =>
          pipe(
            keys,
            Tuple.map(structGetter(struct)),
          ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Schema.Tuple.Type<
            TupleValuesSchema<Keys, Value>
          > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */,
      ),
    }),
  ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as TupleToStructValueSchema<
    Keys,
    Value
  > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

  return Object.assign(schema, { keys, value });
};
