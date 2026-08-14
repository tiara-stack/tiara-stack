import type { sheets_v4 } from "@googleapis/sheets";
import { Cause, Context, Data, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import {
  cellText,
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
  type ScheduleEncodingType,
  type SheetScheduleConfiguration,
  upperFirst,
  ValueRange,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import { makeUserTeamsProvider } from "../teams/provider";
import type { RoomOrderCalculationTeam } from "./createCalculation";

export class RoomOrderCreateProviderError extends Data.TaggedError("RoomOrderCreateProviderError")<{
  readonly operation:
    | "create-client"
    | "read-configuration"
    | "read-schedule"
    | "read-schedule-format"
    | "read-teams";
  readonly cause: unknown;
}> {}

interface RoomOrderProviderFill {
  readonly accountId: string | null;
  readonly name: string;
  readonly enc: boolean;
}

interface RoomOrderProviderSchedule {
  readonly hour: number | null;
  readonly fills: ReadonlyArray<RoomOrderProviderFill>;
  readonly monitor: string | null;
}

interface RoomOrderCreateProviderView {
  readonly eventStartEpochMs: number;
  readonly schedules: ReadonlyArray<RoomOrderProviderSchedule>;
  readonly teamsByPlayerName: ReadonlyMap<string, ReadonlyArray<RoomOrderCalculationTeam>>;
}

interface RoomOrderCreateProviderShape {
  readonly load: (
    spreadsheetId: string,
    conversationName: string,
  ) => Effect.Effect<RoomOrderCreateProviderView, RoomOrderCreateProviderError>;
}

export class RoomOrderCreateProvider extends Context.Service<
  RoomOrderCreateProvider,
  RoomOrderCreateProviderShape
>()("sheet-workflows/RoomOrderCreateProvider") {}

const makeProviderError =
  (operation: RoomOrderCreateProviderError["operation"]) => (cause: unknown) =>
    new RoomOrderCreateProviderError({ operation, cause });

const TextFormat = Schema.Struct({
  bold: Schema.optional(Schema.NullOr(Schema.Boolean)),
  underline: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
const CellFormat = Schema.Struct({ textFormat: Schema.optional(Schema.NullOr(TextFormat)) });
const GridCell = Schema.Struct({
  formattedValue: Schema.optional(Schema.NullOr(Schema.String)),
  effectiveFormat: Schema.optional(Schema.NullOr(CellFormat)),
  userEnteredFormat: Schema.optional(Schema.NullOr(CellFormat)),
});
const GridRow = Schema.Struct({ values: Schema.optional(Schema.Array(GridCell)) });
const GridData = Schema.Struct({
  startRow: Schema.optional(Schema.Number),
  startColumn: Schema.optional(Schema.Number),
  rowData: Schema.optional(Schema.Array(GridRow)),
});
const GridSheet = Schema.Struct({
  properties: Schema.optional(Schema.Struct({ title: Schema.optional(Schema.String) })),
  data: Schema.optional(Schema.Array(GridData)),
});
const GridResponse = Schema.Struct({ sheets: Schema.optional(Schema.Array(GridSheet)) });
type GridRows = ReadonlyArray<typeof GridRow.Type>;

const columnNumber = (column: string) => {
  let result = 0;
  for (const character of column)
    result = result * 26 + (character.toUpperCase().charCodeAt(0) - 64);
  return result;
};

const rangeKey = (sheet: string, row: number, column: number) => `${sheet}::${row}::${column}`;

const parseRangeKey = (range: string): string | undefined => {
  const rangeMatch = /^(?:'((?:[^']|'')*)'|([^!]+))!(.+)$/u.exec(range);
  const sheet = (rangeMatch?.[1] ?? rangeMatch?.[2])?.replaceAll("''", "'");
  const reference = rangeMatch?.[3]?.split(":")[0];
  const cellMatch = /^\$?([A-Za-z]+)\$?(\d+)$/u.exec(reference ?? "");
  return Predicate.isUndefined(sheet) ||
    Predicate.isUndefined(cellMatch?.[1]) ||
    Predicate.isUndefined(cellMatch[2])
    ? undefined
    : rangeKey(sheet, Number.parseInt(cellMatch[2], 10), columnNumber(cellMatch[1]));
};

const formatAt = (cell: typeof GridCell.Type) =>
  cell.effectiveFormat?.textFormat ?? cell.userEnteredFormat?.textFormat;

const readScheduleGridRows = (options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly ranges: ReadonlyArray<string>;
}) => {
  const makeError = makeProviderError("read-schedule-format");
  if (options.ranges.length === 0) return Effect.succeed([]);
  return Effect.tryPromise({
    try: () =>
      options.client.spreadsheets.get({
        spreadsheetId: options.spreadsheetId,
        ranges: [...options.ranges],
        includeGridData: true,
        fields:
          "sheets.properties.title,sheets.data.startRow,sheets.data.startColumn,sheets.data.rowData.values.formattedValue,sheets.data.rowData.values.effectiveFormat.textFormat,sheets.data.rowData.values.userEnteredFormat.textFormat",
      }),
    catch: makeError,
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((error) => (Cause.isTimeoutError(error) ? makeError(error) : error)),
    Effect.retry({
      schedule: Schedule.exponential("100 millis").pipe(Schedule.jittered),
      times: 2,
      while: (error) => isRetryableRunnerLocalSheetsReadFailure(error),
    }),
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(GridResponse)(response.data).pipe(Effect.mapError(makeError)),
    ),
    // Grid responses require explicit coordinate reconciliation across sheets and data blocks.
    // fallow-ignore-next-line complexity
    Effect.flatMap(({ sheets }) => {
      const rowsByKey = new Map<string, GridRows>();
      for (const sheet of sheets ?? []) {
        const title = sheet.properties?.title ?? "";
        for (const data of sheet.data ?? []) {
          rowsByKey.set(
            rangeKey(title, (data.startRow ?? 0) + 1, (data.startColumn ?? 0) + 1),
            data.rowData ?? [],
          );
        }
      }
      const rows = options.ranges.map((range) => {
        const key = parseRangeKey(range);
        return Predicate.isUndefined(key) ? undefined : rowsByKey.get(key);
      });
      return rows.some(Predicate.isUndefined)
        ? Effect.fail(makeError(new Error("The schedule formatting response was incomplete")))
        : Effect.succeed(rows as ReadonlyArray<GridRows>);
    }),
  );
};

interface ScheduleIndexes {
  readonly hours: number;
  readonly fills: number;
  readonly breaks: number | undefined;
  readonly monitor: number | undefined;
}

// This range plan is deliberately parallel to schedule reads while the legacy provider remains.
// fallow-ignore-next-line code-duplication
const makeSchedulePlan = (configurations: ReadonlyArray<SheetScheduleConfiguration>) => {
  const ranges: Array<string> = [];
  const add = (range: string) => {
    const index = ranges.length;
    ranges.push(range);
    return index;
  };
  return {
    ranges,
    fillRanges: configurations.map((configuration) =>
      quotedRange(configuration, configuration.fillRange),
    ),
    indexes: configurations.map(
      (configuration): ScheduleIndexes => ({
        hours: add(quotedRange(configuration, configuration.hourRange)),
        fills: add(quotedRange(configuration, configuration.fillRange)),
        // Range indexing intentionally matches the established runner-local schedule provider.
        // fallow-ignore-next-line code-duplication
        breaks:
          configuration.breakRange === "auto"
            ? undefined
            : add(quotedRange(configuration, configuration.breakRange)),
        monitor: Predicate.isUndefined(configuration.monitorRange)
          ? undefined
          : add(quotedRange(configuration, configuration.monitorRange)),
      }),
    ),
  };
};

const playerPattern = /^(?<name>.*?)\s+(?<enc>\(e(?:nc)?\))?$/u;

const parsedPlayerName = (value: string) =>
  upperFirst(playerPattern.exec(value)?.groups?.name ?? value);

const isRegexEnc = (value: string) =>
  Predicate.isNotUndefined(playerPattern.exec(value)?.groups?.enc);

const isFormattedEnc = (
  encoding: ScheduleEncodingType,
  cell: typeof GridCell.Type | undefined,
): boolean => {
  const format = Predicate.isUndefined(cell) ? undefined : formatAt(cell);
  return encoding === "bold"
    ? (format?.bold ?? false)
    : encoding === "underline"
      ? (format?.underline ?? false)
      : false;
};

const resolveFill = (
  rawName: string,
  enc: boolean,
  playersByName: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly accountId: string; readonly name: string }>
  >,
): RoomOrderProviderFill => {
  const name = parsedPlayerName(rawName);
  const player = playersByName.get(name)?.[0];
  return { accountId: player?.accountId ?? null, name: player?.name ?? name, enc };
};

