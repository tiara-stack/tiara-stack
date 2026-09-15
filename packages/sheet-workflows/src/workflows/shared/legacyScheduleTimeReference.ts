import type { sheets_v4 } from "@googleapis/sheets";
import { Cause, Effect, Option, Predicate, Schema } from "effect";
import { type ScheduleTimeReference, type WebSheetConfiguration } from "sheet-domain";
import { scheduleTimeReferenceFromLegacy } from "sheet-domain/compatibility";
import {
  mapScheduleRows,
  parseScheduleConfigurations,
  quotedRange,
  readBatchedSheetsValueRanges,
  scheduleConfigRange,
  scheduleHour,
  type SheetScheduleConfiguration,
  valueRowsAt,
} from "./runnerLocalSheets";
import { loadConfigurationValueRanges } from "./webConfigurationSheets";
import { sheetsProviderMetadataResponse } from "./sheetsProviderResponse";

export const maximumScheduleTimeReferenceScanRows = 10_000;

type BoundedHourRange = {
  readonly range: string;
  readonly rowLimit: number;
  readonly truncated: boolean;
};

const a1Cell = /^\$?([A-Za-z]+)(?:\$?(\d+))?$/u;
const a1CellText = Schema.String.check(
  Schema.makeFilter((value) =>
    a1Cell.test(value.trim()) ? undefined : "Invalid schedule hour range cell",
  ),
);

type ParsedA1Cell = {
  readonly column: string;
  readonly row: number | undefined;
};

const parseA1Cell = (value: string): Option.Option<ParsedA1Cell> =>
  Option.match(Schema.decodeUnknownOption(a1CellText)(value.trim()), {
    onNone: Option.none,
    onSome: (validated) =>
      Option.fromNullishOr(a1Cell.exec(validated)).pipe(
        Option.map((match) => ({
          column: match[1]!,
          row: match[2] === undefined ? undefined : Number.parseInt(match[2], 10),
        })),
        Option.filter(({ row }) => row === undefined || (Number.isSafeInteger(row) && row >= 1)),
      ),
  });

type ParsedA1Range = {
  readonly start: ParsedA1Cell;
  readonly end: ParsedA1Cell;
};

const parseA1Range = (range: string): Option.Option<ParsedA1Range> => {
  const parts = range.split(":");
  if (parts.length > 2) return Option.none();
  const start = parseA1Cell(parts[0]!);
  const end = parseA1Cell(parts[1] ?? parts[0]!);
  return Option.all({ start, end }).pipe(
    Option.filter(
      ({ start, end }) =>
        end.row === undefined || end.row >= (start.row === undefined ? 1 : start.row),
    ),
    Option.map(({ start, end }) => ({
      start,
      end: { ...end, column: end.column || start.column },
    })),
  );
};

const requestedHourRows = (
  endRow: number | undefined,
  startRow: number,
  availableRows: number | undefined,
  maximumRows: number,
): number =>
  endRow === undefined
    ? availableRows === undefined
      ? maximumRows + 1
      : Math.max(0, availableRows - startRow + 1)
    : availableRows === undefined
      ? endRow - startRow + 1
      : Math.max(0, Math.min(endRow, availableRows) - startRow + 1);

const boundedHourEndRow = (startRow: number, rowLimit: number): Option.Option<number> => {
  const endRow = startRow + rowLimit - 1;
  return Number.isSafeInteger(endRow) ? Option.some(endRow) : Option.none();
};

const boundHourRange = (
  parsedRange: ParsedA1Range,
  maximumRows: number,
  availableRows: number | undefined,
): Option.Option<BoundedHourRange> => {
  if (maximumRows < 1) return Option.none();
  const { start, end } = parsedRange;
  const startRow = start.row ?? 1;
  const endRow = end.row;
  const requestedRows = requestedHourRows(endRow, startRow, availableRows, maximumRows);
  const rowLimit = Math.min(requestedRows, maximumRows);
  if (rowLimit === 0) {
    return Option.some({
      range: `${start.column}${startRow}:${end.column}${startRow}`,
      rowLimit,
      truncated: false,
    });
  }
  return boundedHourEndRow(startRow, rowLimit).pipe(
    Option.map((boundedEndRow) => ({
      range: `${start.column}${startRow}:${end.column}${boundedEndRow}`,
      rowLimit,
      truncated: requestedRows > maximumRows,
    })),
  );
};

type ScheduleSheetMetadataProperties =
  | {
      readonly title?: string | null | undefined;
      readonly gridProperties?:
        | {
            readonly rowCount?: number | null | undefined;
          }
        | null
        | undefined;
    }
  | null
  | undefined;

const scheduleSheetRowCountEntry = (
  properties: ScheduleSheetMetadataProperties,
): readonly [string, number] | undefined => {
  const title = properties?.title;
  const rowCount = properties?.gridProperties?.rowCount;
  return Predicate.isString(title) &&
    Predicate.isNumber(rowCount) &&
    Number.isSafeInteger(rowCount) &&
    rowCount >= 0
    ? [title, rowCount]
    : undefined;
};

const scheduleSheetRowCountsFrom = (
  data: typeof sheetsProviderMetadataResponse.Type,
  spreadsheetId: string,
): Option.Option<ReadonlyMap<string, number>> => {
  if (data.spreadsheetId !== spreadsheetId) {
    return Option.none();
  }
  return Option.some(
    new Map(
      (data.sheets ?? []).flatMap(({ properties }) => {
        const entry = scheduleSheetRowCountEntry(properties);
        return entry === undefined ? [] : [entry];
      }),
    ),
  );
};

