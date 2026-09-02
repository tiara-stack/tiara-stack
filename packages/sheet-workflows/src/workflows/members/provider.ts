import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate, Schema } from "effect";
import {
  cellText,
  firstCell,
  makeRunnerHours,
  makeRunnerLocalSheetsClient,
  parseKeyValueRows,
  parseLegacyNumber,
  parseRunnerConfigurations,
  parseScheduleConfigurations,
  parseSheetBoolean,
  parseSheetIdentities,
  quotedRange,
  readBatchedSheetsValueRanges,
  runnerConfigRange,
  runnerPresent,
  scheduleConfigRange,
  type SheetScheduleConfiguration,
  type ValueRows,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import { slotCapacity } from "../shared/slotCapacity";
import type { WebSheetConfiguration } from "sheet-domain";
import {
  loadConfigurationValueRanges,
  readConfiguredEventStart,
} from "../shared/webConfigurationSheets";

export class MemberKickProviderError extends Data.TaggedError("MemberKickProviderError")<{
  readonly operation:
    | "create-client"
    | "read-event-configuration"
    | "read-schedule-configuration"
    | "read-member-schedule";
  readonly cause: unknown;
}> {}

interface MemberKickScheduleResult {
  readonly scheduleFound: boolean;
  readonly scheduledMemberIds: ReadonlyArray<string>;
}

interface MemberKickProviderShape {
  readonly loadEventStart: (
    spreadsheetId: string,
    configuration?: WebSheetConfiguration | null,
  ) => Effect.Effect<number, MemberKickProviderError>;
  readonly loadSchedule: (
    spreadsheetId: string,
    conversationName: string,
    hour: number,
    configuration?: WebSheetConfiguration | null,
  ) => Effect.Effect<MemberKickScheduleResult, MemberKickProviderError>;
}

export class MemberKickProvider extends Context.Service<
  MemberKickProvider,
  MemberKickProviderShape
>()("sheet-workflows/MemberKickProvider") {}

const rangesConfigRange = "'Thee''s Sheet Settings'!B8:C";

const makeProviderError = (operation: MemberKickProviderError["operation"]) => (cause: unknown) =>
  new MemberKickProviderError({ operation, cause });

// The range names are a legacy Sheet protocol shared with schedule readers.
// fallow-ignore-next-line code-duplication
const parsePlayerRanges = (rows: ValueRows) =>
  Effect.gen(function* () {
    const entries = parseKeyValueRows(rows);
    const userIds = yield* Schema.decodeUnknownEffect(
      Schema.String.annotate({ message: "The User IDs range configuration is missing" }),
    )(entries.get("User IDs"));
    const userNames = yield* Schema.decodeUnknownEffect(
      Schema.String.annotate({ message: "The User Sheet Names range configuration is missing" }),
    )(entries.get("User Sheet Names"));
    return { userIds, userNames };
  });

interface ScheduleIndexes {
  readonly hours: number;
  readonly fills: number;
  readonly breaks: number | undefined;
}

const makeRangePlan = (
  configurations: ReadonlyArray<SheetScheduleConfiguration>,
  playerRanges: { readonly userIds: string; readonly userNames: string },
) => {
  const ranges: Array<string> = [];
  const add = (range: string) => {
    const index = ranges.length;
    ranges.push(range);
    return index;
  };
  const schedules = configurations.map(
    (configuration): ScheduleIndexes => ({
      hours: add(quotedRange(configuration, configuration.hourRange)),
      fills: add(quotedRange(configuration, configuration.fillRange)),
      breaks:
        configuration.breakRange === "auto"
          ? undefined
          : add(quotedRange(configuration, configuration.breakRange)),
    }),
  );
  return {
    ranges,
    schedules,
    playerIds: add(playerRanges.userIds),
    playerNames: add(playerRanges.userNames),
  };
};

const playerIdByCanonicalName = (
  identities: ReadonlyArray<{ readonly accountId: string; readonly name: string }>,
) => {
  const result = new Map<string, string>();
  for (const identity of identities) {
    if (!result.has(identity.name)) result.set(identity.name, identity.accountId);
  }
  return result;
};

const scheduledIdsForConfiguration = (
  configuration: SheetScheduleConfiguration,
  indexes: ScheduleIndexes,
  hour: number,
  valueRanges: Parameters<typeof valueRowsAt>[0],
  runnerHours: ReturnType<typeof makeRunnerHours>,
  playerIds: ReadonlyMap<string, string>,
): MemberKickScheduleResult | undefined => {
  const hourRows = valueRowsAt(valueRanges, indexes.hours);
  const fillRows = valueRowsAt(valueRanges, indexes.fills);
  const breakRows = valueRowsAt(valueRanges, indexes.breaks);
  const rowCount = Math.max(hourRows.length, fillRows.length, breakRows.length);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowHour = parseLegacyNumber(firstCell(hourRows, rowIndex));
    if (rowHour !== hour) continue;
    const fills = (fillRows[rowIndex] ?? []).slice(0, slotCapacity).flatMap((value) => {
      const name = cellText(value);
      return Predicate.isUndefined(name)
        ? []
        : [name.length === 0 ? name : `${name[0]!.toUpperCase()}${name.slice(1)}`];
    });
    const isBreak =
      configuration.breakRange === "auto"
        ? !runnerPresent(runnerHours, fills, rowHour)
        : (parseSheetBoolean(firstCell(breakRows, rowIndex)) ?? false);
    if (isBreak) return { scheduleFound: true, scheduledMemberIds: [] };
    return {
      scheduleFound: true,
      scheduledMemberIds: fills.flatMap((name) => {
        const accountId = playerIds.get(name);
        return Predicate.isUndefined(accountId) ? [] : [accountId];
      }),
    };
  }
  return undefined;
};

