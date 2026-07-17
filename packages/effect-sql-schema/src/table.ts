import { Match, Predicate, Schema } from "effect";
import { Model, VariantSchema } from "effect/unstable/schema";
import type {
  ClassDefinition,
  DefinedTableColumns,
  Dialect,
  EffectSqlColumn,
  EffectSqlModel,
  EffectSqlTable,
  FieldName,
  IndexDefinition,
  ModelTableColumns,
  TableOptions,
  TableColumns,
} from "./types.js";

const identifierFromModel = (model: EffectSqlModel): string | undefined => {
  const ast = (model as { readonly ast?: { readonly annotations?: Record<string, unknown> } }).ast;
  const id = ast?.annotations?.identifier ?? ast?.annotations?.id ?? ast?.annotations?.title;
  return typeof id === "string" ? id : undefined;
};

type AnyColumn = EffectSqlColumn<any, any, any, any, any>;

type ColumnFieldSchema<Column extends AnyColumn> = Column["data"]["fieldSchema"];

type NullableFieldSchema<Column extends AnyColumn> =
  NonNullable<Column["data"]["notNull"]> extends true
    ? ColumnFieldSchema<Column>
    : Schema.NullOr<ColumnFieldSchema<Column>>;

type ModelField<Column extends AnyColumn> =
  NonNullable<Column["data"]["generation"]> extends "database"
    ? Model.Generated<NullableFieldSchema<Column>>
    : NonNullable<Column["data"]["generation"]> extends "application"
      ? Model.GeneratedByApp<NullableFieldSchema<Column>>
      : NullableFieldSchema<Column>;

type ModelFields<Fields extends Record<string, AnyColumn>> = {
  [K in keyof Fields]: ModelField<Fields[K]>;
};

type PrimaryKeyColumns<
  Fields extends Record<string, AnyColumn>,
  PrimaryKey extends readonly (keyof Fields & string)[],
> = {
  [K in keyof Fields]: K extends PrimaryKey[number]
    ? ReturnType<Fields[K]["primaryKey"]>
    : Fields[K];
};

type ModelVariant = "select" | "insert" | "update" | "json" | "jsonCreate" | "jsonUpdate";

type ModelClass<Self, Fields extends Record<string, AnyColumn>> = VariantSchema.Class<
  Self,
  ModelFields<Fields>,
  Schema.Struct<VariantSchema.ExtractFields<"select", ModelFields<Fields>, true>>
> & {
  readonly [V in ModelVariant]: VariantSchema.Extract<V, VariantSchema.Struct<ModelFields<Fields>>>;
};

// Model.Class cannot retain a mapped generic field object when it is invoked from
// this column adapter, even though the runtime class is built from that exact
// object. Keep the assertion here so every caller receives the original field
// map instead of repeating (and potentially widening) the bridge downstream.
const asModelClass = <Self, Fields extends Record<string, AnyColumn>>(
  value: object,
): ModelClass<Self, Fields> => value as ModelClass<Self, Fields>;

const nullableFieldSchema = <Column extends AnyColumn>(
  column: Column,
): NullableFieldSchema<Column> =>
  column.data.notNull || column.data.primaryKey
    ? (column.data.fieldSchema as NullableFieldSchema<Column>)
    : (Schema.NullOr(column.data.fieldSchema) as NullableFieldSchema<Column>);

const modelField = <Column extends AnyColumn>(column: Column): ModelField<Column> => {
  const schema = nullableFieldSchema(column);
  return Match.value(column.data.generation).pipe(
    Match.when("database", () => Model.Generated(schema)),
    Match.when("application", () => Model.GeneratedByApp(schema)),
    Match.orElse(() => schema),
  ) as ModelField<Column>;
};

const attachTableName = <Column extends AnyColumn>(tableName: string, column: Column): Column =>
  ({
    ...column,
    tableName,
  }) as Column;

export const defineTable = <
  const D extends Dialect,
  const Model extends EffectSqlModel,
  const Columns extends TableColumns<Model>,
