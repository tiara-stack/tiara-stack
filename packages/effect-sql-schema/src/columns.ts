import { Schema } from "effect";
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
    default: (value: SqlDefaultValue) => make({ defaultValue: value }),
    defaultSql: (sql: string) => make({ defaultExpression: sql }),
    // Currently this only models supported built-in defaults for the package's
    // initial column set: Postgres UUIDs use gen_random_uuid, SQLite numeric
    // random defaults use random. Future SQLite UUID support should add an
    // explicit UUID default instead of relying on this fallback.
    defaultRandom: () =>
      make({ defaultExpression: data.dialect === "postgresql" ? "gen_random_uuid()" : "random()" }),
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

const defaultSchema = (dialect: Dialect, kind: string, config?: Record<string, unknown>) => {
  switch (kind) {
    case "integer":
      if (dialect === "sqlite" && config?.mode === "boolean") {
        return Schema.Boolean;
      }
      return dialect === "postgresql" ? Schema.Int : Schema.Number;
    case "bigint":
      return Schema.BigInt;
    case "real":
    case "doublePrecision":
    case "numeric":
      return Schema.Number;
    case "boolean":
      return Schema.Boolean;
    case "json":
    case "jsonb":
    case "blob":
      return Schema.Unknown;
    case "timestamp":
    case "date":
      return Schema.Number;
    case "text":
    case "varchar":
    case "uuid":
    default:
      return Schema.String;
  }
};

export const makeColumn = <D extends Dialect, K extends string>(
  dialect: D,
  kind: K,
  name?: string,
  config?: Record<string, unknown>,
): EffectSqlColumn<D, K> =>
  clone({ dialect, kind, name, config, fieldSchema: defaultSchema(dialect, kind, config) });
