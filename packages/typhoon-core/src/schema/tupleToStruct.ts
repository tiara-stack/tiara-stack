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
    pipe(fields, Tuple.map(Schema.toEncoded)) as TupleFieldsSchema<Fields>,
  );
  const StructSchema = Schema.Struct(
    Object.fromEntries(Array.zip(keys, fields)) as StructSchema<Keys, Fields>,
  );

  const schema = TupleSchema.pipe(
    Schema.decodeTo(StructSchema, {
      decode: SchemaGetter.transform(
        (tuple) =>
          pipe(Array.zip(keys, tuple), Record.fromEntries) as unknown as Schema.Struct.Encoded<
            StructSchema<Keys, Fields>
          >,
      ),
      encode: SchemaGetter.transform(
        (struct) =>
          pipe(keys, Tuple.map(structGetter(struct))) as unknown as Schema.Tuple.Type<
            TupleFieldsSchema<Fields>
          >,
      ),
    }),
  ) as unknown as TupleToStructSchema<Keys, Fields>;

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
    Array.makeBy(keys.length, () => Schema.toEncoded(value)) as TupleValuesSchema<Keys, Value>,
  );
  const StructSchema = Schema.Struct(
    Object.fromEntries(
      pipe(
        keys,
        Array.map((key) => [key, value]),
      ),
    ) as StructValueSchema<Keys, Value>,
  );

  const schema = TupleSchema.pipe(
    Schema.decodeTo(StructSchema, {
      decode: SchemaGetter.transform(
        (tuple) =>
          pipe(Array.zip(keys, tuple), Record.fromEntries) as unknown as Schema.Struct.Encoded<
            StructValueSchema<Keys, Value>
          >,
      ),
      encode: SchemaGetter.transform(
        (struct) =>
          pipe(keys, Tuple.map(structGetter(struct))) as unknown as Schema.Tuple.Type<
            TupleValuesSchema<Keys, Value>
          >,
      ),
    }),
  ) as unknown as TupleToStructValueSchema<Keys, Value>;

  return Object.assign(schema, { keys, value });
};
