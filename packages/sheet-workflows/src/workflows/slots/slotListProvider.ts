import { sheets, type sheets_v4 } from "@googleapis/sheets";
import { Cause, Context, Data, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import { GoogleAuth } from "google-auth-library";

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const slotCapacity = 5;
const filledSlotCount = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: slotCapacity }));

const slotViewScheduleFields = {
  visible: Schema.Boolean,
  hour: Schema.NullOr(Schema.Number),
} as const;

const SlotViewSchedule = Schema.Union([
  Schema.TaggedStruct("Break", slotViewScheduleFields),
  Schema.TaggedStruct("Schedule", {
    ...slotViewScheduleFields,
    filledSlots: filledSlotCount,
    overfillSlots: nonNegativeInt,
  }),
]);
type SlotViewSchedule = typeof SlotViewSchedule.Type;

const SheetCell = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
  Schema.Undefined,
]);
const ValueRows = Schema.Array(Schema.Array(SheetCell));
type ValueRows = typeof ValueRows.Type;
const ValueRange = Schema.Struct({
  values: Schema.optional(Schema.NullOr(ValueRows)),
});
const BatchGetValuesResponse = Schema.Struct({
  valueRanges: Schema.optional(Schema.NullOr(Schema.Array(ValueRange))),
});

export const SlotView = Schema.Struct({
  eventStartEpochMs: Schema.Number,
  schedules: Schema.Array(SlotViewSchedule),
});
export type SlotView = typeof SlotView.Type;

export class SlotListProviderError extends Data.TaggedError("SlotListProviderError")<{
  readonly operation: "create-client" | "read-configuration" | "read-day-schedules";
  readonly cause: unknown;
}> {}

interface SlotListProviderShape {
  readonly load: (
    spreadsheetId: string,
    day: number,
  ) => Effect.Effect<SlotView, SlotListProviderError>;
}

export class SlotListProvider extends Context.Service<SlotListProvider, SlotListProviderShape>()(
  "sheet-workflows/SlotListProvider",
) {}

const eventConfigRange = "'Thee''s Sheet Settings'!O8:P";
const scheduleConfigRange = "'Thee''s Sheet Settings'!R8:AE";
const runnerConfigRange = "'Thee''s Sheet Settings'!AG8:AH";
const scheduleRangeBatchSize = 100;
const sheetsReadRetrySchedule = Schedule.exponential("100 millis").pipe(Schedule.jittered);
const transientSheetsNetworkCodes = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

interface ScheduleConfiguration {
  readonly channel: string;
  readonly day: number;
  readonly sheet: string;
  readonly hourRange: string;
  readonly breakRange: string;
  readonly fillRange: string;
  readonly overfillRange: string;
  readonly visibleCell: string;
}

interface RunnerConfiguration {
  readonly name: string;
  readonly hours: ReadonlyArray<{ readonly start: number; readonly end: number }>;
}

const optionalCellText = Schema.UndefinedOr(Schema.String);
const EventConfigurationRow = Schema.Struct({
  key: optionalCellText,
  value: optionalCellText,
});
const ScheduleConfigurationRow = Schema.Struct({
  channel: optionalCellText,
  day: Schema.UndefinedOr(Schema.Number),
  sheet: optionalCellText,
  hourRange: optionalCellText,
  breakRange: optionalCellText,
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

const cellText = (value: unknown): string | undefined => {
  if (Predicate.isNullish(value)) return undefined;
  if (!Predicate.isString(value) && !Predicate.isNumber(value) && !Predicate.isBoolean(value)) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length === 0 ? undefined : text;
};

const rowCell = (row: ReadonlyArray<unknown> | undefined, index: number): string | undefined =>
  cellText(row?.[index]);

const parseLegacyNumber = (value: string | undefined): number | undefined => {
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

const parseBoolean = (value: string | undefined): boolean | undefined =>
  Predicate.isUndefined(value) ? undefined : sheetBooleanValues[value.toUpperCase()];

const commaSeparated = (value: string | undefined): ReadonlyArray<string> =>
  Predicate.isUndefined(value)
    ? []
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

const upperFirst = (value: string): string =>
  value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;

const parseEventStart = (rows: ValueRows) =>
  Effect.gen(function* () {
    const normalizedRows = yield* Schema.decodeUnknownEffect(Schema.Array(EventConfigurationRow))(
      rows.map((row) => ({ key: rowCell(row, 0), value: rowCell(row, 1) })),
    );
    const entries = new Map(
      normalizedRows.flatMap(({ key, value }) =>
        Predicate.isUndefined(key) ? [] : ([[key, value]] as const),
      ),
    );
    const startSeconds = yield* Schema.decodeUnknownEffect(
      Schema.Number.annotate({
        message: "The event Start Time configuration is missing or invalid",
      }),
    )(parseLegacyNumber(entries.get("Start Time")));
    return startSeconds * 1_000;
  });

const parseScheduleConfigurations = (rows: ValueRows, day: number) =>
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
        return Effect.succeed<ReadonlyArray<ScheduleConfiguration>>([]);
      }
      if (requiredFields.some(Predicate.isUndefined)) {
        return Effect.logWarning("Ignoring a partially configured schedule row").pipe(
          Effect.annotateLogs({
            scheduleChannel: values.channel ?? "missing",
            scheduleDay: values.day ?? "missing",
          }),
          Effect.as<ReadonlyArray<ScheduleConfiguration>>([]),
        );
      }
      return Schema.decodeUnknownEffect(CompleteScheduleConfiguration)(values).pipe(
        Effect.map(
          (configuration): ReadonlyArray<ScheduleConfiguration> =>
            configuration.day === day
              ? [
                  {
                    channel: configuration.channel,
                    day: configuration.day,
                    sheet: configuration.sheet,
                    hourRange: configuration.hourRange,
                    breakRange: configuration.breakRange,
                    fillRange: configuration.fillRange,
                    overfillRange: configuration.overfillRange,
                    visibleCell: configuration.visibleCell,
                  },
                ]
              : [],
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

const parseRunnerConfigurations = (rows: ValueRows) =>
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
          (parsedHours): ReadonlyArray<RunnerConfiguration> =>
            Predicate.isUndefined(name) ? [] : [{ name, hours: parsedHours }],
        ),
      ),
    );
    return decoded.flat();
  });

