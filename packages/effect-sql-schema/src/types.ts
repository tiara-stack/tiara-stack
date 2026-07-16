import type * as Schema from "effect/Schema";
import type * as SchemaGetter from "effect/SchemaGetter";

export type Dialect = "postgresql" | "sqlite";

export type EffectSqlModel = {
  readonly fields: Record<string, Schema.Top>;
};

export type FieldName<Model extends EffectSqlModel> = Extract<keyof Model["fields"], string>;

export type SqlDefaultValue = string | number | boolean | null;

export type ColumnGeneration = "none" | "database" | "application";

export type ReferenceAction = "cascade" | "restrict" | "no action" | "set null" | "set default";

export type ReferenceOptions = {
  readonly onDelete?: ReferenceAction;
  readonly onUpdate?: ReferenceAction;
};

export type ReferenceResolver = () => EffectSqlColumn<any, any, any, any, any>;

export type ColumnData<
  D extends Dialect = Dialect,
  K extends string = string,
  FieldSchema extends Schema.Top = Schema.Top,
  NotNull extends boolean = boolean,
  Generation extends ColumnGeneration = ColumnGeneration,
> = {
  readonly dialect: D;
  readonly kind: K;
  readonly fieldName?: string;
  readonly name?: string;
  readonly fieldSchema: FieldSchema;
  readonly notNull?: NotNull;
  readonly primaryKey?: boolean;
  readonly unique?: string | boolean;
  readonly generation?: Generation;
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

export type EffectSqlColumn<
  D extends Dialect = Dialect,
  K extends string = string,
  FieldSchema extends Schema.Top = Schema.Top,
  NotNull extends boolean = boolean,
  Generation extends ColumnGeneration = ColumnGeneration,
> = {
  readonly _tag: "EffectSqlColumn";
  readonly data: ColumnData<D, K, FieldSchema, NotNull, Generation>;
  readonly asField: (fieldName: string) => EffectSqlColumn<D, K, FieldSchema, NotNull, Generation>;
  readonly array: () => EffectSqlColumn<
    D,
    "array",
    Schema.$Array<FieldSchema>,
    NotNull,
    Generation
  >;
  readonly notNull: () => EffectSqlColumn<D, K, FieldSchema, true, Generation>;
  readonly nullable: () => EffectSqlColumn<D, K, FieldSchema, false, Generation>;
  readonly primaryKey: () => EffectSqlColumn<D, K, FieldSchema, true, Generation>;
  readonly unique: (name?: string) => EffectSqlColumn<D, K, FieldSchema, NotNull, Generation>;
  readonly default: (
    value: SqlDefaultValue,
  ) => EffectSqlColumn<
    D,
    K,
    FieldSchema,
    NotNull,
    Generation extends "none" ? "database" : Generation
  >;
  readonly defaultSql: (
    sql: string,
  ) => EffectSqlColumn<
    D,
    K,
    FieldSchema,
    NotNull,
    Generation extends "none" ? "database" : Generation
  >;
  readonly defaultRandom: () => EffectSqlColumn<
    D,
    K,
    FieldSchema,
    NotNull,
    Generation extends "none" ? "database" : Generation
  >;
  readonly generatedByDatabase: () => EffectSqlColumn<D, K, FieldSchema, NotNull, "database">;
  readonly generatedByApp: () => EffectSqlColumn<D, K, FieldSchema, NotNull, "application">;
  readonly decodeTo: <To extends Schema.Top>(
    to: To,
    transformation?: DecodeTransformation<To>,
  ) => EffectSqlColumn<D, K, To, NotNull, Generation>;
  readonly references: (
    resolver: ReferenceResolver,
    options?: ReferenceOptions,
  ) => EffectSqlColumn<D, K, FieldSchema, NotNull, Generation>;
};

export type TableColumns<Model extends EffectSqlModel> = Partial<
  Record<FieldName<Model>, EffectSqlColumn<any, any, any, any, any> | false>
>;

export type ModelTableColumns<
  Model extends EffectSqlModel,
  Columns extends TableColumns<Model>,
> = Columns & Record<Exclude<keyof Columns, FieldName<Model>>, never>;

export type DefinedTableColumns<
  D extends Dialect,
  Columns extends Partial<Record<string, AnyEffectSqlColumn | false>>,
> = {
  [K in keyof Columns as Columns[K] extends false | undefined ? never : K]: Extract<
    Columns[K],
    EffectSqlColumn<D, any, any, any, any>
  >;
};

export type IndexDefinition = {
  readonly dialect: Dialect;
  readonly name: string;
  readonly unique: boolean;
  readonly fields: readonly string[];
};

export type TableOptions<
  Model extends EffectSqlModel,
  Columns extends TableColumns<Model> = TableColumns<Model>,
> = {
  readonly name?: string;
  readonly schema?: string;
  readonly columns?: ModelTableColumns<Model, Columns>;
  readonly primaryKey?: readonly FieldName<Model>[];
  readonly indexes?: readonly IndexDefinition[];
};

export type ClassField = EffectSqlColumn<any, any, any, any, any>;

export type ClassDefinition<
  Fields extends Record<string, ClassField>,
  PrimaryKey extends readonly (keyof Fields & string)[] = readonly (keyof Fields & string)[],
> = {
  readonly table:
    | string
    | {
        readonly name: string;
        readonly schema?: string;
      };
  readonly fields: Fields;
  readonly primaryKey?: PrimaryKey;
  readonly indexes?: readonly IndexDefinition[];
};

export type EffectSqlTable<
  D extends Dialect = Dialect,
  Model extends EffectSqlModel = EffectSqlModel,
  Columns extends Record<string, EffectSqlColumn<D, any, any, any, any>> = Record<
    FieldName<Model>,
    EffectSqlColumn<D, any, any, any, any>
  >,
> = {
  readonly _tag: "EffectSqlTable";
  readonly dialect: D;
  readonly model: Model;
  readonly name: string;
  readonly sqlName: string;
  readonly schema?: string;
  readonly columns: Columns;
  readonly primaryKey: readonly FieldName<Model>[];
  readonly indexes: readonly IndexDefinition[];
};

export type AnyEffectSqlColumn = EffectSqlColumn<any, any, any, any, any>;

export type AnyEffectSqlTable = EffectSqlTable<any, any, Record<string, AnyEffectSqlColumn>>;

export type EffectSqlSchema<
  Tables extends Record<string, AnyEffectSqlTable> = Record<string, AnyEffectSqlTable>,
> = {
  readonly _tag: "EffectSqlSchema";
  readonly tables: Tables;
  readonly prefix?: string;
};

export type EffectSqlSchemaOptions = {
  readonly prefix?: string;
};
