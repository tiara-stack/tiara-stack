import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate, Schema } from "effect";
import {
  cellText,
  commaSeparated,
  eventConfigRange,
  firstCell,
  makeRunnerHours,
  makeRunnerLocalSheetsClient,
  parseEventStart,
  parseKeyValueRows,
  parseLegacyNumber,
  parseRunnerConfigurations,
  parseScheduleConfigurations,
  parseSheetBoolean,
  parseSheetIdentities,
  quotedRange,
  readBatchedSheetsValueRanges,
  readSheetsValueRanges,
  runnerConfigRange,
  runnerPresent,
  scheduleConfigRange,
  type SheetScheduleConfiguration,
  upperFirst,
  type ValueRows,
  ValueRange,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import {
  makeRoomOrderCreateProvider,
  RoomOrderCreateProviderError,
} from "../roomOrders/createProvider";
import type { RoomOrderCalculationTeam } from "../roomOrders/createCalculation";

export class AutoCheckinTestProviderError extends Data.TaggedError("AutoCheckinTestProviderError")<{
  readonly operation: "create-client" | "read-configuration" | "read-schedule" | "read-room-order";
  readonly cause: unknown;
}> {}

export interface AutoCheckinTestProviderParticipant {
  readonly accountId: string | null;
  readonly name: string;
}

interface AutoCheckinTestProviderSchedule {
  readonly hour: number | null;
  readonly fills: ReadonlyArray<AutoCheckinTestProviderParticipant>;
  readonly overfillCount: number;
  readonly monitor: AutoCheckinTestProviderParticipant | null;
}

interface AutoCheckinTestProviderView {
  readonly eventStartEpochMs: number;
  readonly schedules: ReadonlyArray<AutoCheckinTestProviderSchedule>;
}

interface AutoCheckinTestRoomOrderView {
  readonly eventStartEpochMs: number;
  readonly schedules: ReadonlyArray<{
    readonly hour: number | null;
    readonly fills: ReadonlyArray<{
      readonly accountId: string | null;
      readonly name: string;
      readonly enc: boolean;
    }>;
    readonly monitor: string | null;
  }>;
  readonly teamsByPlayerName: ReadonlyMap<string, ReadonlyArray<RoomOrderCalculationTeam>>;
}

interface AutoCheckinTestProviderShape {
  readonly loadCheckin: (
    spreadsheetId: string,
    conversationName: string,
  ) => Effect.Effect<AutoCheckinTestProviderView, AutoCheckinTestProviderError>;
  readonly loadRoomOrder: (
    spreadsheetId: string,
    conversationName: string,
  ) => Effect.Effect<AutoCheckinTestRoomOrderView, AutoCheckinTestProviderError>;
}

export class AutoCheckinTestProvider extends Context.Service<
  AutoCheckinTestProvider,
  AutoCheckinTestProviderShape
>()("sheet-workflows/AutoCheckinTestProvider") {}

const rangesConfigRange = "'Thee''s Sheet Settings'!B8:C";

interface IdentityRanges {
  readonly playerIds: string;
  readonly playerNames: string;
  readonly monitorIds: string | undefined;
  readonly monitorNames: string | undefined;
}

interface ScheduleIndexes {
  readonly hours: number;
  readonly fills: number;
  readonly overfills: number;
  readonly breaks: number | undefined;
  readonly monitor: number | undefined;
}

const makeProviderError =
  (operation: AutoCheckinTestProviderError["operation"]) => (cause: unknown) =>
    new AutoCheckinTestProviderError({ operation, cause });

const parseIdentityRanges = (rows: ValueRows) =>
  Effect.gen(function* () {
    const entries = parseKeyValueRows(rows);
    return {
      playerIds: yield* Schema.decodeUnknownEffect(
        Schema.String.annotate({ message: "The User IDs range configuration is missing" }),
      )(entries.get("User IDs")),
      playerNames: yield* Schema.decodeUnknownEffect(
        Schema.String.annotate({ message: "The User Sheet Names range configuration is missing" }),
      )(entries.get("User Sheet Names")),
      monitorIds: entries.get("Moni IDs"),
      monitorNames: entries.get("Moni Names"),
    } satisfies IdentityRanges;
  });

const makeSchedulePlan = (
  configurations: ReadonlyArray<SheetScheduleConfiguration>,
  identities: IdentityRanges,
) => {
  const ranges: Array<string> = [];
  const add = (range: string) => {
    const index = ranges.length;
    ranges.push(range);
    return index;
  };
  const indexes = configurations.map(
    // The range plan intentionally mirrors the established schedule provider grammar.
    // fallow-ignore-next-line code-duplication
    (configuration): ScheduleIndexes => ({
      hours: add(quotedRange(configuration, configuration.hourRange)),
      fills: add(quotedRange(configuration, configuration.fillRange)),
      overfills: add(quotedRange(configuration, configuration.overfillRange)),
      monitor: Predicate.isUndefined(configuration.monitorRange)
        ? undefined
        : add(quotedRange(configuration, configuration.monitorRange)),
      breaks:
        configuration.breakRange === "auto"
          ? undefined
          : add(quotedRange(configuration, configuration.breakRange)),
    }),
  );
  const playerIds = add(identities.playerIds);
  const playerNames = add(identities.playerNames);
  const monitorIndexes =
    Predicate.isNotUndefined(identities.monitorIds) &&
    Predicate.isNotUndefined(identities.monitorNames)
      ? {
          monitorIds: add(identities.monitorIds),
          monitorNames: add(identities.monitorNames),
        }
      : { monitorIds: undefined, monitorNames: undefined };
  return { ranges, indexes, playerIds, playerNames, ...monitorIndexes };
};

const playerPattern = /^(?<name>.*?)\s+(?<enc>\(e(?:nc)?\))?$/u;

const participantName = (value: string): string =>
  upperFirst(playerPattern.exec(value)?.groups?.name ?? value);

const groupIdentities = (
  identities: ReadonlyArray<{ readonly accountId: string; readonly name: string }>,
) => {
  const result = new Map<string, Array<{ readonly accountId: string; readonly name: string }>>();
  for (const identity of identities) {
    result.set(identity.name, [...(result.get(identity.name) ?? []), identity]);
  }
  return result;
};

const resolveParticipant = (
  rawName: string,
  identities: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly accountId: string; readonly name: string }>
  >,
): AutoCheckinTestProviderParticipant => {
  const name = participantName(rawName);
  const identity = identities.get(name)?.[0];
  return { accountId: identity?.accountId ?? null, name: identity?.name ?? name };
};