const quotedRange = (configuration: ScheduleConfiguration, range: string): string =>
  `'${configuration.sheet.replaceAll("'", "''")}'!${range}`;

const firstCell = (rows: ValueRows, rowIndex: number): string | undefined =>
  rowCell(rows[rowIndex], 0);

const runnerPresent = (
  runners: ReadonlyMap<string, ReadonlyArray<{ readonly start: number; readonly end: number }>>,
  fills: ReadonlyArray<string>,
  hour: number | null,
): boolean =>
  Predicate.isNotNull(hour) &&
  fills.some((fill) =>
    runners.get(upperFirst(fill))?.some(({ end, start }) => hour >= start && hour <= end),
  );

interface ScheduleRangeIndexes {
  readonly hours: number;
  readonly fills: number;
  readonly overfills: number;
  readonly breaks: number | undefined;
  readonly visible: number;
}

const scheduleRangePlan = (configurations: ReadonlyArray<ScheduleConfiguration>) => {
  const ranges: Array<string> = [];
  const indexes = configurations.map((configuration): ScheduleRangeIndexes => {
    const add = (range: string) => {
      const index = ranges.length;
      ranges.push(quotedRange(configuration, range));
      return index;
    };
    return {
      hours: add(configuration.hourRange),
      fills: add(configuration.fillRange),
      overfills: add(configuration.overfillRange),
      breaks: configuration.breakRange === "auto" ? undefined : add(configuration.breakRange),
      visible: add(configuration.visibleCell),
    };
  });
  return { indexes, ranges };
};

const valueRowsAt = (
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
  index: number | undefined,
): ValueRows => (Predicate.isUndefined(index) ? [] : (valueRanges[index]?.values ?? []));

const parseScheduleRow = (
  configuration: ScheduleConfiguration,
  runnerHours: ReadonlyMap<string, ReadonlyArray<{ readonly start: number; readonly end: number }>>,
  visible: boolean,
  hourRows: ValueRows,
  fillRows: ValueRows,
  overfillRows: ValueRows,
  breakRows: ValueRows,
  rowIndex: number,
): SlotViewSchedule => {
  const hour = parseLegacyNumber(firstCell(hourRows, rowIndex)) ?? null;
  const fills = (fillRows[rowIndex] ?? []).slice(0, slotCapacity).flatMap((value) => {
    const text = cellText(value);
    return Predicate.isUndefined(text) ? [] : [text];
  });
  const overfills = commaSeparated(firstCell(overfillRows, rowIndex));
  const isBreak =
    configuration.breakRange === "auto"
      ? !runnerPresent(runnerHours, fills, hour)
      : (parseBoolean(firstCell(breakRows, rowIndex)) ?? false);
  return isBreak
    ? { _tag: "Break", visible, hour }
    : {
        _tag: "Schedule",
        visible,
        hour,
        filledSlots: visible ? fills.length : 0,
        overfillSlots: visible ? overfills.length : 0,
      };
};

const parseConfiguredSchedule = (
  configuration: ScheduleConfiguration,
  rangeIndexes: ScheduleRangeIndexes,
  runnerHours: ReadonlyMap<string, ReadonlyArray<{ readonly start: number; readonly end: number }>>,
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
): ReadonlyArray<SlotViewSchedule> => {
  const hourRows = valueRowsAt(valueRanges, rangeIndexes.hours);
  const fillRows = valueRowsAt(valueRanges, rangeIndexes.fills);
  const overfillRows = valueRowsAt(valueRanges, rangeIndexes.overfills);
  const breakRows = valueRowsAt(valueRanges, rangeIndexes.breaks);
  const visible =
    parseBoolean(firstCell(valueRowsAt(valueRanges, rangeIndexes.visible), 0)) ?? true;
  const rowCount = Math.max(
    hourRows.length,
    fillRows.length,
    overfillRows.length,
    breakRows.length,
  );
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    parseScheduleRow(
      configuration,
      runnerHours,
      visible,
      hourRows,
      fillRows,
      overfillRows,
      breakRows,
      rowIndex,
    ),
  );
};

