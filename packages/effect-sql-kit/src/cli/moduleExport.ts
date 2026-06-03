import type { EffectSqlSchema } from "../types";

export const isEffectSqlSchema = (value: unknown): value is EffectSqlSchema =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "EffectSqlSchema" &&
  "tables" in value &&
  typeof value.tables === "object" &&
  value.tables !== null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