const parseScheduleRows = (options: {
  readonly configuration: SheetScheduleConfiguration;
  readonly indexes: ScheduleIndexes;
  readonly values: ReadonlyArray<typeof ValueRange.Type>;
  readonly gridRows: GridRows;
  readonly runnerHours: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly start: number; readonly end: number }>
  >;
  readonly playersByName: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly accountId: string; readonly name: string }>
  >;
}): ReadonlyArray<RoomOrderProviderSchedule> => {
  const hourRows = valueRowsAt(options.values, options.indexes.hours);
  const fillRows = valueRowsAt(options.values, options.indexes.fills);
  const breakRows = valueRowsAt(options.values, options.indexes.breaks);
  const monitorRows = valueRowsAt(options.values, options.indexes.monitor);
  const rowCount = Math.max(
    hourRows.length,
    fillRows.length,
    breakRows.length,
    monitorRows.length,
    options.gridRows.length,
  );
  return globalThis.Array.from({ length: rowCount }, (_, rowIndex) => {
    const hour = parseLegacyNumber(firstCell(hourRows, rowIndex)) ?? null;
    const rawFills = (fillRows[rowIndex] ?? []).slice(0, 5).flatMap((value, columnIndex) => {
      const name = cellText(value);
      return Predicate.isUndefined(name) ? [] : [{ columnIndex, name }];
    });
    const fills = rawFills.map(({ columnIndex, name }) =>
      resolveFill(
        name,
        options.configuration.encType === "regex"
          ? isRegexEnc(name)
          : isFormattedEnc(
              options.configuration.encType,
              options.gridRows[rowIndex]?.values?.[columnIndex],
            ),
        options.playersByName,
      ),
    );
    const breakHour =
      options.configuration.breakRange === "auto"
        ? !runnerPresent(
            options.runnerHours,
            fills.map(({ name }) => name),
            hour,
          )
        : (parseSheetBoolean(firstCell(breakRows, rowIndex)) ?? false);
    const monitor = firstCell(monitorRows, rowIndex);
    return {
      hour,
      fills: breakHour ? [] : fills,
      monitor: breakHour || Predicate.isUndefined(monitor) ? null : upperFirst(monitor),
    };
  });
};

