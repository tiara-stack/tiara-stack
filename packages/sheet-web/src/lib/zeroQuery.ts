import { Effect, Option, Schema } from "effect";

/**
 * Zero query clients decode endpoint success schemas before exposing values to
 * callers. The reference type is intentionally erased at this boundary, so
 * normalize the decoded Option shell while retaining validation for its value.
 */
export const decodeOptionalQueryResult = <A extends Schema.Codec<unknown, unknown, never, never>>(
  schema: A,
  value: unknown,
): Effect.Effect<Option.Option<A["Type"]>, Schema.SchemaError, A["DecodingServices"]> =>
  Option.isOption(value)
    ? Option.isNone(value)
      ? Effect.succeed(Option.none())
      : Schema.decodeUnknownEffect(schema)(value.value).pipe(Effect.map(Option.some))
    : Schema.decodeUnknownEffect(Schema.OptionFromNullishOr(schema))(value);
