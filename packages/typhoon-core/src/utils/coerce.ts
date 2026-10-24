export type CoercedTrue<T extends boolean | undefined> = T extends undefined ? true : T;
export type CoercedFalse<T extends boolean | undefined> = T extends undefined ? false : T;

export const coerceTrue = <T extends boolean | undefined>(value: T): CoercedTrue<T> => {
  return (value ??
    true) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as CoercedTrue<T> /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
};

export const coerceFalse = <T extends boolean | undefined>(value: T): CoercedFalse<T> => {
  return (value ??
    false) /* oxlint-disable typescript/no-unsafe-type-assertion -- inherited master site */ as CoercedFalse<T> /* oxlint-enable typescript/no-unsafe-type-assertion -- inherited master site */;
};
