import { Predicate } from "effect";

export const activeRecord = <T extends { readonly deletedAt?: unknown }>(record: T | undefined) =>
  Predicate.isNullish(record?.deletedAt) ? record : undefined;

export const preserveOmitted = <Value>(
  value: Value | null | undefined,
  existingValue: Value | null | undefined,
) => (Predicate.isUndefined(value) ? existingValue : value);
