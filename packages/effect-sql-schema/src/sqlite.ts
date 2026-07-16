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

type SqliteColumn<
  Kind extends string,
  Config extends Record<string, unknown> | undefined = undefined,
> = EffectSqlColumn<"sqlite", Kind, DefaultColumnSchema<"sqlite", Kind, Config>, false, "none">;

type SqliteIntegerMode = "number" | "timestamp" | "timestamp_ms" | "boolean";

type SqliteIntegerConfig<Mode extends SqliteIntegerMode = SqliteIntegerMode> = {
  readonly mode: Mode;
};

type Sqlite = {
  Class: ReturnType<typeof defineClass<"sqlite">>;
  table: <const Model extends EffectSqlModel, const Columns extends TableColumns<Model>>(
    model: Model,
    options: Omit<TableOptions<Model, Columns>, "columns"> & {
      readonly columns: ModelTableColumns<Model, Columns>;
    },
  ) => EffectSqlTable<
    "sqlite",
    Model,
    DefinedTableColumns<"sqlite", ModelTableColumns<Model, Columns>>
  >;
  text: (name?: string) => SqliteColumn<"text">;
  integer: <const Config extends SqliteIntegerConfig | undefined = undefined>(
    nameOrOptions?: string | Config,
    options?: Config,
  ) => SqliteColumn<"integer", Config>;
  real: (name?: string) => SqliteColumn<"real">;
  blob: (name?: string) => SqliteColumn<"blob">;
  numeric: (name?: string) => SqliteColumn<"numeric">;
  index: (name: string) => { readonly on: (...fields: string[]) => IndexDefinition };
  uniqueIndex: (name: string) => { readonly on: (...fields: string[]) => IndexDefinition };
};

export const sqlite: Sqlite = {
  Class: defineClass("sqlite"),
  table: <const Model extends EffectSqlModel, const Columns extends TableColumns<Model>>(
    model: Model,
    options: Omit<TableOptions<Model, Columns>, "columns"> & {
      readonly columns: ModelTableColumns<Model, Columns>;
    },
  ): EffectSqlTable<
    "sqlite",
    Model,
    DefinedTableColumns<"sqlite", ModelTableColumns<Model, Columns>>
  > => defineTable<"sqlite", Model, Columns>("sqlite", model, options),
  text: (name?: string) => makeColumn("sqlite", "text", name),
  integer: <const Config extends SqliteIntegerConfig | undefined = undefined>(
    nameOrOptions?: string | Config,
    options?: Config,
  ) =>
    makeColumn(
      "sqlite",
      "integer",
      typeof nameOrOptions === "string" ? nameOrOptions : undefined,
      typeof nameOrOptions === "object" ? nameOrOptions : options,
    ),
  real: (name?: string) => makeColumn("sqlite", "real", name),
  blob: (name?: string) => makeColumn("sqlite", "blob", name),
  numeric: (name?: string) => makeColumn("sqlite", "numeric", name),
  index: (name: string) => makeIndex("sqlite", false, name),
  uniqueIndex: (name: string) => makeIndex("sqlite", true, name),
};
