import { Schema } from "effect";
import { defaultColumnSchema } from "./internal/columnSchema";
import type {
  ColumnData,
  Dialect,
  EffectSqlColumn,
  ReferenceOptions,
  ReferenceResolver,
  SqlDefaultValue,
} from "./types";

const clone = <D extends Dialect, K extends string>(
  data: ColumnData & { readonly dialect: D; readonly kind: K },
): EffectSqlColumn<D, K> => {
  const defaultGeneration = () =>
    data.generation === undefined || data.generation === "none" ? "database" : data.generation;
  const make = (patch: Partial<ColumnData>): EffectSqlColumn<D, K> =>
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
      }) as EffectSqlColumn<D, "array">,
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
  };
};

export const makeColumn = <D extends Dialect, K extends string>(
  dialect: D,
  kind: K,
  name?: string,
  config?: Record<string, unknown>,
): EffectSqlColumn<D, K> =>
  clone({
    dialect,
    kind,
    name,
    config,
    generation: "none",
    fieldSchema: defaultColumnSchema(dialect, kind, config),
  });
