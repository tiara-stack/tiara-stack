import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate, Schema } from "effect";
import {
  cellText,
  commaSeparated,
  eventConfigRange,
  firstCell,
  isRetryableRunnerLocalSheetsReadFailure,
  makeRunnerHours,
  makeRunnerLocalSheetsClient,
  parseEventStart,
  parseKeyValueRows,
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
  upperFirst,
  type ValueRows,
  ValueRange,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import { slotCapacity } from "../shared/slotCapacity";
import { UserScheduleView } from "./schema";

export class UserScheduleProviderError extends Data.TaggedError("UserScheduleProviderError")<{
  readonly operation: "create-client" | "read-configuration" | "read-user-schedule";
  readonly cause: unknown;
}> {}

interface UserScheduleProviderShape {
  readonly load: (
    spreadsheetId: string,
    day: number,
  ) => Effect.Effect<UserScheduleView, UserScheduleProviderError>;
}

export class UserScheduleProvider extends Context.Service<
  UserScheduleProvider,
  UserScheduleProviderShape
>()("sheet-workflows/UserScheduleProvider") {}

const rangesConfigRange = "'Thee''s Sheet Settings'!B8:C";

interface RangesConfiguration {
  readonly userIds: string;
  readonly userNames: string;
  readonly monitorIds: string | undefined;
  readonly monitorNames: string | undefined;
}

interface ScheduleRangeIndexes {
  readonly hours: number;
  readonly fills: number;
  readonly overfills: number;
  readonly standbys: number;
  readonly breaks: number | undefined;
  readonly monitor: number | undefined;
  readonly visible: number;
}

interface UserScheduleRangePlan {
  readonly ranges: ReadonlyArray<string>;
  readonly scheduleIndexes: ReadonlyArray<ScheduleRangeIndexes>;
  readonly playerIds: number;
  readonly playerNames: number;
  readonly monitorIds: number | undefined;
  readonly monitorNames: number | undefined;
}

const parseRangesConfiguration = (rows: ValueRows) =>
  Effect.gen(function* () {
    const entries = parseKeyValueRows(rows);
    const userIds = yield* Schema.decodeUnknownEffect(
      Schema.String.annotate({ message: "The User IDs range configuration is missing" }),
    )(entries.get("User IDs"));
    const userNames = yield* Schema.decodeUnknownEffect(
      Schema.String.annotate({ message: "The User Sheet Names range configuration is missing" }),
    )(entries.get("User Sheet Names"));
    return {
      userIds,
      userNames,
      monitorIds: entries.get("Moni IDs"),
      monitorNames: entries.get("Moni Names"),
    } satisfies RangesConfiguration;
  });

const makeUserScheduleRangePlan = (
  configurations: ReadonlyArray<SheetScheduleConfiguration>,
  rangesConfiguration: RangesConfiguration,
): UserScheduleRangePlan => {
  const ranges: Array<string> = [];
  const add = (range: string) => {
    const index = ranges.length;
    ranges.push(range);
    return index;
  };
  const scheduleIndexes = configurations.map(
    (configuration): ScheduleRangeIndexes => ({
      hours: add(quotedRange(configuration, configuration.hourRange)),
      fills: add(quotedRange(configuration, configuration.fillRange)),
      overfills: add(quotedRange(configuration, configuration.overfillRange)),
      standbys: add(quotedRange(configuration, configuration.standbyRange)),
      breaks:
        configuration.breakRange === "auto"
          ? undefined
          : add(quotedRange(configuration, configuration.breakRange)),
      monitor: Predicate.isUndefined(configuration.monitorRange)
        ? undefined
        : add(quotedRange(configuration, configuration.monitorRange)),
      visible: add(quotedRange(configuration, configuration.visibleCell)),
    }),
  );
  const playerIds = add(rangesConfiguration.userIds);
  const playerNames = add(rangesConfiguration.userNames);
  const monitorRanges =
    Predicate.isNotUndefined(rangesConfiguration.monitorIds) &&
    Predicate.isNotUndefined(rangesConfiguration.monitorNames)
      ? {
          monitorIds: add(rangesConfiguration.monitorIds),
          monitorNames: add(rangesConfiguration.monitorNames),
        }
      : { monitorIds: undefined, monitorNames: undefined };
  return { ranges, scheduleIndexes, playerIds, playerNames, ...monitorRanges };
};

const parseIdentities = (idRows: ValueRows, nameRows: ValueRows): UserScheduleView["players"] =>
  Array.from({ length: Math.max(idRows.length, nameRows.length) }, (_, index) => ({
    accountId: firstCell(idRows, index),
    name: firstCell(nameRows, index),
  })).flatMap(({ accountId, name }) =>
    Predicate.isUndefined(accountId) || Predicate.isUndefined(name)
      ? []
      : [{ accountId, name: upperFirst(name) }],
  );

const parseScheduleRows = (
  configuration: SheetScheduleConfiguration,
  indexes: ScheduleRangeIndexes,
  runnerHours: ReadonlyMap<string, ReadonlyArray<{ readonly start: number; readonly end: number }>>,
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
): UserScheduleView["schedules"] => {
  const hourRows = valueRowsAt(valueRanges, indexes.hours);
  const fillRows = valueRowsAt(valueRanges, indexes.fills);
  const overfillRows = valueRowsAt(valueRanges, indexes.overfills);
  const standbyRows = valueRowsAt(valueRanges, indexes.standbys);
  const breakRows = valueRowsAt(valueRanges, indexes.breaks);
  const monitorRows = valueRowsAt(valueRanges, indexes.monitor);
  const visible =
    parseSheetBoolean(firstCell(valueRowsAt(valueRanges, indexes.visible), 0)) ?? true;
  const rowCount = Math.max(
    hourRows.length,
    fillRows.length,
    overfillRows.length,
    standbyRows.length,
    breakRows.length,
    monitorRows.length,
  );
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const hour = parseLegacyNumber(firstCell(hourRows, rowIndex)) ?? null;
    const fills = (fillRows[rowIndex] ?? []).slice(0, slotCapacity).flatMap((value) => {
      const valueText = cellText(value);
      return Predicate.isUndefined(valueText) ? [] : [upperFirst(valueText)];
    });
    const overfills = commaSeparated(firstCell(overfillRows, rowIndex)).map(upperFirst);
    const standbys = commaSeparated(firstCell(standbyRows, rowIndex)).map(upperFirst);
    const isBreak =
      configuration.breakRange === "auto"
        ? !runnerPresent(runnerHours, fills, hour)
        : (parseSheetBoolean(firstCell(breakRows, rowIndex)) ?? false);
    const monitor = firstCell(monitorRows, rowIndex);
    return {
      visible,
      hour,
      break: isBreak,
      fills,
      overfills,
      standbys,
      monitor: Predicate.isUndefined(monitor) ? null : upperFirst(monitor),
    };
  });
};

