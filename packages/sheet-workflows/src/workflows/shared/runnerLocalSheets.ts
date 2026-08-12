import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { Cause, Effect, Predicate, Schedule, Schema } from "effect";
import { GoogleAuth } from "google-auth-library";

const SheetCell = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Undefined,
]);
const ValueRows = Schema.Array(Schema.Array(SheetCell));
export type ValueRows = typeof ValueRows.Type;
export const ValueRange = Schema.Struct({
  values: Schema.optional(Schema.NullOr(ValueRows)),
});
const BatchGetValuesResponse = Schema.Struct({
  valueRanges: Schema.optional(Schema.NullOr(Schema.Array(ValueRange))),
});

export const eventConfigRange = "'Thee''s Sheet Settings'!O8:P";
export const scheduleConfigRange = "'Thee''s Sheet Settings'!R8:AE";
export const runnerConfigRange = "'Thee''s Sheet Settings'!AG8:AH";

export interface SheetScheduleConfiguration {
  readonly channel: string;
  readonly day: number;
  readonly sheet: string;
  readonly hourRange: string;
  readonly breakRange: string;
  readonly monitorRange: string | undefined;
  readonly fillRange: string;
  readonly overfillRange: string;
  readonly standbyRange: string;
  readonly visibleCell: string;
}

export interface SheetRunnerConfiguration {
  readonly name: string;
  readonly hours: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

const optionalCellText = Schema.UndefinedOr(Schema.String);
const ScheduleConfigurationRow = Schema.Struct({
  channel: optionalCellText,
  day: Schema.UndefinedOr(Schema.Number),
  sheet: optionalCellText,
  hourRange: optionalCellText,
  breakRange: optionalCellText,
  monitorRange: optionalCellText,
  encType: optionalCellText,
  fillRange: optionalCellText,
  overfillRange: optionalCellText,
  standbyRange: optionalCellText,
  visibleCell: optionalCellText,
});
const ScheduleEncodingType = Schema.String.check(
  Schema.makeFilter((value) =>
    ["none", "regex", "bold", "underline"].includes(value)
      ? undefined
      : `Invalid schedule encoding type: ${value}`,
  ),
);
const CompleteScheduleConfiguration = Schema.Struct({
  channel: Schema.String,
  day: Schema.Number,
  sheet: Schema.String,
  hourRange: Schema.String,
  breakRange: Schema.String,
  monitorRange: optionalCellText,
  encType: ScheduleEncodingType,
  fillRange: Schema.String,
  overfillRange: Schema.String,
  standbyRange: Schema.String,
  visibleCell: Schema.String,
});
const RunnerConfigurationRow = Schema.Struct({
  name: optionalCellText,
  hours: Schema.Array(Schema.String),
});
const HourRange = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
});

export const cellText = (value: unknown): string | undefined => {
  if (Predicate.isNullish(value)) return undefined;
  if (!Predicate.isString(value) && !Predicate.isNumber(value) && !Predicate.isBoolean(value)) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length === 0 ? undefined : text;
};

const rowCell = (row: ReadonlyArray<unknown> | undefined, index: number): string | undefined =>
  cellText(row?.[index]);

