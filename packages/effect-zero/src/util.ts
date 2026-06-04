export const typedEntries = <T extends object>(
  value: T,
): Array<[Extract<keyof T, string>, T[Extract<keyof T, string>]]> =>
  Object.entries(value) as Array<[Extract<keyof T, string>, T[Extract<keyof T, string>]]>;