const groupByName = <A extends { readonly name: string }>(values: ReadonlyArray<A>) => {
  const grouped = new Map<string, Array<A>>();
  for (const value of values) grouped.set(value.name, [...(grouped.get(value.name) ?? []), value]);
  return grouped;
};

const makeTeamsByPlayerName = (
  players: ReadonlyArray<{ readonly accountId: string; readonly name: string }>,
  teams: ReadonlyArray<{
    readonly playerName: string;
    readonly teamName: string;
    readonly tags: ReadonlyArray<string>;
    readonly lead: number;
    readonly backline: number;
    readonly talent: number | null;
  }>,
) => {
  const playersByName = groupByName(players);
  const result = new Map<string, ReadonlyArray<RoomOrderCalculationTeam>>();
  for (const [name, identities] of playersByName) {
    const accountId = identities[0]?.accountId;
    if (
      Predicate.isUndefined(accountId) ||
      identities.some((identity) => identity.accountId !== accountId)
    ) {
      result.set(name, []);
      continue;
    }
    result.set(
      name,
      teams
        .filter((team) => team.playerName === name)
        .map((team) => ({
          playerId: accountId,
          playerName: name,
          teamName: team.teamName,
          tags: team.tags,
          lead: team.lead,
          backline: team.backline,
          talent: team.talent ?? 0,
          encable: false,
          tierer: false,
        })),
    );
  }
  return result;
};

export const makeRoomOrderCreateProvider = (
  client: sheets_v4.Sheets,
): RoomOrderCreateProviderShape => {
  const teamsProvider = makeUserTeamsProvider(client);
  return {
    load: (spreadsheetId, conversationName) =>
      Effect.gen(function* () {
        const [configurationRanges, userTeams] = yield* Effect.all(
          [
            readSheetsValueRanges({
              client,
              spreadsheetId,
              ranges: [eventConfigRange, scheduleConfigRange, runnerConfigRange],
              makeError: makeProviderError("read-configuration"),
            }),
            teamsProvider
              .load(spreadsheetId)
              .pipe(Effect.mapError((error) => makeProviderError("read-teams")(error))),
          ],
          { concurrency: "unbounded" },
        );
        const parsed = yield* Effect.all({
          eventStartEpochMs: parseEventStart(valueRowsAt(configurationRanges, 0)),
          configurations: parseScheduleConfigurations(valueRowsAt(configurationRanges, 1)),
          runners: parseRunnerConfigurations(valueRowsAt(configurationRanges, 2)),
        }).pipe(Effect.mapError(makeProviderError("read-configuration")));
        const configurations = parsed.configurations.filter(
          (configuration) => configuration.channel === conversationName,
        );
        const plan = makeSchedulePlan(configurations);
        const [values, gridRows] = yield* Effect.all(
          [
            readBatchedSheetsValueRanges({
              client,
              spreadsheetId,
              ranges: plan.ranges,
              makeError: makeProviderError("read-schedule"),
            }),
            readScheduleGridRows({ client, spreadsheetId, ranges: plan.fillRanges }),
          ],
          { concurrency: "unbounded" },
        );
        const playersByName = groupByName(userTeams.players);
        const runnerHours = makeRunnerHours(parsed.runners);
        return {
          eventStartEpochMs: parsed.eventStartEpochMs,
          schedules: configurations.flatMap((configuration, index) =>
            parseScheduleRows({
              configuration,
              indexes: plan.indexes[index]!,
              values,
              gridRows: gridRows[index]!,
              runnerHours,
              playersByName,
            }),
          ),
          teamsByPlayerName: makeTeamsByPlayerName(userTeams.players, userTeams.teams),
        };
      }),
  };
};

export const roomOrderCreateProviderLayer = Layer.effect(
  RoomOrderCreateProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeRoomOrderCreateProvider),
  ),
);