const parseSchedules = (
  configurations: ReadonlyArray<SheetScheduleConfiguration>,
  runners: ReadonlyArray<SheetRunnerConfiguration>,
  indexes: ReadonlyArray<ScheduleRangeIndexes>,
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
): UserScheduleView["schedules"] => {
  const runnerHours = makeRunnerHours(runners);
  return configurations.flatMap((configuration, index) =>
    parseScheduleRows(configuration, indexes[index]!, runnerHours, valueRanges),
  );
};

export const isRetryableUserScheduleReadFailure = ({ cause }: UserScheduleProviderError): boolean =>
  isRetryableRunnerLocalSheetsReadFailure({ cause });

const makeProviderError = (operation: UserScheduleProviderError["operation"]) => (cause: unknown) =>
  new UserScheduleProviderError({ operation, cause });

export const makeUserScheduleProvider = (client: sheets_v4.Sheets): UserScheduleProviderShape => ({
  load: (spreadsheetId, day) =>
    Effect.gen(function* () {
      const configurationRanges = yield* readSheetsValueRanges({
        client,
        spreadsheetId,
        ranges: [rangesConfigRange, eventConfigRange, scheduleConfigRange, runnerConfigRange],
        makeError: makeProviderError("read-configuration"),
      });
      const parsed = yield* Effect.all({
        ranges: parseRangesConfiguration(valueRowsAt(configurationRanges, 0)),
        eventStartEpochMs: parseEventStart(valueRowsAt(configurationRanges, 1)),
        configurations: parseScheduleConfigurations(valueRowsAt(configurationRanges, 2), day),
        runners: parseRunnerConfigurations(valueRowsAt(configurationRanges, 3)),
      }).pipe(Effect.mapError(makeProviderError("read-configuration")));
      const plan = makeUserScheduleRangePlan(parsed.configurations, parsed.ranges);
      const userScheduleRanges = yield* readBatchedSheetsValueRanges({
        client,
        spreadsheetId,
        ranges: plan.ranges,
        makeError: makeProviderError("read-user-schedule"),
      });
      return {
        eventStartEpochMs: parsed.eventStartEpochMs,
        players: parseIdentities(
          valueRowsAt(userScheduleRanges, plan.playerIds),
          valueRowsAt(userScheduleRanges, plan.playerNames),
        ),
        monitors: parseIdentities(
          valueRowsAt(userScheduleRanges, plan.monitorIds),
          valueRowsAt(userScheduleRanges, plan.monitorNames),
        ),
        schedules: parseSchedules(
          parsed.configurations,
          parsed.runners,
          plan.scheduleIndexes,
          userScheduleRanges,
        ),
      };
    }),
});

export const userScheduleProviderLayer = Layer.effect(
  UserScheduleProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeUserScheduleProvider),
  ),
);
