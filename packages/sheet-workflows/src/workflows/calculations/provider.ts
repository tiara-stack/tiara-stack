import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate, Schedule } from "effect";
import { GoogleAuth } from "google-auth-library";
import {
  calculationProjectionStartColumnIndex,
  calculationProjectionStartRowIndex,
  calculationProjectionWidth,
} from "../shared/calculationRange";
import type { WebSheetConfiguration } from "sheet-domain";
import { isRetryableRunnerLocalSheetsReadFailure } from "../shared/runnerLocalSheets";
import { loadWebConfigurationSheetAdapter } from "../shared/webConfigurationSheets";
import {
  maximumPersistedCalculationCells,
  maximumPersistedCalculationRows,
  type CalculationCell,
  type CalculationRows,
  type CalculationSourceSnapshot,
} from "./schema";
import { makeCalculationSourceReadPlan } from "./source";

export class CalculationProviderError extends Data.TaggedError("CalculationProviderError")<{
  readonly operation:
    | "create-client"
    | "read-source"
    | "read-projection"
    | "read-projection-metadata"
    | "write-projection";
  readonly cause: unknown;
}> {}

export class CalculationTargetError extends Data.TaggedError("CalculationTargetError")<{
  readonly code: "MissingSheet" | "NonCanonicalSheet";
}> {}

export class CalculationProjectionWriteError extends Data.TaggedError(
  "CalculationProjectionWriteError",
)<{
  readonly ambiguous: boolean;
  /** True when a live precondition changed before this write could start. */
  readonly conflicting?: boolean;
  readonly cause: unknown;
}> {}

export interface LoadCalculationSourceOptions {
  readonly spreadsheetId: string;
  readonly sheetTitle: string;
  readonly canonicalSheetRef: string;
  /** Omit for the legacy Settings Tab; provide the active owned source for native reads. */
  readonly configuration?: WebSheetConfiguration | null;
}

export interface WriteCalculationProjectionOptions {
  readonly spreadsheetId: string;
  readonly sheetId: number;
  readonly sheetTitle: string;
  readonly canonicalSheetRef: string;
  readonly desiredRows: CalculationRows;
  readonly preWriteRows: CalculationRows;
}

export interface CalculationProviderShape {
  readonly load: (
    options: LoadCalculationSourceOptions,
  ) => Effect.Effect<CalculationSourceSnapshot, CalculationProviderError | CalculationTargetError>;
  readonly readProjection: (
    spreadsheetId: string,
    canonicalSheetRef: string,
  ) => Effect.Effect<CalculationRows, CalculationProviderError>;
  readonly replaceProjection: (
    options: WriteCalculationProjectionOptions,
  ) => Effect.Effect<void, CalculationProjectionWriteError>;
}

export class CalculationProvider extends Context.Service<
  CalculationProvider,
  CalculationProviderShape
>()("sheet-workflows/CalculationProvider") {}

const configurationRange = "'Thee''s Sheet Settings'!B8:C";
const teamConfigurationRange = "'Thee''s Sheet Settings'!E8:M";
const maximumSourceRangesPerBatch = 50;
const maximumProjectionRows = maximumPersistedCalculationRows;

const cell = (value: unknown): CalculationCell =>
  Predicate.isString(value) || Predicate.isNumber(value) || Predicate.isBoolean(value)
    ? value
    : null;

const rowsFrom = (range: sheets_v4.Schema$ValueRange | undefined): CalculationRows =>
  (range?.values ?? []).map((row) => row.map(cell));

const rowsFromValues = (rows: ReadonlyArray<ReadonlyArray<unknown>>): CalculationRows =>
  rows.map((row) => row.map(cell));

