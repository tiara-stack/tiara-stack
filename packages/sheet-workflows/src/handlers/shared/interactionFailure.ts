const interactionFailureHandled = Symbol.for("tiara.sheetWorkflows.interactionFailureHandled");

type HandledInteractionFailure = {
  readonly [interactionFailureHandled]: true;
  readonly error: unknown;
};

export const markInteractionFailureHandled = (error: unknown): HandledInteractionFailure => ({
  [interactionFailureHandled]: true,
  error,
});

export const isInteractionFailureHandled = (error: unknown): error is HandledInteractionFailure =>
  typeof error === "object" &&
  error !== null &&
  interactionFailureHandled in error &&
  (error as { readonly [interactionFailureHandled]?: unknown })[interactionFailureHandled] === true;

export const unwrapInteractionFailure = (error: unknown): unknown =>
  isInteractionFailureHandled(error) ? error.error : error;
