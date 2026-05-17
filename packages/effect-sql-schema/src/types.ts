import type * as Schema from "effect/Schema";
import type * as SchemaGetter from "effect/SchemaGetter";

export type Dialect = "postgresql" | "sqlite";

export type EffectSqlModel = {
  readonly fields: Record<string, Schema.Top>;
};

export type FieldName<Model extends EffectSqlModel> = Extract<keyof Model["fields"], string>;

export type SqlDefaultValue = string | number | boolean | null;

export type ReferenceAction = "cascade" | "restrict" | "no action" | "set null" | "set default";

export type ReferenceOptions = {
  readonly onDelete?: ReferenceAction;
  readonly onUpdate?: ReferenceAction;
};

export type ReferenceResolver = () => EffectSqlColumn<any, any>;

export type ColumnData = {
  readonly dialect: Dialect;
  readonly kind: string;
  readonly fieldName?: string;
  readonly name?: string;
  readonly fieldSchema: Schema.Top;
  readonly notNull?: boolean;
  readonly primaryKey?: boolean;
  readonly unique?: string | boolean;
  readonly defaultValue?: SqlDefaultValue;
  readonly defaultExpression?: string;
  readonly references?: {
    readonly resolver: ReferenceResolver;
    readonly options?: ReferenceOptions;
  };
  readonly config?: Record<string, unknown>;
};

export type DecodeTransformation<To extends Schema.Top> = {
  readonly decode: SchemaGetter.Getter<To["Encoded"], Schema.Top["Type"]>;
  readonly encode: SchemaGetter.Getter<Schema.Top["Type"], To["Encoded"]>;
};

export type EffectSqlColumn<D extends Dialect = Dialect, K extends string = string> = {
  readonly _tag: "EffectSqlColumn";
  readonly data: ColumnData & { readonly dialect: D; readonly kind: K };
  readonly asField: (fieldName: string) => EffectSqlColumn<D, K>;
  readonly array: () => EffectSqlColumn<D, "array">;
  readonly notNull: () => EffectSqlColumn<D, K>;
  readonly nullable: () => EffectSqlColumn<D, K>;
  readonly primaryKey: () => EffectSqlColumn<D, K>;
  readonly unique: (name?: string) => EffectSqlColumn<D, K>;
  readonly default: (value: SqlDefaultValue) => EffectSqlColumn<D, K>;
  readonly defaultSql: (sql: string) => EffectSqlColumn<D, K>;
  readonly defaultRandom: () => EffectSqlColumn<D, K>;
  readonly decodeTo: <To extends Schema.Top>(
    to: To,
    transformation?: DecodeTransformation<To>,
  ) => EffectSqlColumn<D, K>;
  readonly references: (
    resolver: ReferenceResolver,
    options?: ReferenceOptions,
  ) => EffectSqlColumn<D, K>;
};

export type TableColumns<Model extends EffectSqlModel> = Partial<
  Record<FieldName<Model>, EffectSqlColumn | false>
>;

export type IndexDefinition = {
  readonly dialect: Dialect;
  readonly name: string;
  readonly unique: boolean;
  readonly fields: readonly string[];
};

export type TableOptions<Model extends EffectSqlModel> = {
  readonly name?: string;
  readonly schema?: string;
  readonly columns?: TableColumns<Model>;
  readonly primaryKey?: readonly FieldName<Model>[];
  readonly indexes?: readonly IndexDefinition[];
};

export type ClassField = EffectSqlColumn;

export type ClassDefinition<Fields extends Record<string, ClassField>> = {
  readonly table:
    | string
    | {
        readonly name: string;
        readonly schema?: string;
      };
  readonly fields: Fields;
  readonly primaryKey?: readonly (keyof Fields & string)[];
  readonly indexes?: readonly IndexDefinition[];
};

export type EffectSqlTable<
  D extends Dialect = Dialect,
  Model extends EffectSqlModel = EffectSqlModel,
> = {
  readonly _tag: "EffectSqlTable";
  readonly dialect: D;
  readonly model: Model;
  readonly name: string;
  readonly sqlName: string;
  readonly schema?: string;
  readonly columns: Record<FieldName<Model>, EffectSqlColumn<D>>;
  readonly primaryKey: readonly FieldName<Model>[];
  readonly indexes: readonly IndexDefinition[];
};

export type EffectSqlSchema<
  Tables extends Record<string, EffectSqlTable> = Record<string, EffectSqlTable>,
> = {
  readonly _tag: "EffectSqlSchema";
  readonly tables: Tables;
  readonly tablePrefix?: string;
};

export type EffectSqlSchemaOptions = {
  readonly tablePrefix?: string;
};
