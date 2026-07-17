import type * as Schema from "effect/Schema";

export type ZeroValueType = "string" | "number" | "boolean" | "json";

export type EffectZeroModel = {
  readonly fields: Record<string, Schema.Top>;
};

export type FieldName<Model extends EffectZeroModel> = Extract<keyof Model["fields"], string>;

export type ColumnOptions = {
  readonly name?: string | undefined;
  readonly serverName?: string | undefined;
  readonly type?: ZeroValueType | undefined;
  readonly optional?: boolean | undefined;
};

export type TableOptions<Model extends EffectZeroModel> = {
  readonly name?: string | undefined;
  readonly serverName?: string | undefined;
  readonly key: readonly FieldName<Model>[];
  readonly columns?: Partial<Record<FieldName<Model>, boolean | ColumnOptions>> | undefined;
};

export type EffectZeroTable<Model extends EffectZeroModel = EffectZeroModel> = {
  readonly model: Model;
  readonly name: string;
  readonly serverName?: string | undefined;
  readonly key: readonly string[];
  readonly columns?: Partial<Record<string, boolean | ColumnOptions>> | undefined;
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
  readonly prefix?: string | undefined;
  readonly enableLegacyQueries?: boolean | undefined;
  readonly enableLegacyMutators?: boolean | undefined;
};

export type ColumnType<
  Config extends EffectZeroSchema,
  TableName extends keyof Config["tables"] & string,
  ColumnName extends keyof Config["tables"][TableName]["model"]["fields"] & string,
> = Schema.Schema.Type<Config["tables"][TableName]["model"]["fields"][ColumnName]>;
