import { makeColumn } from "./columns";
import { defineClass, defineTable, makeIndex } from "./table";
import type { EffectSqlModel, TableOptions } from "./types";

export const pg = {
  Class: defineClass("postgresql"),
  table: <const Model extends EffectSqlModel>(model: Model, options: TableOptions<Model>) =>
    defineTable("postgresql", model, options),
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
