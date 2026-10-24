import { Option, Schema, SchemaGetter } from "effect";
import { OptionArrayToOptionTupleSchema } from "./optionArrayToOptionTuple";
import { TupleToStructValueSchema } from "./tupleToStruct";

type OptionArrayToOptionStructValueSchema<
  Keys extends ReadonlyArray<string>,
  Value extends Schema.Top,
> = Schema.Codec<
  Schema.Struct.Type<{
    [K in Keys[number]]: Schema.Option<Value>;
  }>,
  ReadonlyArray<Option.Option<Schema.Codec.Encoded<Value>>>
> & {
  readonly keys: Keys;
  readonly value: Value;
};

export const OptionArrayToOptionStructValueSchema = <
  Keys extends ReadonlyArray<string>,
  Value extends Schema.Top,
>(
  keys: Keys,
  value: Value,
) => {
  const optionArrayToOptionTupleSchema = OptionArrayToOptionTupleSchema(
    keys.length as Keys["length"],
    Schema.toEncoded(value),
  );
  const tupleToStructValueSchema = TupleToStructValueSchema(keys, Schema.Option(value));

  const schema = optionArrayToOptionTupleSchema.pipe(
    Schema.decodeTo(tupleToStructValueSchema, {
      decode: SchemaGetter.passthrough(),
      encode: SchemaGetter.passthroughSupertype(),
    }),
  ) as unknown /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as OptionArrayToOptionStructValueSchema<
    Keys,
    Value
  > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;

  return Object.assign(schema, { keys, value });
};
