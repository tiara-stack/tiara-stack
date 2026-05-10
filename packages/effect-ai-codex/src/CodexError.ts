import * as Data from "effect/Data";

export class CodexSdkError extends Data.TaggedError("CodexSdkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CodexTimeout extends Data.TaggedError("CodexTimeout")<{
  readonly timeoutMs: number;
}> {}

export class CodexInvalidOutputSchema extends Data.TaggedError("CodexInvalidOutputSchema")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class CodexStreamParseError extends Data.TaggedError("CodexStreamParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type CodexError =
  | CodexSdkError
  | CodexTimeout
  | CodexInvalidOutputSchema
  | CodexStreamParseError;

export const messageFromCause = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Codex SDK operation failed";