const parseScheduleRows = (options: {
  readonly configuration: SheetScheduleConfiguration;
  readonly indexes: ScheduleIndexes;
  readonly values: ReadonlyArray<typeof ValueRange.Type>;
  readonly runnerHours: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly start: number; readonly end: number }>
  >;
  readonly players: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly accountId: string; readonly name: string }>
  >;
  readonly monitors: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly accountId: string; readonly name: string }>
  >;
}): ReadonlyArray<AutoCheckinTestProviderSchedule> => {
  // These parallel range reads preserve legacy runner-local Sheets row alignment.
  // fallow-ignore-next-line code-duplication
  const hourRows = valueRowsAt(options.values, options.indexes.hours);
  const fillRows = valueRowsAt(options.values, options.indexes.fills);
  const overfillRows = valueRowsAt(options.values, options.indexes.overfills);
  const breakRows = valueRowsAt(options.values, options.indexes.breaks);
  const monitorRows = valueRowsAt(options.values, options.indexes.monitor);
  const alignedRows = [hourRows, fillRows, overfillRows, breakRows, monitorRows];
  const rowCount = Math.max(...alignedRows.map(({ length }) => length));
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const hour = parseLegacyNumber(firstCell(hourRows, rowIndex)) ?? null;
    const fills = (fillRows[rowIndex] ?? []).slice(0, 5).flatMap((value) => {
      const name = cellText(value);
      return Predicate.isUndefined(name) ? [] : [resolveParticipant(name, options.players)];
    });
    // Break-hour behavior must remain identical to the schedule provider during migration.
    // fallow-ignore-next-line code-duplication
    const breakHour =
      options.configuration.breakRange === "auto"
        ? !runnerPresent(
            options.runnerHours,
            fills.map(({ name }) => name),
            hour,
          )
        : (parseSheetBoolean(firstCell(breakRows, rowIndex)) ?? false);
    const monitorName = firstCell(monitorRows, rowIndex);
    return breakHour
      ? { hour, fills: [], overfillCount: 0, monitor: null }
      : {
          hour,
          fills,
          overfillCount: commaSeparated(firstCell(overfillRows, rowIndex)).length,
          monitor: Predicate.isUndefined(monitorName)
            ? null
            : resolveParticipant(monitorName, options.monitors),
        };
  });
};

const makeAutoCheckinTestProvider = (client: sheets_v4.Sheets): AutoCheckinTestProviderShape => {
  const roomOrderProvider = makeRoomOrderCreateProvider(client);
  return {
    loadCheckin: (spreadsheetId, conversationName) =>
      Effect.gen(function* () {
        const configurationRanges = yield* readSheetsValueRanges({
          client,
          spreadsheetId,
          ranges: [eventConfigRange, scheduleConfigRange, runnerConfigRange, rangesConfigRange],
          makeError: makeProviderError("read-configuration"),
        });
        const parsed = yield* Effect.all({
          identities: parseIdentityRanges(valueRowsAt(configurationRanges, 3)),
          runners: parseRunnerConfigurations(valueRowsAt(configurationRanges, 2)),
          configurations: parseScheduleConfigurations(valueRowsAt(configurationRanges, 1)),
          eventStartEpochMs: parseEventStart(valueRowsAt(configurationRanges, 0)),
        }).pipe(Effect.mapError(makeProviderError("read-configuration")));
        const configurations = parsed.configurations.filter(
          (configuration) => configuration.channel === conversationName,
        );
        const plan = makeSchedulePlan(configurations, parsed.identities);
        const values = yield* readBatchedSheetsValueRanges({
          client,
          spreadsheetId,
          ranges: plan.ranges,
          makeError: makeProviderError("read-schedule"),
        });
        const players = groupIdentities(
          parseSheetIdentities(
            valueRowsAt(values, plan.playerIds),
            valueRowsAt(values, plan.playerNames),
          ),
        );
        const monitors = groupIdentities(
          parseSheetIdentities(
            valueRowsAt(values, plan.monitorIds),
            valueRowsAt(values, plan.monitorNames),
          ),
        );
        const runnerHours = makeRunnerHours(parsed.runners);
        return {
          eventStartEpochMs: parsed.eventStartEpochMs,
          schedules: configurations.flatMap((configuration, index) =>
            parseScheduleRows({
              configuration,
              indexes: plan.indexes[index]!,
              values,
              runnerHours,
              players,
              monitors,
            }),
          ),
        };
      }),
    loadRoomOrder: (spreadsheetId, conversationName) =>
      roomOrderProvider.load(spreadsheetId, conversationName).pipe(
        Effect.mapError(
          (cause: RoomOrderCreateProviderError) =>
            new AutoCheckinTestProviderError({
              operation: "read-room-order",
              cause,
            }),
        ),
      ),
  };
};

export const autoCheckinTestProviderLayer = Layer.effect(
  AutoCheckinTestProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeAutoCheckinTestProvider),
  ),
);
