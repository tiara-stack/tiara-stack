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

export type DefaultColumnSchema<
  D extends Dialect,
  K extends string,
  Config extends Record<string, unknown> | undefined,
> = K extends "bigint"
  ? typeof Schema.BigInt
  : K extends "real" | "doublePrecision" | "numeric" | "timestamp" | "date"
    ? typeof Schema.Number
    : K extends "boolean"
      ? typeof Schema.Boolean
      : K extends "json" | "jsonb" | "blob"
        ? typeof Schema.Unknown
        : K extends "integer"
          ? D extends "sqlite"
            ? Config extends { readonly mode: "boolean" }
              ? typeof Schema.Boolean
              : typeof Schema.Number
            : typeof Schema.Int
          : typeof Schema.String;

export const defaultColumnSchema = <
  const D extends Dialect,
  const K extends string,
  const Config extends Record<string, unknown> | undefined,
>(
  dialect: D,
  kind: K,
  config?: Config,
): DefaultColumnSchema<D, K, Config> => {
  if (kind === "integer") {
    if (dialect === "sqlite" && config?.mode === "boolean") {
      return Schema.Boolean as DefaultColumnSchema<D, K, Config>;
    }
    return (dialect === "postgresql" ? Schema.Int : Schema.Number) as DefaultColumnSchema<
      D,
      K,
      Config
    >;
  }

  return (defaultKindSchemas[kind] ?? Schema.String) as DefaultColumnSchema<D, K, Config>;
};
