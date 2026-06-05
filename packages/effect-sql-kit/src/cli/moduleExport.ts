import { Predicate } from "effect";
import type { EffectSqlSchema } from "../types";

export const isEffectSqlSchema = (value: unknown): value is EffectSqlSchema =>
  Predicate.hasProperty(value, "_tag") &&
  value._tag === "EffectSqlSchema" &&
  Predicate.hasProperty(value, "tables") &&
  Predicate.isObject(value.tables);

const isRecord = (value: unknown): value is Record<string, unknown> => Predicate.isObject(value);

const unwrapDefault = (value: unknown): unknown =>
  isRecord(value) && "default" in value && value.default !== undefined ? value.default : value;

export const resolveConfigExport = (imported: Record<string, unknown>): unknown =>
  unwrapDefault(imported);

export const resolveSchemaExport = (imported: Record<string, unknown>): unknown => {
  const direct = unwrapDefault(imported);
  if (isEffectSqlSchema(direct)) {
    return direct;
  }
  if (isRecord(direct) && "schema" in direct) {
    return unwrapDefault(direct.schema);
  }
  if ("schema" in imported) {
    return unwrapDefault(imported.schema);
  }
  return direct;
};
