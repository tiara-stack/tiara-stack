import { Schema } from "effect";

type ModelColumnData = {
  readonly fieldSchema: Schema.Top;
  readonly kind: string;
  readonly notNull?: boolean;
  readonly primaryKey?: boolean;
};

type ModelColumn = {
  readonly data: ModelColumnData;
};

type ModelTable = {
  readonly columns: Record<string, ModelColumn>;
};

export type StringField = typeof Schema.String;
export type NumberField = typeof Schema.Number;
export type BooleanField = typeof Schema.Boolean;
export type StringArrayField = Schema.Codec<ReadonlyArray<string>, ReadonlyArray<string>>;
export type StringOptionField = Schema.OptionFromNullOr<typeof Schema.String>;
export type BooleanOptionField = Schema.OptionFromNullOr<typeof Schema.Boolean>;
export type DateTimeOptionField = Schema.OptionFromNullOr<typeof Schema.DateTimeUtcFromMillis>;

type ModelFieldsOptions = {
  readonly omit?: ReadonlySet<string>;
  readonly overrides?: Record<string, Schema.Codec<unknown, unknown>>;
};

const isNullableColumn = (column: ModelColumn) =>
  column.data.notNull !== true && column.data.primaryKey !== true;

const asCodec = (schema: Schema.Top): Schema.Codec<unknown, unknown> => {
  if (schema == null || (typeof schema !== "object" && typeof schema !== "function")) {
    throw new TypeError("Expected model field schema to be an Effect Schema codec");
  }
  return schema as Schema.Codec<unknown, unknown>;
};

const publicColumnSchema = (
  fieldName: string,
  column: ModelColumn,
  options?: ModelFieldsOptions,
): Schema.Codec<unknown, unknown> => {
  const override = options?.overrides?.[fieldName];
  if (override !== undefined) {
    return override;
  }

  const schema =
    column.data.kind === "timestamp"
      ? Schema.DateTimeUtcFromMillis
      : asCodec(column.data.fieldSchema);

  // Timestamps intentionally keep the previous public API compatibility shape:
  // legacy/current responses may encode missing database timestamps as null.
  return isNullableColumn(column) || column.data.kind === "timestamp"
    ? Schema.OptionFromNullOr(schema)
    : schema;
};

/**
 * Derives public API field codecs from ModelTable column metadata via publicColumnSchema.
 *
 * The return type is intentionally erased to Record<string, Schema.Codec<unknown, unknown>>
 * because ModelFieldsOptions can omit or override arbitrary model fields. Callers that need a
 * precise Schema.TaggedClass field map should narrow the result at the composition boundary.
 */
export const modelTaggedFields = (
  model: ModelTable,
  options?: ModelFieldsOptions,
): Record<string, Schema.Codec<unknown, unknown>> => {
  if (options?.overrides) {
    for (const fieldName of Object.keys(options.overrides)) {
      if (!Object.hasOwn(model.columns, fieldName)) {
        throw new TypeError(`Unknown model field override: ${fieldName}`);
      }
    }
  }

  const fields: Record<string, Schema.Codec<unknown, unknown>> = {};
  for (const [fieldName, column] of Object.entries(model.columns)) {
    if (options?.omit?.has(fieldName)) {
      continue;
    }
    fields[fieldName] = publicColumnSchema(fieldName, column, options);
  }
  return fields;
};

/**
 * Verifies validateTaggedFields expectedKeys exactly match the runtime field object and that
 * every value passes asCodec. This cannot prove each Fields alias matches the derived codec
 * runtime type, so callers should keep declared aliases in sync and cover representative shapes
 * with expectWireRoundTrip.
 */
export const validateTaggedFields = <
  const Fields extends { readonly [Key in keyof Fields]: Schema.Codec<unknown, unknown> },
>(
  fields: Record<string, Schema.Codec<unknown, unknown>>,
  expectedKeys: readonly (keyof Fields & string)[],
): Fields => {
  const expected = new Set<string>(expectedKeys);
  const actualKeys = Object.keys(fields);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(fields, key));
  const extra = actualKeys.filter((key) => !expected.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new TypeError(
      `Model fields mismatch: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
    );
  }

  for (const key of expectedKeys) {
    const field = fields[key];
    if (field === undefined) {
      throw new TypeError(`Model field ${key} is missing`);
    }
    asCodec(field);
  }

  return fields as unknown as Fields;
};