const sourceRangeBatches = (ranges: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  Array.from({ length: Math.ceil(ranges.length / maximumSourceRangesPerBatch) }, (_, index) =>
    ranges.slice(index * maximumSourceRangesPerBatch, (index + 1) * maximumSourceRangesPerBatch),
  );

const retrySchedule = Schedule.exponential("100 millis").pipe(Schedule.jittered);
const ambiguousTransportCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

const readRequest = <A>(
  operation: CalculationProviderError["operation"],
  request: (signal: AbortSignal) => Promise<A>,
) =>
  Effect.tryPromise({
    try: (signal) => request(signal),
    catch: (cause) => new CalculationProviderError({ operation, cause }),
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((error) =>
      Predicate.isTagged("CalculationProviderError")(error)
        ? error
        : new CalculationProviderError({ operation, cause: error }),
    ),
    Effect.retry({
      schedule: retrySchedule,
      times: 2,
      while: isRetryableRunnerLocalSheetsReadFailure,
    }),
  );

// Write ambiguity is intentionally classified separately from the bounded read retry policy.
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

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 429 || status >= 500;

const isAmbiguousWriteCode = (code: unknown): boolean =>
  Predicate.isNumber(code)
    ? isRetryableStatus(code)
    : Predicate.isString(code)
      ? ambiguousTransportCodes.has(code)
      : true;

const isAmbiguousWriteCause = (cause: unknown): boolean => {
  if (hasAmbiguousGoogleQuotaReason(cause)) return true;
  const response = Predicate.hasProperty(cause, "response") ? cause.response : undefined;
  const status = Predicate.hasProperty(response, "status") ? response.status : undefined;
  if (Predicate.isNumber(status)) return isRetryableStatus(status);
  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
  return isAmbiguousWriteCode(code);
};

const cellData = (value: CalculationCell): sheets_v4.Schema$CellData => {
  if (Predicate.isNull(value)) return {};
  if (Predicate.isString(value)) return { userEnteredValue: { stringValue: value } };
  if (Predicate.isBoolean(value)) return { userEnteredValue: { boolValue: value } };
  if (!Number.isFinite(value)) return {};
  return { userEnteredValue: { numberValue: value } };
};

const updateRows = (
  desiredRows: CalculationRows,
  preWriteRows: CalculationRows,
): ReadonlyArray<sheets_v4.Schema$RowData> => {
  const rowCount = Math.min(
    maximumProjectionRows,
    Math.max(1, desiredRows.length, preWriteRows.length),
  );
  return Array.from({ length: rowCount }, (_, rowIndex) => ({
    values: Array.from({ length: calculationProjectionWidth }, (_, columnIndex) =>
      cellData(desiredRows[rowIndex]?.[columnIndex] ?? null),
    ),
  }));
};

const projectionCellCount = (rows: CalculationRows): number =>
  rows.reduce((total, row) => total + row.length, 0);

const projectionLimitError = (label: string, rows: CalculationRows): string | undefined => {
  if (rows.length > maximumProjectionRows) {
    return `The ${label} projection has ${rows.length} rows, but the persisted write holds at most ${maximumProjectionRows}`;
  }
  if (projectionCellCount(rows) > maximumPersistedCalculationCells) {
    return `The ${label} projection exceeds the persisted cell limit of ${maximumPersistedCalculationCells}`;
  }
  return undefined;
};

const isBlankProjectionCell = (value: CalculationCell | undefined): boolean =>
  Predicate.isNullish(value) || value === "";

const normalizedCell = (value: CalculationCell | undefined): CalculationCell => {
  if (Predicate.isUndefined(value) || Predicate.isNull(value) || value === "") return null;
  if (Predicate.isNumber(value) && !Number.isFinite(value)) return null;
  return value;
};

const normalizedRowLength = (row: ReadonlyArray<CalculationCell>): number => {
  let length = row.length;
  while (length > 0 && isBlankProjectionCell(row[length - 1])) length--;
  return length;
};

const normalizedRowCount = (rows: CalculationRows): number => {
  let count = rows.length;
  while (count > 0 && normalizedRowLength(rows[count - 1]!) === 0) count--;
  return count;
};

export const sameCalculationRows = (left: CalculationRows, right: CalculationRows): boolean => {
  const rowCount = normalizedRowCount(left);
  if (rowCount !== normalizedRowCount(right)) return false;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const leftRow = left[rowIndex]!;
    const rightRow = right[rowIndex]!;
    const width = normalizedRowLength(leftRow);
    if (width !== normalizedRowLength(rightRow)) return false;
    for (let columnIndex = 0; columnIndex < width; columnIndex++) {
      if (normalizedCell(leftRow[columnIndex]) !== normalizedCell(rightRow[columnIndex])) {
        return false;
      }
    }
  }
  return true;
};

export const makeCalculationProvider = (client: sheets_v4.Sheets): CalculationProviderShape => {
  const readProjection: CalculationProviderShape["readProjection"] = (
    spreadsheetId,
    canonicalSheetRef,
  ) =>
    readRequest("read-projection", (signal) =>
      client.spreadsheets.values.batchGet(
        {
          spreadsheetId,
          ranges: [canonicalSheetRef],
          valueRenderOption: "UNFORMATTED_VALUE",
          dateTimeRenderOption: "SERIAL_NUMBER",
        },
        { signal },
      ),
    ).pipe(Effect.map(({ data }) => rowsFrom(data.valueRanges?.[0])));

  return {
    // Source reads intentionally coordinate metadata, configuration, chunked ranges, and alignment.
    load: ({ canonicalSheetRef, configuration, sheetTitle, spreadsheetId }) =>
      // fallow-ignore-next-line complexity
      Effect.gen(function* () {
        const usesWebConfiguration = Predicate.isNotNullish(configuration);
        if (usesWebConfiguration && configuration.spreadsheetId !== spreadsheetId) {
          return yield* new CalculationProviderError({
            operation: "read-source",
            cause: "The web Sheet Configuration is bound to a different spreadsheet",
          });
        }
        const projectionValueRangeIndex = usesWebConfiguration ? 0 : 2;
        const { metadata, values, configurationRows } = yield* Effect.all(
          {
            metadata: usesWebConfiguration
              ? Effect.succeed(undefined)
              : readRequest("read-source", (signal) =>
                  client.spreadsheets.get(
                    {
                      spreadsheetId,
                      fields: "sheets.properties(sheetId,title)",
                    },
                    { signal },
                  ),
                ),
            values: readRequest("read-source", (signal) =>
              client.spreadsheets.values.batchGet(
                {
                  spreadsheetId,
                  ranges: usesWebConfiguration
                    ? [canonicalSheetRef]
                    : [configurationRange, teamConfigurationRange, canonicalSheetRef],
                  valueRenderOption: "UNFORMATTED_VALUE",
                  dateTimeRenderOption: "SERIAL_NUMBER",
                },
                { signal },
              ),
            ),
            configurationRows: usesWebConfiguration
              ? loadWebConfigurationSheetAdapter({
                  client,
                  spreadsheetId,
                  configuration,
                  makeError: (cause) =>
                    new CalculationProviderError({ operation: "read-source", cause }),
                })
              : Effect.succeed(undefined),
          },
          { concurrency: "unbounded" },
        );
        if (usesWebConfiguration && Predicate.isUndefined(configurationRows)) {
          return yield* new CalculationProviderError({
            operation: "read-source",
            cause: "The web Sheet Configuration adapter returned no rows",
          });
        }
        const matchingSheets = usesWebConfiguration
          ? (configurationRows?.tabs ?? []).flatMap(({ sheetId, title }) =>
              title === sheetTitle ? [{ sheetId, title }] : [],
            )
          : (metadata?.data.sheets ?? []).flatMap(({ properties }) =>
              properties?.title === sheetTitle && Predicate.isNumber(properties.sheetId)
                ? [{ sheetId: properties.sheetId, title: properties.title }]
                : [],
            );
        const target = matchingSheets[0];
        if (Predicate.isUndefined(target)) {
          return yield* new CalculationTargetError({ code: "MissingSheet" });
        }
        if (matchingSheets.length > 1) {
          return yield* new CalculationTargetError({ code: "NonCanonicalSheet" });
        }
        const groupedRows = values.data.valueRanges ?? [];
        const settingsRows = usesWebConfiguration
          ? rowsFromValues(configurationRows?.rangesRows ?? [])
          : rowsFrom(groupedRows[0]);
        const teamConfigurationRows = usesWebConfiguration
          ? rowsFromValues(configurationRows?.teamsRows ?? [])
          : rowsFrom(groupedRows[1]);
        const plan = makeCalculationSourceReadPlan(settingsRows, teamConfigurationRows);
        const sourceBatches = Predicate.isUndefined(plan) ? [] : sourceRangeBatches(plan.ranges);
        const sourceValues = Predicate.isUndefined(plan)
          ? undefined
          : yield* Effect.forEach(sourceBatches, (ranges) =>
              readRequest("read-source", (signal) =>
                client.spreadsheets.values.batchGet(
                  {
                    spreadsheetId,
                    ranges: [...ranges],
                    valueRenderOption: "UNFORMATTED_VALUE",
                    dateTimeRenderOption: "SERIAL_NUMBER",
                  },
                  { signal },
                ),
              ),
            );
        if (
          Predicate.isNotUndefined(plan) &&
          sourceValues?.some(
            (response, index) => response.data.valueRanges?.length !== sourceBatches[index]?.length,
          ) === true
        ) {
          return yield* new CalculationProviderError({
            operation: "read-source",
            cause: "The Sheets provider returned an incomplete source range response",
          });
        }
        const sourceValueRanges = sourceValues?.flatMap(
          (response) => response.data.valueRanges ?? [],
        );
        return {
          sheetId: target.sheetId,
          sheetTitle,
          canonicalSheetRef,
          preWriteProjection: rowsFrom(groupedRows[projectionValueRangeIndex]),
          settingsRows,
          teamConfigurationRows,
          sourceRanges: Predicate.isUndefined(plan)
            ? []
            : plan.ranges.map((range, index) => ({
                range,
                rows: rowsFrom(sourceValueRanges?.[index]),
              })),
        };
      }),
    readProjection,
    replaceProjection: ({
      canonicalSheetRef,
      desiredRows,
      preWriteRows,
      sheetId,
      sheetTitle,
      spreadsheetId,
    }) =>
      Effect.gen(function* () {
        const widestDesiredRow = desiredRows.reduce(
          (widest, row) => Math.max(widest, row.length),
          0,
        );
        if (widestDesiredRow > calculationProjectionWidth) {
          return yield* Effect.fail(
            new CalculationProjectionWriteError({
              ambiguous: false,
              cause: `The calculation projection is ${widestDesiredRow} columns wide, but the range holds ${calculationProjectionWidth}`,
            }),
          );
        }
        const desiredLimitError = projectionLimitError("desired", desiredRows);
        if (Predicate.isString(desiredLimitError)) {
          return yield* Effect.fail(
            new CalculationProjectionWriteError({
              ambiguous: false,
              cause: desiredLimitError,
            }),
          );
        }
        const preWriteLimitError = projectionLimitError("pre-write", preWriteRows);
        if (Predicate.isString(preWriteLimitError)) {
          return yield* Effect.fail(
            new CalculationProjectionWriteError({
              ambiguous: false,
              cause: preWriteLimitError,
            }),
          );
        }
        const sheetIdentity = yield* readRequest("read-projection-metadata", (signal) =>
          client.spreadsheets.get(
            {
              spreadsheetId,
              fields: "sheets.properties(sheetId,title)",
            },
            { signal },
          ),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CalculationProjectionWriteError({
                ambiguous: false,
                cause,
              }),
          ),
          Effect.map(({ data }) =>
            (data.sheets ?? []).some(
              ({ properties }) =>
                properties?.sheetId === sheetId && properties.title === sheetTitle,
            ),
          ),
        );
        if (!sheetIdentity) {
          return yield* Effect.fail(
            new CalculationProjectionWriteError({
              ambiguous: false,
              conflicting: true,
              cause: "The calculation sheet identity changed before the write",
            }),
          );
        }
        const liveRows = yield* readProjection(spreadsheetId, canonicalSheetRef).pipe(
          Effect.mapError(
            (cause) =>
              new CalculationProjectionWriteError({
                ambiguous: false,
                cause,
              }),
          ),
        );
        if (!sameCalculationRows(liveRows, preWriteRows)) {
          return yield* Effect.fail(
            new CalculationProjectionWriteError({
              ambiguous: false,
              conflicting: true,
              cause: "The calculation projection changed before the write",
            }),
          );
        }
        // Sheets batchUpdate has no conditional compare-and-swap or revision precondition. The
        // live read narrows the overwrite window; ambiguous failures are reconciled by a fresh
        // read in operations.ts, which is the strongest guard available at this API boundary.
        const rows = updateRows(desiredRows, preWriteRows);
        return yield* Effect.tryPromise({
          try: (signal) =>
            client.spreadsheets.batchUpdate(
              {
                spreadsheetId,
                requestBody: {
                  requests: [
                    {
                      updateCells: {
                        range: {
                          sheetId,
                          startRowIndex: calculationProjectionStartRowIndex,
                          endRowIndex: calculationProjectionStartRowIndex + rows.length,
                          startColumnIndex: calculationProjectionStartColumnIndex,
                          endColumnIndex:
                            calculationProjectionStartColumnIndex + calculationProjectionWidth,
                        },
                        rows: [...rows],
                        fields: "userEnteredValue",
                      },
                    },
                  ],
                },
              },
              { signal },
            ),
          catch: (cause) =>
            new CalculationProjectionWriteError({
              ambiguous: isAmbiguousWriteCause(cause),
              cause,
            }),
        }).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((error) =>
            Predicate.isTagged("CalculationProjectionWriteError")(error)
              ? error
              : new CalculationProjectionWriteError({ ambiguous: true, cause: error }),
          ),
          Effect.asVoid,
        );
      }),
  };
};

export const calculationProviderLayer = Layer.effect(
  CalculationProvider,
  Effect.gen(function* () {
    const auth = yield* Effect.try({
      try: () => new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] }),
      catch: (cause) => new CalculationProviderError({ operation: "create-client", cause }),
    });
    const client = yield* Effect.try({
      try: () => sheets({ version: "v4", auth }),
      catch: (cause) => new CalculationProviderError({ operation: "create-client", cause }),
    });
    return makeCalculationProvider(client);
  }),
);