export const parseLegacyNumber = (value: string | undefined): number | undefined => {
  if (Predicate.isUndefined(value)) return undefined;
  const match = /\d+(?:\.\d+)?/u.exec(value);
  if (match?.[0] === undefined) return undefined;
  const parsed = Number.parseFloat(match[0]);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const sheetBooleanValues: Readonly<Record<string, boolean>> = {
  TRUE: true,
  FALSE: false,
};

export const parseSheetBoolean = (value: string | undefined): boolean | undefined =>
  Predicate.isUndefined(value) ? undefined : sheetBooleanValues[value.toUpperCase()];

export const commaSeparated = (value: string | undefined): ReadonlyArray<string> =>
  Predicate.isUndefined(value)
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

export const upperFirst = (value: string): string =>
  value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;

export const parseKeyValueRows = (rows: ValueRows) =>
  new Map(
    rows.flatMap((row) => {
      const key = rowCell(row, 0);
      return Predicate.isUndefined(key) ? [] : ([[key, rowCell(row, 1)]] as const);
    }),
  );

export const parseEventStart = (rows: ValueRows) =>
  Effect.gen(function* () {
    const entries = parseKeyValueRows(rows);
    const startSeconds = yield* Schema.decodeUnknownEffect(
      Schema.Number.annotate({
        message: "The event Start Time configuration is missing or invalid",
      }),
    )(parseLegacyNumber(entries.get("Start Time")));
    return startSeconds * 1_000;
  });

export const parseScheduleConfigurations = (rows: ValueRows, day: number) =>
  Effect.gen(function* () {
    const normalizedRows = yield* Schema.decodeUnknownEffect(
      Schema.Array(ScheduleConfigurationRow),
    )(
      rows.map((row) => ({
        channel: rowCell(row, 0),
        day: parseLegacyNumber(rowCell(row, 1)),
        sheet: rowCell(row, 2),
        hourRange: rowCell(row, 3),
        breakRange: rowCell(row, 4),
        monitorRange: rowCell(row, 5),
        encType: rowCell(row, 6),
        fillRange: rowCell(row, 7),
        overfillRange: rowCell(row, 8),
        standbyRange: rowCell(row, 9),
        visibleCell: rowCell(row, 12),
      })),
    );
    const decoded = yield* Effect.forEach(normalizedRows, (values) => {
      const requiredFields = [
        values.channel,
        values.day,
        values.sheet,
        values.hourRange,
        values.breakRange,
        values.encType,
        values.fillRange,
        values.overfillRange,
        values.standbyRange,
        values.visibleCell,
      ];
      if (!requiredFields.some(Predicate.isNotUndefined)) {
        return Effect.succeed<ReadonlyArray<SheetScheduleConfiguration>>([]);
      }
      if (requiredFields.some(Predicate.isUndefined)) {
        return Effect.logWarning("Ignoring a partially configured schedule row").pipe(
          Effect.annotateLogs({
            scheduleChannel: values.channel ?? "missing",
            scheduleDay: values.day ?? "missing",
          }),
          Effect.as<ReadonlyArray<SheetScheduleConfiguration>>([]),
        );
      }
      return Schema.decodeUnknownEffect(CompleteScheduleConfiguration)(values).pipe(
        Effect.map(
          (configuration): ReadonlyArray<SheetScheduleConfiguration> =>
            configuration.day === day ? [configuration] : [],
        ),
      );
    });
    return decoded.flat();
  });

const parseHourRange = (value: string) => {
  const match = /^(\d+)\s*-\s*(\d+)$/u.exec(value.trim());
  const invalidRangeMessage = `Invalid runner hour range: ${value}`;
  return Schema.decodeUnknownEffect(
    HourRange.check(
      Schema.makeFilter(({ end, start }) => (start <= end ? undefined : invalidRangeMessage)),
    ).annotate({ message: invalidRangeMessage }),
  )({
    start: parseLegacyNumber(match?.[1]),
    end: parseLegacyNumber(match?.[2]),
  });
};

export const parseRunnerConfigurations = (rows: ValueRows) =>
  Effect.gen(function* () {
    const normalizedRows = yield* Schema.decodeUnknownEffect(Schema.Array(RunnerConfigurationRow))(
      rows.map((row) => ({
        name: rowCell(row, 0),
        hours: commaSeparated(rowCell(row, 1)),
      })),
    );
    const decoded = yield* Effect.forEach(normalizedRows, ({ hours, name }) =>
      Effect.forEach(hours, parseHourRange).pipe(
        Effect.map(
          (parsedHours): ReadonlyArray<SheetRunnerConfiguration> =>
            Predicate.isUndefined(name) ? [] : [{ name, hours: parsedHours }],
        ),
      ),
    );
    return decoded.flat();
  });

export const quotedRange = (configuration: SheetScheduleConfiguration, range: string): string =>
  `'${configuration.sheet.replaceAll("'", "''")}'!${range}`;

export const valueRowsAt = (
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
  index: number | undefined,
): ValueRows => (Predicate.isUndefined(index) ? [] : (valueRanges[index]?.values ?? []));

export const firstCell = (rows: ValueRows, rowIndex: number): string | undefined =>
  rowCell(rows[rowIndex], 0);

export const makeRunnerHours = (runners: ReadonlyArray<SheetRunnerConfiguration>) => {
  const runnerHours = new Map<string, SheetRunnerConfiguration["hours"]>();
  for (const { hours, name } of runners) {
    const normalizedName = upperFirst(name);
    runnerHours.set(normalizedName, [...(runnerHours.get(normalizedName) ?? []), ...hours]);
  }
  return runnerHours;
};

export const runnerPresent = (
  runners: ReadonlyMap<string, ReadonlyArray<{ readonly start: number; readonly end: number }>>,
  fills: ReadonlyArray<string>,
  hour: number | null,
): boolean =>
  Predicate.isNotNull(hour) &&
  fills.some((fill) =>
    runners.get(upperFirst(fill))?.some(({ end, start }) => hour >= start && hour <= end),
  );

const transientSheetsNetworkCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

export const isRetryableRunnerLocalSheetsReadFailure = ({
  cause,
}: {
  readonly cause: unknown;
}): boolean => {
  if (Cause.isTimeoutError(cause)) return true;
  const status =
    Predicate.hasProperty(cause, "response") && Predicate.hasProperty(cause.response, "status")
      ? cause.response.status
      : undefined;
  if (
    Predicate.isNumber(status) &&
    (status === 408 || status === 429 || (status >= 500 && status < 600))
  ) {
    return true;
  }
  const code = Predicate.hasProperty(cause, "code") ? cause.code : undefined;
  return Predicate.isString(code) && transientSheetsNetworkCodes.has(code);
};

const sheetsReadRetrySchedule = Schedule.exponential("100 millis").pipe(Schedule.jittered);

export const readSheetsValueRanges = <E extends { readonly cause: unknown }>(options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly ranges: ReadonlyArray<string>;
  readonly makeError: (cause: unknown) => E;
}) =>
  Effect.tryPromise({
    try: () =>
      options.client.spreadsheets.values.batchGet({
        spreadsheetId: options.spreadsheetId,
        ranges: [...options.ranges],
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      }),
    catch: options.makeError,
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((error) => (Cause.isTimeoutError(error) ? options.makeError(error) : error)),
    Effect.retry({
      schedule: sheetsReadRetrySchedule,
      times: 2,
      while: isRetryableRunnerLocalSheetsReadFailure,
    }),
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(BatchGetValuesResponse)(response.data).pipe(
        Effect.mapError(options.makeError),
      ),
    ),
    Effect.flatMap(({ valueRanges }) => {
      const received = valueRanges ?? [];
      return received.length === options.ranges.length
        ? Effect.succeed(received)
        : Effect.fail(
            options.makeError(
              new Error(
                `Expected ${options.ranges.length} value ranges, received ${received.length}`,
              ),
            ),
          );
    }),
  );

