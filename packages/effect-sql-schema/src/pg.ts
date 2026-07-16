import { makeColumn } from "./columns.js";
import { defineClass, defineTable, makeIndex } from "./table.js";
import type { DefaultColumnSchema } from "./internal/columnSchema.js";
import type {
  DefinedTableColumns,
  EffectSqlColumn,
  EffectSqlModel,
  EffectSqlTable,
  IndexDefinition,
  ModelTableColumns,
  TableOptions,
  TableColumns,
} from "./types.js";

type PgColumn<
  Kind extends string,
  Config extends Record<string, unknown> | undefined = undefined,
> = EffectSqlColumn<
  "postgresql",
  Kind,
  DefaultColumnSchema<"postgresql", Kind, Config>,
  false,
  "none"
>;

type Pg = {
  Class: ReturnType<typeof defineClass<"postgresql">>;
  table: <const Model extends EffectSqlModel, const Columns extends TableColumns<Model>>(
    model: Model,
    options: Omit<TableOptions<Model, Columns>, "columns"> & {
      readonly columns: ModelTableColumns<Model, Columns>;
    },
  ) => EffectSqlTable<
    "postgresql",
    Model,
    DefinedTableColumns<"postgresql", ModelTableColumns<Model, Columns>>
  >;
  text: (name?: string) => PgColumn<"text">;
  varchar: (
    nameOrOptions?: string | { readonly length?: number },
    options?: { readonly length?: number },
  ) => PgColumn<"varchar", { readonly length?: number } | undefined>;
  uuid: (name?: string) => PgColumn<"uuid">;
  integer: (name?: string) => PgColumn<"integer">;
  bigint: (name?: string) => PgColumn<"bigint">;
  real: (name?: string) => PgColumn<"real">;
  doublePrecision: (name?: string) => PgColumn<"doublePrecision">;
  numeric: (
    nameOrOptions?: string | { readonly precision?: number; readonly scale?: number },
    options?: { readonly precision?: number; readonly scale?: number },
  ) => PgColumn<"numeric", { readonly precision?: number; readonly scale?: number } | undefined>;
  boolean: (name?: string) => PgColumn<"boolean">;
  json: (name?: string) => PgColumn<"json">;
  jsonb: (name?: string) => PgColumn<"jsonb">;
  timestamp: (
    nameOrOptions?: string | { readonly withTimezone?: boolean },
    options?: { readonly withTimezone?: boolean },
  ) => PgColumn<"timestamp", { readonly withTimezone?: boolean } | undefined>;
  date: (name?: string) => PgColumn<"date">;
  index: (name: string) => { readonly on: (...fields: string[]) => IndexDefinition };
  uniqueIndex: (name: string) => { readonly on: (...fields: string[]) => IndexDefinition };
};

export const pg: Pg = {
  Class: defineClass("postgresql"),
  table: <const Model extends EffectSqlModel, const Columns extends TableColumns<Model>>(
    model: Model,
    options: Omit<TableOptions<Model, Columns>, "columns"> & {
      readonly columns: ModelTableColumns<Model, Columns>;
    },
  ): EffectSqlTable<
    "postgresql",
    Model,
    DefinedTableColumns<"postgresql", ModelTableColumns<Model, Columns>>
  > => defineTable<"postgresql", Model, Columns>("postgresql", model, options),
  text: (name?: string) => makeColumn("postgresql", "text", name),
  varchar: (
    nameOrOptions?: string | { readonly length?: number },
    options?: { readonly length?: number },
  ) =>
    makeColumn(
      "postgresql",
      "varchar",
      typeof nameOrOptions === "string" ? nameOrOptions : undefined,
      typeof nameOrOptions === "object" ? nameOrOptions : options,
    ),
  uuid: (name?: string) => makeColumn("postgresql", "uuid", name),
  integer: (name?: string) => makeColumn("postgresql", "integer", name),
  bigint: (name?: string) => makeColumn("postgresql", "bigint", name),
  real: (name?: string) => makeColumn("postgresql", "real", name),
  doublePrecision: (name?: string) => makeColumn("postgresql", "doublePrecision", name),
  numeric: (
    nameOrOptions?: string | { readonly precision?: number; readonly scale?: number },
    options?: {
      readonly precision?: number;
      readonly scale?: number;
    },
  ) =>
    makeColumn(
      "postgresql",
      "numeric",
      typeof nameOrOptions === "string" ? nameOrOptions : undefined,
      typeof nameOrOptions === "object" ? nameOrOptions : options,
    ),
  boolean: (name?: string) => makeColumn("postgresql", "boolean", name),
  json: (name?: string) => makeColumn("postgresql", "json", name),
  jsonb: (name?: string) => makeColumn("postgresql", "jsonb", name),
  timestamp: (
    nameOrOptions?: string | { readonly withTimezone?: boolean },
    options?: {
      readonly withTimezone?: boolean;
    },
  ) =>
    makeColumn(
      "postgresql",
      "timestamp",
      typeof nameOrOptions === "string" ? nameOrOptions : undefined,
      typeof nameOrOptions === "object" ? nameOrOptions : options,
    ),
  date: (name?: string) => makeColumn("postgresql", "date", name),
  index: (name: string) => makeIndex("postgresql", false, name),
  uniqueIndex: (name: string) => makeIndex("postgresql", true, name),
};
