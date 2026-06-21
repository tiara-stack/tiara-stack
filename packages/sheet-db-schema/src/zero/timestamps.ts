import { Predicate } from "effect";

export const preserveOmitted = <Value>(
  value: Value | null | undefined,
  existingValue: Value | null | undefined,
) => (Predicate.isUndefined(value) ? existingValue : value);
