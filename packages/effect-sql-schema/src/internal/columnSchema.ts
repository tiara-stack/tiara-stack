import { Schema } from "effect";
import type { Dialect } from "../types";

const defaultKindSchemas: Record<string, Schema.Top> = {
  bigint: Schema.BigInt,
  real: Schema.Number,
  doublePrecision: Schema.Number,
  numeric: Schema.Number,
  boolean: Schema.Boolean,
  json: Schema.Unknown,
  jsonb: Schema.Unknown,
  blob: Schema.Unknown,
  timestamp: Schema.Number,
  date: Schema.Number,
  text: Schema.String,
  varchar: Schema.String,
  uuid: Schema.String,
};

export const defaultColumnSchema = (
  dialect: Dialect,
  kind: string,
  config?: Record<string, unknown>,
) => {
  if (kind === "integer") {
    if (dialect === "sqlite" && config?.mode === "boolean") {
      return Schema.Boolean;
    }
    return dialect === "postgresql" ? Schema.Int : Schema.Number;
  }

  return defaultKindSchemas[kind] ?? Schema.String;
};
