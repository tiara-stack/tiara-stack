import { Predicate } from "effect";

export const getObjectField = (value: unknown, field: string): unknown =>
  Predicate.isObject(value) ? (value as Record<string, unknown>)[field] : undefined;

export const getStringField = (value: unknown, field: string): string | undefined => {
  const fieldValue = getObjectField(value, field);
  return Predicate.isString(fieldValue) ? fieldValue : undefined;
};

export const getNumberField = (value: unknown, field: string): number | undefined => {
  const fieldValue = getObjectField(value, field);
  return Predicate.isNumber(fieldValue) ? fieldValue : undefined;
};
