import { Schema } from "effect";
import type { Dialect } from "../types";

export const defaultColumnSchema = (
  dialect: Dialect,
  kind: string,
  config?: Record<string, unknown>,
) => {
  switch (kind) {
    case "integer":
      if (dialect === "sqlite" && config?.mode === "boolean") {
        return Schema.Boolean;
      }
      return dialect === "postgresql" ? Schema.Int : Schema.Number;
    case "bigint":
      return Schema.BigInt;
    case "real":
    case "doublePrecision":
    case "numeric":
      return Schema.Number;
    case "boolean":
      return Schema.Boolean;
    case "json":
    case "jsonb":
    case "blob":
      return Schema.Unknown;
    case "timestamp":
    case "date":
      return Schema.Number;
    case "text":
    case "varchar":
    case "uuid":
    default:
      return Schema.String;
  }
};