export const makeMemberKickProvider = (client: sheets_v4.Sheets): MemberKickProviderShape => ({
  // Event-start decoding deliberately stays aligned with the other runner-local providers.
  // fallow-ignore-next-line code-duplication
  loadEventStart: (spreadsheetId, configuration) =>
    readConfiguredEventStart({
      client,
      spreadsheetId,
      configuration,
      makeError: makeProviderError("read-event-configuration"),
    }),
  loadSchedule: (spreadsheetId, conversationName, hour, configuration) =>
    Effect.gen(function* () {
      const configurationRanges = yield* loadConfigurationValueRanges({
        client,
        spreadsheetId,
        configuration,
        legacyRanges: [rangesConfigRange, scheduleConfigRange, runnerConfigRange],
        selectConfiguredRows: ({ rangesRows, schedulesRows, runnersRows }) => [
          rangesRows,
          schedulesRows,
          runnersRows,
        ],
        makeError: makeProviderError("read-schedule-configuration"),
      });
      const parsed = yield* Effect.all({
        playerRanges: parsePlayerRanges(valueRowsAt(configurationRanges, 0)),
        configurations: parseScheduleConfigurations(valueRowsAt(configurationRanges, 1)),
        runners: parseRunnerConfigurations(valueRowsAt(configurationRanges, 2)),
      }).pipe(Effect.mapError(makeProviderError("read-schedule-configuration")));
      const configurations = parsed.configurations.filter(
        ({ channel }) => channel === conversationName,
      );
      if (configurations.length === 0) {
        return { scheduleFound: false, scheduledMemberIds: [] };
      }
      const plan = makeRangePlan(configurations, parsed.playerRanges);
      const scheduleRanges = yield* readBatchedSheetsValueRanges({
        client,
        spreadsheetId,
        ranges: plan.ranges,
        makeError: makeProviderError("read-member-schedule"),
      });
      const playerIds = playerIdByCanonicalName(
        parseSheetIdentities(
          valueRowsAt(scheduleRanges, plan.playerIds),
          valueRowsAt(scheduleRanges, plan.playerNames),
        ),
      );
      const runnerHours = makeRunnerHours(parsed.runners);
      for (const [index, configuration] of configurations.entries()) {
        const result = scheduledIdsForConfiguration(
          configuration,
          plan.schedules[index]!,
          hour,
          scheduleRanges,
          runnerHours,
          playerIds,
        );
        if (Predicate.isNotUndefined(result)) return result;
      }
      return { scheduleFound: false, scheduledMemberIds: [] };
    }),
});

export const memberKickProviderLayer = Layer.effect(
  MemberKickProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeMemberKickProvider),
  ),
);
