import { Cause, Predicate } from "effect";

const providerCauseKinds: ReadonlyArray<readonly [(cause: unknown) => boolean, string]> = [
  [Cause.isTimeoutError, "timeout"],
  [
    (cause) =>
      Predicate.hasProperty(cause, "response") &&
      Predicate.hasProperty(cause.response, "status") &&
      Predicate.isNumber(cause.response.status),
    "http-response",
  ],
  [
    (cause) => Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code),
    "coded-error",
  ],
  [
    (cause) => Predicate.hasProperty(cause, "_tag") && Predicate.isString(cause._tag),
    "tagged-error",
  ],
  [Predicate.isError, "error"],
];

export const providerCauseKind = (cause: unknown): string =>
  providerCauseKinds.find(([matches]) => matches(cause))?.[1] ?? "unknown";