const parseDaySchedules = (
  configurations: ReadonlyArray<ScheduleConfiguration>,
  runners: ReadonlyArray<RunnerConfiguration>,
  indexes: ReadonlyArray<ScheduleRangeIndexes>,
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
): ReadonlyArray<SlotViewSchedule> => {
  const runnerHours = new Map<string, RunnerConfiguration["hours"]>();
  for (const { hours, name } of runners) {
    const normalizedName = upperFirst(name);
    runnerHours.set(normalizedName, [...(runnerHours.get(normalizedName) ?? []), ...hours]);
  }
  return configurations.flatMap((configuration, index) =>
    parseConfiguredSchedule(configuration, indexes[index]!, runnerHours, valueRanges),
  );
};

export const isRetryableSheetsReadFailure = ({ cause }: SlotListProviderError): boolean => {
  if (Cause.isTimeoutError(cause)) {
    return true;
  }
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

const readValueRanges = (
  client: sheets_v4.Sheets,
  spreadsheetId: string,
  ranges: ReadonlyArray<string>,
  operation: SlotListProviderError["operation"],
) =>
  Effect.tryPromise({
    try: () =>
      client.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: [...ranges],
        valueRenderOption: "UNFORMATTED_VALUE",
        dateTimeRenderOption: "SERIAL_NUMBER",
      }),
    catch: (cause) => new SlotListProviderError({ operation, cause }),
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((error) =>
      Cause.isTimeoutError(error) ? new SlotListProviderError({ operation, cause: error }) : error,
    ),
    Effect.retry({
      schedule: sheetsReadRetrySchedule,
      times: 2,
      while: isRetryableSheetsReadFailure,
    }),
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(BatchGetValuesResponse)(response.data).pipe(
        Effect.mapError((cause) => new SlotListProviderError({ operation, cause })),
      ),
    ),
    Effect.flatMap(({ valueRanges }) => {
      const received = valueRanges ?? [];
      return received.length === ranges.length
        ? Effect.succeed(received)
        : Effect.fail(
            new SlotListProviderError({
              operation,
              cause: new Error(
                `Expected ${ranges.length} value ranges, received ${received.length}`,
              ),
            }),
          );
    }),
  );

const rangeBatches = (ranges: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  Array.from({ length: Math.ceil(ranges.length / scheduleRangeBatchSize) }, (_, index) =>
    ranges.slice(index * scheduleRangeBatchSize, (index + 1) * scheduleRangeBatchSize),
  );

export const makeSlotListProvider = (client: sheets_v4.Sheets): SlotListProviderShape => ({
  load: (spreadsheetId, day) =>
    Effect.gen(function* () {
      const configurationRanges = yield* readValueRanges(
        client,
        spreadsheetId,
        [eventConfigRange, scheduleConfigRange, runnerConfigRange],
        "read-configuration",
      );
      const parsed = yield* Effect.all({
        eventStartEpochMs: parseEventStart(valueRowsAt(configurationRanges, 0)),
        configurations: parseScheduleConfigurations(valueRowsAt(configurationRanges, 1), day),
        runners: parseRunnerConfigurations(valueRowsAt(configurationRanges, 2)),
      }).pipe(
        Effect.mapError(
          (cause) => new SlotListProviderError({ operation: "read-configuration", cause }),
        ),
      );
      const plan = scheduleRangePlan(parsed.configurations);
      if (plan.ranges.length === 0) {
        return { eventStartEpochMs: parsed.eventStartEpochMs, schedules: [] };
      }
      const scheduleRanges = yield* Effect.forEach(
        rangeBatches(plan.ranges),
        (ranges) => readValueRanges(client, spreadsheetId, ranges, "read-day-schedules"),
        { concurrency: 2 },
      ).pipe(
        Effect.timeout("2 minutes"),
        Effect.mapError((error) =>
          Cause.isTimeoutError(error)
            ? new SlotListProviderError({ operation: "read-day-schedules", cause: error })
            : error,
        ),
        Effect.map((batches) => batches.flat()),
      );
      const schedules = yield* Effect.try({
        try: () =>
          parseDaySchedules(parsed.configurations, parsed.runners, plan.indexes, scheduleRanges),
        catch: (cause) => new SlotListProviderError({ operation: "read-day-schedules", cause }),
      });
      return { eventStartEpochMs: parsed.eventStartEpochMs, schedules };
    }),
});

export const slotListProviderLayer = Layer.effect(
  SlotListProvider,
  Effect.gen(function* () {
    const auth = yield* Effect.try({
      try: () =>
        new GoogleAuth({
          scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
        }),
      catch: (cause) => new SlotListProviderError({ operation: "create-client", cause }),
    });
    return yield* Effect.try({
      try: () => makeSlotListProvider(sheets({ version: "v4", auth })),
      catch: (cause) => new SlotListProviderError({ operation: "create-client", cause }),
    });
  }),
);
