import { Predicate } from "effect";

const interactionFailureHandled = Symbol.for("tiara.sheetWorkflows.interactionFailureHandled");

type InternalHandledInteractionFailure = {
  readonly [interactionFailureHandled]: true;
  readonly error: unknown;
};

export interface HandledInteractionFailure {
  readonly error: unknown;
}

export const markInteractionFailureHandled = (error: unknown): HandledInteractionFailure => {
  const handled: InternalHandledInteractionFailure = {
    [interactionFailureHandled]: true,
    error,
  };

  return handled;
};

export const isInteractionFailureHandled = (error: unknown): error is HandledInteractionFailure =>
  Predicate.hasProperty(error, interactionFailureHandled) &&
  (error as { readonly [interactionFailureHandled]?: unknown })[interactionFailureHandled] === true;

export const unwrapInteractionFailure = (error: unknown): unknown =>
  isInteractionFailureHandled(error) ? error.error : error;
