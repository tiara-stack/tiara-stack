import { Cause, Option, Predicate } from "effect";

const entityFailureMessage = "Dispatch failed. Please try again.";

const errorDetailLabels = {
  ArgumentError: "Request error",
  GoogleSheetsError: "Google Sheets error",
  ParserFieldError: "Invalid sheet data",
  QueryResultAppError: "Database error",
  QueryResultParseError: "Database error",
  SchemaError: "Data format error",
  SheetConfigError: "Sheet config error",
  Unauthorized: "Authorization error",
  UnknownError: "Unexpected error",
} as const;

const errorDetailLabelTags = new Set<string>(Object.keys(errorDetailLabels));

const isErrorDetailLabelTag = (tag: string): tag is keyof typeof errorDetailLabels =>
  errorDetailLabelTags.has(tag);

const errorMessage = (error: unknown): Option.Option<string> =>
  Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
    ? Option.some(error.message)
    : Option.none();

const errorDetailLabel = (error: unknown): Option.Option<string> => {
  if (!Predicate.hasProperty(error, "_tag") || !Predicate.isString(error._tag)) {
    return Predicate.isError(error) ? Option.some("Unexpected error") : Option.none();
  }

  return isErrorDetailLabelTag(error._tag)
    ? Option.some(errorDetailLabels[error._tag])
    : errorMessage(error).pipe(Option.as("Unexpected error"));
};

export const dispatchFailureMessage = (error: unknown): string => {
  const detail = errorDetailLabel(error).pipe(Option.getOrUndefined);

  return detail ? `${entityFailureMessage}\n${detail}.` : entityFailureMessage;
};

export const dispatchFailureTrace = (error: unknown) => {
  const cause = Cause.isCause(error) ? error : Cause.fail(error);
  const trace = Cause.pretty(cause).trim();

  return trace.length > 0
    ? trace
    : errorMessage(error).pipe(Option.getOrElse(() => "Unknown error"));
};

export const dispatchFailureResponse = (_error: unknown, correlationId: string) => ({
  payload: {
    content: `${entityFailureMessage}\nReference: ${correlationId}`,
    allowedMentions: "none" as const,
  },
});
