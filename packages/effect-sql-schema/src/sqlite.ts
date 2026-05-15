import { makeColumn } from "./columns";
import { defineClass, defineTable, makeIndex } from "./table";
import type { EffectSqlModel, TableOptions } from "./types";

export const sqlite = {
  Class: defineClass("sqlite"),
  table: <const Model extends EffectSqlModel>(model: Model, options: TableOptions<Model>) =>
    defineTable("sqlite", model, options),
  text: (name?: string) => makeColumn("sqlite", "text", name),
  integer: (
    nameOrOptions?: string | { readonly mode?: string },
    options?: { readonly mode?: string },
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
