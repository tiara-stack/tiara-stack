export const preserveOmitted = <Value>(
  value: Value | null | undefined,
  existingValue: Value | null | undefined,
) => (typeof value === "undefined" ? existingValue : value);