>(
  dialect: D,
  model: Model,
  options: Omit<TableOptions<Model, Columns>, "columns"> & {
    readonly columns: ModelTableColumns<Model, Columns>;
  },
): EffectSqlTable<D, Model, DefinedTableColumns<D, ModelTableColumns<Model, Columns>>> => {
  const name = options.name ?? identifierFromModel(model);
  if (!name) {
    throw new Error(
      "effect-sql-schema: table name is required when it cannot be inferred from the model",
    );
  }

  const columns = {} as Record<string, EffectSqlColumn<D>>;
  const configuredColumns = options.columns as TableColumns<Model>;
  for (const fieldName of Object.keys(model.fields) as Array<FieldName<Model>>) {
    const configured = configuredColumns?.[fieldName];
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
    columns: columns as DefinedTableColumns<D, ModelTableColumns<Model, Columns>>,
    primaryKey: options.primaryKey,
    indexes: options.indexes,
  });
};

const finalizeTable = <
  const D extends Dialect,
  const Model extends EffectSqlModel,
  const Columns extends Record<string, EffectSqlColumn<D, any, any, any, any>>,
>(
  dialect: D,
  model: Model,
  options: {
    readonly name: string;
    readonly schema?: string | undefined;
    readonly columns: Columns;
    readonly primaryKey?: readonly FieldName<Model>[] | undefined;
    readonly indexes?: readonly IndexDefinition[] | undefined;
  },
): EffectSqlTable<D, Model, Columns> => {
  const columns = { ...options.columns };
  const primaryKey = new Set<string>(options.primaryKey ?? []);
  for (const [fieldName, column] of Object.entries(columns)) {
    if (column.data.primaryKey) {
      primaryKey.add(fieldName);
      columns[fieldName as keyof Columns] = column.notNull() as Columns[keyof Columns];
    }
  }

  if (primaryKey.size === 0) {
    throw new Error(
      `effect-sql-schema: table ${options.name} must declare at least one primary key column`,
    );
  }

  for (const key of primaryKey) {
    const column = columns[key as keyof Columns];
    if (!column) {
      throw new Error(`effect-sql-schema: primary key ${options.name}.${key} was not generated`);
    }
    columns[key as keyof Columns] = column.primaryKey() as Columns[keyof Columns];
  }

  for (const [fieldName, column] of Object.entries(columns)) {
    columns[fieldName as keyof Columns] = attachTableName(
      options.name,
      column,
    ) as Columns[keyof Columns];
  }

  return {
    _tag: "EffectSqlTable",
    dialect,
    model,
    name: options.name,
    sqlName: options.name,
    schema: options.schema,
    columns: columns as Columns,
    primaryKey: [...primaryKey] as Array<FieldName<Model>>,
    indexes: options.indexes ?? [],
  };
};

const tableDefinition = <
  Fields extends Record<string, AnyColumn>,
  PrimaryKey extends readonly (keyof Fields & string)[],
>(
  definition: ClassDefinition<Fields, PrimaryKey>,
) =>
  typeof definition.table === "string"
    ? { name: definition.table, schema: undefined }
    : definition.table;

export const defineClass =
  <const D extends Dialect>(dialect: D) =>
  <Self>(identifier: string) =>
  <
    const Fields extends Record<string, EffectSqlColumn<D, any, any, any, any>>,
    const PrimaryKey extends readonly (keyof Fields & string)[] = readonly [],
  >(
    definition: ClassDefinition<Fields, PrimaryKey>,
  ) => {
    const table = tableDefinition(definition);
    const primaryKey = new Set<string>(definition.primaryKey ?? []);
    const columns = {} as PrimaryKeyColumns<Fields, PrimaryKey>;
    const fields = {} as ModelFields<PrimaryKeyColumns<Fields, PrimaryKey>>;

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
      const normalizedColumn = primaryKey.has(fieldName) ? namedColumn.primaryKey() : namedColumn;
      columns[fieldName] = normalizedColumn as PrimaryKeyColumns<Fields, PrimaryKey>[keyof Fields &
        string];
      fields[fieldName] = modelField(normalizedColumn) as ModelFields<
        PrimaryKeyColumns<Fields, PrimaryKey>
      >[keyof Fields & string];
    }

    const makeClass = Model.Class<Self>(identifier);
    const classResult = makeClass(fields);
    if (Predicate.isString(classResult)) {
      throw new Error(classResult);
    }
    const klass = asModelClass<Self, PrimaryKeyColumns<Fields, PrimaryKey>>(classResult);
    const tableMetadata = finalizeTable(dialect, klass, {
      name: table.name,
      schema: table.schema,
      columns,
      primaryKey: definition.primaryKey as readonly FieldName<typeof klass>[] | undefined,
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
