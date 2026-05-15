import type * as Schema from "effect/Schema";

export type ZeroValueType = "string" | "number" | "boolean" | "json";

export type EffectZeroModel = {
  readonly fields: Record<string, Schema.Top>;
};

export type FieldName<Model extends EffectZeroModel> = Extract<keyof Model["fields"], string>;

export type ColumnOptions = {
  readonly name?: string;
  readonly serverName?: string;
  readonly type?: ZeroValueType;
  readonly optional?: boolean;
};

export type TableOptions<Model extends EffectZeroModel> = {
  readonly name?: string;
  readonly serverName?: string;
  readonly key: readonly FieldName<Model>[];
  readonly columns?: Partial<Record<FieldName<Model>, boolean | ColumnOptions>>;
};

export type EffectZeroColumn = {
  readonly fieldName: string;
  readonly name: string;
  readonly serverName?: string;
  readonly type?: ZeroValueType;
  readonly optional?: boolean;
};

export type EffectZeroTable<Model extends EffectZeroModel = EffectZeroModel> = {
  readonly model: Model;
  readonly name: string;
  readonly serverName?: string;
  readonly key: readonly string[];
  readonly columns?: Partial<Record<string, boolean | ColumnOptions>>;
};

export type RelationshipStep = {
  readonly destSchema: string;
  readonly sourceField: readonly string[];
  readonly destField: readonly string[];
  readonly cardinality: "one" | "many";
};

export type RelationshipDefinition = readonly [RelationshipStep, ...RelationshipStep[]];

export type RelationshipConfig = Record<string, Record<string, RelationshipDefinition>>;

export type EffectZeroSchema<
  Tables extends Record<string, EffectZeroTable> = Record<string, EffectZeroTable>,
> = {
  readonly tables: Tables;
  readonly relationships: RelationshipConfig;
  readonly enableLegacyQueries?: boolean;
  readonly enableLegacyMutators?: boolean;
};

export type ColumnType<
  Config extends EffectZeroSchema,
  TableName extends keyof Config["tables"] & string,
  ColumnName extends keyof Config["tables"][TableName]["model"]["fields"] & string,
> = Schema.Schema.Type<Config["tables"][TableName]["model"]["fields"][ColumnName]>;
