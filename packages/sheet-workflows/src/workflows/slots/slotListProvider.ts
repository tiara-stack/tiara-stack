import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate } from "effect";
import {
  cellText,
  commaSeparated,
  eventConfigRange,
  firstCell,
  isRetryableRunnerLocalSheetsReadFailure,
  makeRunnerHours,
  makeRunnerLocalSheetsClient,
  parseEventStart,
  parseLegacyNumber,
  parseRunnerConfigurations,
  parseScheduleConfigurations,
  parseSheetBoolean,
  quotedRange,
  readBatchedSheetsValueRanges,
  readSheetsValueRanges,
  runnerConfigRange,
  runnerPresent,
  scheduleConfigRange,
  type SheetRunnerConfiguration,
  type SheetScheduleConfiguration,
  type ValueRows,
  ValueRange,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import { slotCapacity } from "../shared/slotCapacity";
import type { SlotView } from "./slotListSchema";

type SlotViewSchedule = SlotView["schedules"][number];

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

interface ScheduleRangeIndexes {
  readonly hours: number;
  readonly fills: number;
  readonly overfills: number;
  readonly breaks: number | undefined;
  readonly visible: number;
}

const scheduleRangePlan = (configurations: ReadonlyArray<SheetScheduleConfiguration>) => {
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

const parseScheduleRow = (
  configuration: SheetScheduleConfiguration,
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
      : (parseSheetBoolean(firstCell(breakRows, rowIndex)) ?? false);
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
  configuration: SheetScheduleConfiguration,
  rangeIndexes: ScheduleRangeIndexes,
  runnerHours: ReadonlyMap<string, ReadonlyArray<{ readonly start: number; readonly end: number }>>,
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
): ReadonlyArray<SlotViewSchedule> => {
  const hourRows = valueRowsAt(valueRanges, rangeIndexes.hours);
  const fillRows = valueRowsAt(valueRanges, rangeIndexes.fills);
  const overfillRows = valueRowsAt(valueRanges, rangeIndexes.overfills);
  const breakRows = valueRowsAt(valueRanges, rangeIndexes.breaks);
  const visible =
    parseSheetBoolean(firstCell(valueRowsAt(valueRanges, rangeIndexes.visible), 0)) ?? true;
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
  configurations: ReadonlyArray<SheetScheduleConfiguration>,
  runners: ReadonlyArray<SheetRunnerConfiguration>,
  indexes: ReadonlyArray<ScheduleRangeIndexes>,
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
): ReadonlyArray<SlotViewSchedule> => {
  const runnerHours = makeRunnerHours(runners);
  return configurations.flatMap((configuration, index) =>
    parseConfiguredSchedule(configuration, indexes[index]!, runnerHours, valueRanges),
  );
};

export const isRetryableSheetsReadFailure = ({ cause }: SlotListProviderError): boolean =>
  isRetryableRunnerLocalSheetsReadFailure({ cause });

const makeProviderError = (operation: SlotListProviderError["operation"]) => (cause: unknown) =>
  new SlotListProviderError({ operation, cause });

export const makeSlotListProvider = (client: sheets_v4.Sheets): SlotListProviderShape => ({
  load: (spreadsheetId, day) =>
    Effect.gen(function* () {
      const configurationRanges = yield* readSheetsValueRanges({
        client,
        spreadsheetId,
        ranges: [eventConfigRange, scheduleConfigRange, runnerConfigRange],
        makeError: makeProviderError("read-configuration"),
      });
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
      const scheduleRanges = yield* readBatchedSheetsValueRanges({
        client,
        spreadsheetId,
        ranges: plan.ranges,
        makeError: makeProviderError("read-day-schedules"),
      });
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
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeSlotListProvider),
  ),
);