const loadScheduleSheetRowCounts = <E extends { readonly cause: unknown }>(options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly makeError: (cause: unknown) => E;
}): Effect.Effect<ReadonlyMap<string, number>, E> =>
  Effect.tryPromise({
    try: () =>
      options.client.spreadsheets.get(
        {
          spreadsheetId: options.spreadsheetId,
          fields: "spreadsheetId,sheets(properties(title,gridProperties(rowCount)))",
        },
        { timeout: 30_000 },
      ),
    catch: options.makeError,
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((error) => (Cause.isTimeoutError(error) ? options.makeError(error) : error)),
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(sheetsProviderMetadataResponse)(response.data).pipe(
        Effect.mapError(options.makeError),
      ),
    ),
    Effect.flatMap((data) =>
      Option.match(scheduleSheetRowCountsFrom(data, options.spreadsheetId), {
        onNone: () =>
          Effect.fail(
            options.makeError(new Error("The Sheets provider returned a different spreadsheet")),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

type ParsedScheduleRange = {
  readonly schedule: SheetScheduleConfiguration;
  readonly parsed: ParsedA1Range;
};

type LegacyHourRangePlan = {
  readonly schedule: SheetScheduleConfiguration;
  readonly bounded: BoundedHourRange;
};

type BoundedHourRangePlan = {
  readonly plans: ReadonlyArray<LegacyHourRangePlan>;
  readonly truncated: boolean;
};

const parseScheduleRanges = (
  schedules: ReadonlyArray<SheetScheduleConfiguration>,
): ReadonlyArray<ParsedScheduleRange> =>
  schedules.flatMap((schedule) =>
    Option.match(parseA1Range(schedule.hourRange), {
      onNone: () => [],
      onSome: (parsed) => [{ schedule, parsed }],
    }),
  );

const planBoundedHourRanges = (
  parsedRanges: ReadonlyArray<ParsedScheduleRange>,
  scheduleSheetRowCounts: ReadonlyMap<string, number>,
): BoundedHourRangePlan | undefined => {
  const state = parsedRanges.reduce<
    | {
        readonly remainingRows: number;
        readonly plans: ReadonlyArray<LegacyHourRangePlan>;
        readonly truncated: boolean;
      }
    | undefined
  >(
    (current, { parsed, schedule }) => {
      if (current === undefined) return undefined;
      const availableRows = scheduleSheetRowCounts.get(schedule.sheet);
      const requestedRows = requestedHourRows(
        parsed.end.row,
        parsed.start.row ?? 1,
        availableRows,
        maximumScheduleTimeReferenceScanRows,
      );
      if (requestedRows === 0) return current;
      if (current.remainingRows === 0) return undefined;
      return Option.match(boundHourRange(parsed, current.remainingRows, availableRows), {
        onNone: () => undefined,
        onSome: (bounded) =>
          bounded.rowLimit === 0
            ? current
            : {
                remainingRows: current.remainingRows - bounded.rowLimit,
                plans: [...current.plans, { schedule, bounded }],
                truncated: current.truncated || bounded.truncated,
              },
      });
    },
    { remainingRows: maximumScheduleTimeReferenceScanRows, plans: [], truncated: false },
  );
  return state === undefined ? undefined : { plans: state.plans, truncated: state.truncated };
};

/**
 * Reads configured schedule hour evidence for an unresolved legacy source. The bounded scan keeps
 * the compatibility adapter workspace-wide instead of allowing a conversation filter to redefine
 * the event clock, while avoiding unbounded requests for open-ended sheet ranges.
 */
export const loadLegacyScheduleTimeReference = <E extends { readonly cause: unknown }>(options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly referenceInstantEpochMs: number;
  readonly configuration: WebSheetConfiguration | null | undefined;
  readonly makeError: (cause: unknown) => E;
}): Effect.Effect<ScheduleTimeReference | undefined, E> =>
  Effect.gen(function* () {
    const configurationRanges = yield* loadConfigurationValueRanges({
      client: options.client,
      spreadsheetId: options.spreadsheetId,
      configuration: options.configuration,
      legacyRanges: [scheduleConfigRange],
      selectConfiguredRows: ({ schedulesRows }) => [schedulesRows],
      makeError: options.makeError,
    });
    const schedules = yield* parseScheduleConfigurations(valueRowsAt(configurationRanges, 0)).pipe(
      Effect.mapError(options.makeError),
    );
    if (schedules.length === 0) return undefined;
    const parsedRanges = parseScheduleRanges(schedules);
    if (parsedRanges.length !== schedules.length) return undefined;
    const scheduleSheetRowCounts = yield* loadScheduleSheetRowCounts({
      client: options.client,
      spreadsheetId: options.spreadsheetId,
      makeError: options.makeError,
    });
    const rangePlan = planBoundedHourRanges(parsedRanges, scheduleSheetRowCounts);
    if (rangePlan === undefined || rangePlan.truncated || rangePlan.plans.length === 0) {
      return undefined;
    }
    const values = yield* readBatchedSheetsValueRanges({
      client: options.client,
      spreadsheetId: options.spreadsheetId,
      ranges: rangePlan.plans.map(({ bounded, schedule }) => quotedRange(schedule, bounded.range)),
      makeError: options.makeError,
    });
    const hours = rangePlan.plans.flatMap(({ bounded }, index) => {
      const rows = valueRowsAt(values, index).slice(0, bounded.rowLimit);
      return mapScheduleRows(rows.length, (rowIndex) => scheduleHour(rows, rowIndex));
    });
    return scheduleTimeReferenceFromLegacy(options.referenceInstantEpochMs, hours);
  });
