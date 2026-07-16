import { Schema } from "effect";
import { defaultColumnSchema } from "./internal/columnSchema.js";
import type {
  ColumnGeneration,
  ColumnData,
  Dialect,
  EffectSqlColumn,
  ReferenceOptions,
  ReferenceResolver,
  SqlDefaultValue,
} from "./types.js";
import type { DefaultColumnSchema } from "./internal/columnSchema.js";

const clone = <
  D extends Dialect,
  K extends string,
  FieldSchema extends Schema.Top,
  NotNull extends boolean,
  Generation extends ColumnGeneration,
>(
  data: ColumnData<D, K, FieldSchema, NotNull, Generation>,
): EffectSqlColumn<D, K, FieldSchema, NotNull, Generation> => {
  const defaultGeneration = () =>
    data.generation === undefined || data.generation === "none" ? "database" : data.generation;
  const make = (patch: Partial<ColumnData>): EffectSqlColumn =>
    clone({
      ...data,
      ...patch,
      dialect: data.dialect,
      kind: data.kind,
    });

  return {
    _tag: "EffectSqlColumn",
    data,
    asField: (fieldName) => make({ fieldName }),
    array: () =>
      clone({
        ...data,
        kind: "array",
        config: {
          elementKind: data.kind,
          ...(data.config ? { elementConfig: data.config } : {}),
        },
        fieldSchema: Schema.Array(data.fieldSchema),
      }),
    notNull: () => make({ notNull: true }),
    nullable: () => make({ notNull: false }),
    primaryKey: () => make({ primaryKey: true, notNull: true }),
    unique: (name) => make({ unique: name ?? true }),
    default: (value: SqlDefaultValue) =>
      make({ defaultValue: value, generation: defaultGeneration() }),
    defaultSql: (sql: string) => make({ defaultExpression: sql, generation: defaultGeneration() }),
    // Currently this only models supported built-in defaults for the package's
    // initial column set: Postgres UUIDs use gen_random_uuid, SQLite numeric
    // random defaults use random. Future SQLite UUID support should add an
    // explicit UUID default instead of relying on this fallback.
    defaultRandom: () =>
      make({
        defaultExpression: data.dialect === "postgresql" ? "gen_random_uuid()" : "random()",
        generation: defaultGeneration(),
      }),
    generatedByDatabase: () => make({ generation: "database" }),
    generatedByApp: () => make({ generation: "application" }),
    decodeTo: (to, transformation) =>
      make({
        fieldSchema:
          transformation === undefined
            ? Schema.decodeTo(to)(data.fieldSchema)
            : Schema.decodeTo(to, transformation)(data.fieldSchema),
      }),
    references: (resolver: ReferenceResolver, options?: ReferenceOptions) =>
      make({ references: { resolver, options } }),
  } as EffectSqlColumn<D, K, FieldSchema, NotNull, Generation>;
};

export const makeColumn = <
  const D extends Dialect,
  const K extends string,
  const Config extends Record<string, unknown> | undefined = undefined,
>(
  dialect: D,
  kind: K,
  name?: string,
  config?: Config,
): EffectSqlColumn<D, K, DefaultColumnSchema<D, K, Config>, false, "none"> =>
  clone({
    dialect,
    kind,
    name,
    config,
    generation: "none",
    fieldSchema: defaultColumnSchema(dialect, kind, config),
  });
