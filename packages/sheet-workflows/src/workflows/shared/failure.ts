import { Cause, Predicate, Result, Schema } from "effect";
import type { WorkflowJson } from "effect-zero-workflow";

const systemFailure = Schema.decodeUnknownSync(Schema.Json)({
  _tag: "System",
  code: "UnexpectedFailure",
  retryable: false,
});

export const materializeWorkflowFailure = (
  isDeclaredFailure: Predicate.Refinement<unknown, unknown>,
  cause: Cause.Cause<unknown>,
): WorkflowJson => {
  const reason = cause.reasons.find(Cause.isFailReason);
  const declared =
    Predicate.isNotUndefined(reason) && isDeclaredFailure(reason.error) ? reason.error : undefined;
  const decoded = Schema.decodeUnknownResult(Schema.Json)(
    Predicate.isNotUndefined(declared) ? { _tag: "Declared", error: declared } : systemFailure,
  );
  return Result.isSuccess(decoded) ? decoded.success : systemFailure;
};
