import { Predicate } from "effect";

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
  Predicate.hasProperty(error, interactionFailureHandled) &&
  (error as { readonly [interactionFailureHandled]?: unknown })[interactionFailureHandled] === true;

export const unwrapInteractionFailure = (error: unknown): unknown =>
  isInteractionFailureHandled(error) ? error.error : error;
