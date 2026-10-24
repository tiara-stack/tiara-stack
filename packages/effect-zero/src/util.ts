export const typedEntries = <T extends object>(
  value: T,
): Array<[Extract<keyof T, string>, T[Extract<keyof T, string>]]> =>
  Object.entries(
    value,
  ) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as Array<
    [Extract<keyof T, string>, T[Extract<keyof T, string>]]
  > /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
