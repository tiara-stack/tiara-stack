import * as Data from "effect/Data";

export const messageFromCause = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "string"
      ? cause
      : "Kimi SDK operation failed";

export class KimiSdkError extends Data.TaggedError("KimiSdkError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class KimiTimeout extends Data.TaggedError("KimiTimeout")<{
  readonly timeoutMs: number;
}> {
  override get message() {
    return `Kimi timed out after ${this.timeoutMs}ms`;
  }
}

export class KimiQuestionUnsupported extends Data.TaggedError("KimiQuestionUnsupported")<{
  readonly questionId: string;
  readonly message: string;
}> {}

export class KimiStreamParseError extends Data.TaggedError("KimiStreamParseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class KimiConfigurationError extends Data.TaggedError("KimiConfigurationError")<{
  readonly message: string;
}> {}

export type KimiError =
  | KimiSdkError
  | KimiTimeout
  | KimiQuestionUnsupported
  | KimiStreamParseError
  | KimiConfigurationError;
