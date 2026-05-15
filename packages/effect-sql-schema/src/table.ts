import { Schema } from "effect";
import { Model } from "effect/unstable/schema";
import type {
  ClassDefinition,
  Dialect,
  EffectSqlColumn,
  EffectSqlModel,
  EffectSqlTable,
  FieldName,
  IndexDefinition,
  TableOptions,
} from "./types";

const identifierFromModel = (model: EffectSqlModel): string | undefined => {
  const ast = (model as { readonly ast?: { readonly annotations?: Record<string, unknown> } }).ast;
  const id = ast?.annotations?.identifier ?? ast?.annotations?.id ?? ast?.annotations?.title;
  return typeof id === "string" ? id : undefined;
};

const nullableFieldSchema = (column: EffectSqlColumn): Schema.Top =>
  column.data.notNull || column.data.primaryKey
    ? column.data.fieldSchema
    : Schema.NullOr(column.data.fieldSchema);

const modelField = (column: EffectSqlColumn): Schema.Top =>
  column.data.defaultExpression !== undefined || column.data.defaultValue !== undefined
    ? (Model.Generated(nullableFieldSchema(column)) as unknown as Schema.Top)
    : nullableFieldSchema(column);

const attachTableName = <D extends Dialect>(
  tableName: string,
  column: EffectSqlColumn<D>,
): EffectSqlColumn<D> =>
  ({
    ...column,
    tableName,
  }) as EffectSqlColumn<D>;

export const defineTable = <const D extends Dialect, const Model extends EffectSqlModel>(
  dialect: D,
  model: Model,
  options: TableOptions<Model>,
): EffectSqlTable<D, Model> => {
  const name = options.name ?? identifierFromModel(model);
  if (!name) {
    throw new Error(
      "effect-sql-schema: table name is required when it cannot be inferred from the model",
    );
  }

  const columns = {} as Record<FieldName<Model>, EffectSqlColumn<D>>;
  for (const fieldName of Object.keys(model.fields) as Array<FieldName<Model>>) {
    const configured = options.columns?.[fieldName];
    if (configured === false) {
      continue;
    }
    if (!configured) {
      throw new Error(
        `effect-sql-schema: column builder is required for ${name}.${fieldName}; raw Effect schemas are not inferred`,
      );
    }
    if (configured.data.dialect !== dialect) {
      throw new Error(
        `effect-sql-schema: ${name}.${fieldName} uses a ${configured.data.dialect} column in a ${dialect} table`,
      );
    }
    columns[fieldName] = configured.asField(fieldName) as EffectSqlColumn<D>;
  }

  return finalizeTable(dialect, model, {
    name,
    schema: options.schema,
    columns,
    primaryKey: options.primaryKey,
    indexes: options.indexes,
  });
};

const finalizeTable = <const D extends Dialect, const Model extends EffectSqlModel>(
  dialect: D,
  model: Model,
  options: {
    readonly name: string;
    readonly schema?: string;
    readonly columns: Record<FieldName<Model>, EffectSqlColumn<D>>;
    readonly primaryKey?: readonly FieldName<Model>[];
    readonly indexes?: readonly IndexDefinition[];
  },
): EffectSqlTable<D, Model> => {
  const columns = { ...options.columns };
  const primaryKey = new Set<string>(options.primaryKey ?? []);
  for (const [fieldName, column] of Object.entries(columns)) {
    if (column.data.primaryKey) {
      primaryKey.add(fieldName);
      columns[fieldName as FieldName<Model>] = column.notNull() as EffectSqlColumn<D>;
    }
  }

  if (primaryKey.size === 0) {
    throw new Error(
      `effect-sql-schema: table ${options.name} must declare at least one primary key column`,
    );
  }

  for (const key of primaryKey) {
    const column = columns[key as FieldName<Model>];
    if (!column) {
      throw new Error(`effect-sql-schema: primary key ${options.name}.${key} was not generated`);
    }
    columns[key as FieldName<Model>] = column.primaryKey() as EffectSqlColumn<D>;
  }

  for (const [fieldName, column] of Object.entries(columns)) {
    columns[fieldName as FieldName<Model>] = attachTableName(options.name, column);
  }

  return {
    _tag: "EffectSqlTable",
    dialect,
    model,
    name: options.name,
    sqlName: options.name,
    schema: options.schema,
    columns,
    primaryKey: [...primaryKey] as Array<FieldName<Model>>,
    indexes: options.indexes ?? [],
  };
};

const tableDefinition = <Fields extends Record<string, EffectSqlColumn>>(
  definition: ClassDefinition<Fields>,
) =>
  typeof definition.table === "string"
    ? { name: definition.table, schema: undefined }
    : definition.table;

export const defineClass =
  <const D extends Dialect>(dialect: D) =>
  <Self>(identifier: string) =>
  <const Fields extends Record<string, EffectSqlColumn<D>>>(
    definition: ClassDefinition<Fields>,
  ) => {
    const table = tableDefinition(definition);
    const columns = {} as Record<keyof Fields & string, EffectSqlColumn<D>>;
    const fields = {} as Record<keyof Fields & string, Schema.Top>;

    for (const [fieldName, column] of Object.entries(definition.fields) as Array<
      [keyof Fields & string, EffectSqlColumn<D>]
    >) {
      if (
        typeof column !== "object" ||
        column === null ||
        (column as { readonly _tag?: unknown })._tag !== "EffectSqlColumn"
      ) {
        throw new Error(
          `effect-sql-schema: column builder is required for ${table.name}.${fieldName}; raw Effect schemas are not supported`,
        );
      }
      if (column.data.dialect !== dialect) {
        throw new Error(
          `effect-sql-schema: ${table.name}.${fieldName} uses a ${column.data.dialect} column in a ${dialect} table`,
        );
      }
      const namedColumn = column.asField(fieldName) as EffectSqlColumn<D>;
      columns[fieldName] = namedColumn;
      fields[fieldName] = modelField(namedColumn);
    }

    const klass = Model.Class<Self>(identifier)(fields as never);
    const tableMetadata = finalizeTable(dialect, klass as unknown as EffectSqlModel, {
      name: table.name,
      schema: table.schema,
      columns,
      primaryKey: definition.primaryKey as readonly FieldName<EffectSqlModel>[] | undefined,
      indexes: definition.indexes,
    });

    const metadata = {
      _tag: tableMetadata._tag,
      dialect: tableMetadata.dialect,
      model: tableMetadata.model,
      sqlName: tableMetadata.sqlName,
      schema: tableMetadata.schema,
      columns: tableMetadata.columns,
      primaryKey: tableMetadata.primaryKey,
      indexes: tableMetadata.indexes,
    };
    return Object.assign(klass, metadata);
  };

export const makeIndex = (dialect: Dialect, unique: boolean, name: string) => ({
  on: (...fields: string[]): IndexDefinition => ({
    dialect,
    unique,
    name,
    fields,
  }),
});