const rangeBatches = (ranges: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  Array.from({ length: Math.ceil(ranges.length / 100) }, (_, index) =>
    ranges.slice(index * 100, (index + 1) * 100),
  );

export const readBatchedSheetsValueRanges = <E extends { readonly cause: unknown }>(options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly ranges: ReadonlyArray<string>;
  readonly makeError: (cause: unknown) => E;
}) =>
  Effect.forEach(
    rangeBatches(options.ranges),
    (ranges) => readSheetsValueRanges({ ...options, ranges }),
    { concurrency: 2 },
  ).pipe(
    Effect.timeout("2 minutes"),
    Effect.mapError((error) => (Cause.isTimeoutError(error) ? options.makeError(error) : error)),
    Effect.map((batches) => batches.flat()),
  );

export const parseSheetIdentities = (
  idRows: ValueRows,
  nameRows: ValueRows,
): ReadonlyArray<{ readonly accountId: string; readonly name: string }> =>
  Array.from({ length: Math.max(idRows.length, nameRows.length) }, (_, index) => ({
    accountId: firstCell(idRows, index),
    name: firstCell(nameRows, index),
  })).flatMap(({ accountId, name }) =>
    Predicate.isUndefined(accountId) || Predicate.isUndefined(name)
      ? []
      : [{ accountId, name: upperFirst(name) }],
  );

export const makeRunnerLocalSheetsClient = <E>(makeError: (cause: unknown) => E) =>
  Effect.gen(function* () {
    const auth = yield* Effect.try({
      try: () =>
        new GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
        }),
      catch: makeError,
    });
    return yield* Effect.try({
      try: () => sheets({ version: "v4", auth }),
      catch: makeError,
    });
  });
