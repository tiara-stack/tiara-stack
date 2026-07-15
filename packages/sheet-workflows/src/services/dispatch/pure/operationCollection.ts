type UnionToIntersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
  value: infer Intersection,
) => void
  ? Intersection
  : never;

type MergedOperationCollection<Operations extends ReadonlyArray<object>> =
  Operations extends readonly [] ? Record<never, never> : UnionToIntersection<Operations[number]>;

type UniqueOperationCollection<
  Operations extends ReadonlyArray<object>,
  Seen extends object = object,
> = Operations extends readonly [
  infer Head extends object,
  ...infer Tail extends ReadonlyArray<object>,
]
  ? readonly [
      Head & Record<Extract<keyof Seen, keyof Head>, never>,
      ...UniqueOperationCollection<Tail, Seen & Head>,
    ]
  : readonly [];

// Duplicate operation names are rejected through Record<..., never> before
// the verified operation objects are combined at runtime.
export const mergeUniqueOperations = <const Operations extends ReadonlyArray<object>>(
  operations: Operations & UniqueOperationCollection<Operations>,
) =>
  operations.reduce<object>(
    (merged, operation) => ({ ...merged, ...operation }),
    {},
  ) as MergedOperationCollection<Operations>;
