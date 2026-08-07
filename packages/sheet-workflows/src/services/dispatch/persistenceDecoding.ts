import { Predicate, Schema } from "effect";

export const decodeTagged = <SchemaValue extends Schema.Top>(
  schema: SchemaValue,
  tag: string,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(
    Predicate.isObject(value) && !Predicate.hasProperty(value, "_tag")
      ? { _tag: tag, ...value }
      : value,
  );
