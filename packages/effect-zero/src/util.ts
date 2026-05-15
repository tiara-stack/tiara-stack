export const typedEntries = <T extends object>(
  value: T,
): Array<[Extract<keyof T, string>, T[Extract<keyof T, string>]]> =>
  Object.entries(value) as Array<[Extract<keyof T, string>, T[Extract<keyof T, string>]]>;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
