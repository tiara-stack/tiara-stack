import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { Cause, Context, Data, Effect, Exit, Layer, Option, Predicate } from "effect";
import { GoogleAuth } from "google-auth-library";
import { readSheetsValueRanges } from "../shared/runnerLocalSheets";
import { actualMatchesExpectedCells, parseA1Start, type SheetValueUpdate } from "./pure";

export type TeamSubmissionValueRange = {
  readonly range: string;
  readonly values: ReadonlyArray<ReadonlyArray<string>>;
};

export class TeamSubmissionProviderError extends Data.TaggedError("TeamSubmissionProviderError")<{
  readonly operation: "create-client" | "read" | "write" | "append";
  readonly cause: unknown;
}> {}

export class TeamSubmissionWriteError extends Data.TaggedError("TeamSubmissionWriteError")<{
  readonly operation: "write" | "append";
  readonly ambiguous: boolean;
  readonly cause: unknown;
}> {}

export interface TeamSubmissionProviderShape {
  readonly read: (
    spreadsheetId: string,
    ranges: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<TeamSubmissionValueRange>, TeamSubmissionProviderError>;
  readonly write: (
    spreadsheetId: string,
    updates: ReadonlyArray<SheetValueUpdate>,
  ) => Effect.Effect<void, TeamSubmissionWriteError>;
  readonly append: (
    spreadsheetId: string,
    range: string,
    values: ReadonlyArray<ReadonlyArray<string>>,
  ) => Effect.Effect<string, TeamSubmissionWriteError>;
}

export class TeamSubmissionProvider extends Context.Service<
  TeamSubmissionProvider,
  TeamSubmissionProviderShape
>()("sheet-workflows/TeamSubmissionProvider") {}

// These failures prove the request could not have reached the Sheets API.
const deterministicTransportCodes = new Set(["ECONNREFUSED", "ENOTFOUND"]);
const deterministicResponseStatuses = new Set([400, 401, 404]);
const ambiguousResponseStatuses = new Set([403, 408, 429]);

// fallow-ignore-next-line code-duplication
const hasAmbiguousGoogleQuotaReason = (cause: unknown): boolean => {
  const response = Predicate.hasProperty(cause, "response") ? cause.response : undefined;
  const responseData = Predicate.hasProperty(response, "data") ? response.data : undefined;
  const responseError = Predicate.hasProperty(responseData, "error")
    ? responseData.error
    : undefined;
  const responseErrors = Predicate.hasProperty(responseError, "errors")
    ? responseError.errors
    : undefined;
  return (
    Array.isArray(responseErrors) &&
    responseErrors.some(
      (error) =>
        Predicate.hasProperty(error, "reason") &&
        (error.reason === "rateLimitExceeded" || error.reason === "userRateLimitExceeded"),
    )
  );
};

const responseStatusFromCause = (cause: unknown) => {
  const response = Predicate.hasProperty(cause, "response") ? cause.response : undefined;
  return Predicate.hasProperty(response, "status") ? response.status : undefined;
};

const isAmbiguousResponseStatus = (status: unknown): boolean =>
  Predicate.isNumber(status) && (ambiguousResponseStatuses.has(status) || status >= 500);

const isDeterministicResponseStatus = (status: unknown): boolean =>
  Predicate.isNumber(status) && deterministicResponseStatuses.has(status);

const isDeterministicTransportFailure = (cause: unknown): boolean => {
  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
  return Predicate.isString(code) && deterministicTransportCodes.has(code);
};

const isAmbiguousWriteCause = (cause: unknown): boolean => {
  if (hasAmbiguousGoogleQuotaReason(cause)) return true;
  const responseStatus = responseStatusFromCause(cause);
  if (isAmbiguousResponseStatus(responseStatus)) return true;
  if (isDeterministicResponseStatus(responseStatus)) return false;
  // Without a status or string code, assume the write may have reached Sheets. Batch updates can
  // be read back before an idempotent retry; appends only reconcile and never repeat the append.
  return !isDeterministicTransportFailure(cause);
};

const cellString = (value: unknown) =>
  Predicate.isNullish(value) ? "" : Predicate.isString(value) ? value : globalThis.String(value);

const valueRangeRows = (
  valueRange:
    | {
        readonly values?: ReadonlyArray<ReadonlyArray<unknown>> | null | undefined;
      }
    | undefined,
) => (valueRange?.values ?? []).map((row) => row.map(cellString));

const appendReconciliationRowLimit = 1_000;

const boundedAppendReadRange = (range: string): string => {
  const start = parseA1Start(range);
  if (start === null) return range;
  const endColumn = /:([A-Z]+)(?:\d+)?$/i.exec(range.trim())?.[1] ?? start.column;
  return `'${start.sheet.replaceAll("'", "''")}'!${start.column}${start.row}:${endColumn}${
    start.row + appendReconciliationRowLimit - 1
  }`;
};

export const makeTeamSubmissionProvider = (
  client: sheets_v4.Sheets,
): TeamSubmissionProviderShape => {
  const read: TeamSubmissionProviderShape["read"] = (spreadsheetId, ranges) =>
    ranges.length === 0
      ? Effect.succeed([])
      : readSheetsValueRanges({
          client,
          spreadsheetId,
          ranges,
          makeError: (cause) => new TeamSubmissionProviderError({ operation: "read", cause }),
        }).pipe(
          Effect.map((valueRanges) =>
            valueRanges.map((valueRange, index) => ({
              range: ranges[index] ?? "",
              values: valueRangeRows(valueRange),
            })),
          ),
        );

  const writeOnce = (spreadsheetId: string, updates: ReadonlyArray<SheetValueUpdate>) =>
    Effect.tryPromise({
      try: (signal) =>
        client.spreadsheets.values.batchUpdate(
          {
            spreadsheetId,
            requestBody: {
              valueInputOption: "USER_ENTERED",
              data: updates.map(({ range, values }) => ({ range, values: [...values] })),
            },
          },
          { signal },
        ),
      catch: (cause) =>
        new TeamSubmissionWriteError({
          operation: "write",
          ambiguous: isAmbiguousWriteCause(cause),
          cause,
        }),
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        Predicate.isTagged("TeamSubmissionWriteError")(error)
          ? error
          : new TeamSubmissionWriteError({ operation: "write", ambiguous: true, cause: error }),
      ),
    );

  const write: TeamSubmissionProviderShape["write"] = (spreadsheetId, updates) =>
    Effect.gen(function* () {
      if (updates.length === 0) return;
      const result = yield* writeOnce(spreadsheetId, updates).pipe(Effect.exit);
      if (Exit.isSuccess(result)) return;
      const failure = result.cause;
      if (Cause.hasInterrupts(failure)) return yield* Effect.failCause(failure);
      const error = Cause.findErrorOption(failure);
      if (Option.isNone(error) || !error.value.ambiguous) return yield* Effect.failCause(failure);
      const live = yield* read(
        spreadsheetId,
        updates.map(({ range }) => range),
      ).pipe(
        Effect.mapError(
          (cause) => new TeamSubmissionWriteError({ operation: "write", ambiguous: true, cause }),
        ),
        Effect.exit,
      );
      if (
        Exit.isSuccess(live) &&
        updates.every((update, index) =>
          actualMatchesExpectedCells(live.value[index]?.values ?? [], update.values),
        )
      ) {
        return;
      }
      // batchUpdate sets absolute cell values, so repeating these updates is idempotent.
      return yield* writeOnce(spreadsheetId, updates).pipe(Effect.asVoid);
    });

  const appendOnce = (
    spreadsheetId: string,
    range: string,
    values: ReadonlyArray<ReadonlyArray<string>>,
  ) =>
    Effect.tryPromise({
      try: (signal) =>
        client.spreadsheets.values.append(
          {
            spreadsheetId,
            range,
            valueInputOption: "USER_ENTERED",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: values.map((row) => [...row]) },
          },
          { signal },
        ),
      catch: (cause) =>
        new TeamSubmissionWriteError({
          operation: "append",
          ambiguous: isAmbiguousWriteCause(cause),
          cause,
        }),
    }).pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((error) =>
        Predicate.isTagged("TeamSubmissionWriteError")(error)
          ? error
          : new TeamSubmissionWriteError({ operation: "append", ambiguous: true, cause: error }),
      ),
      Effect.map((response) => response.data.updates?.updatedRange ?? ""),
    );

  // fallow-ignore-next-line complexity
  const append: TeamSubmissionProviderShape["append"] = (spreadsheetId, range, values) =>
    // fallow-ignore-next-line complexity
    Effect.gen(function* () {
      const result = yield* appendOnce(spreadsheetId, range, values).pipe(Effect.exit);
      if (Exit.isSuccess(result)) return result.value;
      const failure = result.cause;
      if (Cause.hasInterrupts(failure)) return yield* Effect.failCause(failure);
      const error = Cause.findErrorOption(failure);
      if (Option.isNone(error)) return yield* Effect.failCause(failure);
      if (error.value.ambiguous) {
        const live = yield* read(spreadsheetId, [boundedAppendReadRange(range)]).pipe(Effect.exit);
        if (Exit.isFailure(live)) {
          yield* Effect.logWarning("Team submission append read-back failed", live.cause).pipe(
            Effect.annotateLogs({ operation: "append", range }),
          );
        }
        const start = parseA1Start(range);
        if (values.length === 1 && start !== null && Exit.isSuccess(live)) {
          const matches = live.value[0]?.values ?? [];
          const matchingRows = matches.flatMap((row, index) =>
            actualMatchesExpectedCells([row], values) ? [index] : [],
          );
          if (matchingRows.length === 1) {
            const row = start.row + (matchingRows[0] ?? 0);
            return `'${start.sheet.replaceAll("'", "''")}'!${start.column}${row}`;
          }
        }
        return yield* Effect.fail(error.value);
      }
      return yield* Effect.failCause(failure);
    });

  return { read, write, append };
};

export const teamSubmissionProviderLayer = Layer.effect(
  TeamSubmissionProvider,
  Effect.gen(function* () {
    const auth = yield* Effect.try({
      try: () => new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] }),
      catch: (cause) => new TeamSubmissionProviderError({ operation: "create-client", cause }),
    });
    const client = yield* Effect.try({
      try: () => sheets({ version: "v4", auth }),
      catch: (cause) => new TeamSubmissionProviderError({ operation: "create-client", cause }),
    });
    return makeTeamSubmissionProvider(client);
  }),
);
