import { Option } from "effect";

// Normalize nullable persistence rows and decoded Option values to one optional representation.
export const optionValue = <A>(
  value: Option.Option<A> | (A extends Option.Option<unknown> ? never : A) | null | undefined,
): A | undefined => (Option.isOption(value) ? Option.getOrUndefined(value) : (value ?? undefined));
