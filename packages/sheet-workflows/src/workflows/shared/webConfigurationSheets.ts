import type { sheets_v4 } from "@googleapis/sheets";
import { Cause, Effect, Match, Predicate, Schedule, Schema } from "effect";
import {
  SheetRange,
  SheetRangeCoordinates,
  WebSheetConfiguration,
  formatSheetRangeOption,
  sheetRangeFromCoordinates,
} from "sheet-domain";
import {
  isRetryableRunnerLocalSheetsReadFailure,
  readEventStart,
  readSheetsValueRanges,
  type ValueRows,
  ValueRange,
} from "./runnerLocalSheets";
import { sheetsProviderMetadataResponse } from "./sheetsProviderResponse";

type Configuration = typeof WebSheetConfiguration.Type;
type Range = typeof SheetRange.Type;
type LocalRange = typeof SheetRangeCoordinates.Type;

export interface WebConfigurationSheetTab {
  readonly sheetId: number;
  readonly title: string;
}

export interface WebConfigurationSheetAdapter {
  readonly rangesRows: ValueRows;
  readonly teamsRows: ValueRows;
  readonly eventRows: ValueRows;
  readonly schedulesRows: ValueRows;
  readonly runnersRows: ValueRows;
  readonly tabs: ReadonlyArray<WebConfigurationSheetTab>;
}

type WebConfigurationSheetRows = Omit<WebConfigurationSheetAdapter, "tabs">;

const retrySchedule = Schedule.exponential("100 millis").pipe(Schedule.jittered);
const providerRequestTimeoutMillis = 30_000;

const rangeEnd = (range: LocalRange): string => {
  const formatted = formatSheetRangeOption("sheet", { sheetId: 0, ...range });
  if (formatted === undefined)
    throw new Error("The persisted Sheet Configuration range is invalid");
  return formatted.slice(formatted.lastIndexOf("!") + 1);
};

const rangesInConfiguration = (configuration: Configuration): ReadonlyArray<Range> => {
  const ranges: Array<Range> = [configuration.users.userIds, configuration.users.userSheetNames];
  const add = (range: Range | undefined) => {
    if (range !== undefined) ranges.push(range);
  };
  const addLocal = (sheetId: number, range: LocalRange | undefined) => {
    if (range !== undefined) ranges.push(sheetRangeFromCoordinates(sheetId, range));
  };
  add(configuration.users.userNotes);
  add(configuration.users.monitors?.ids);
  add(configuration.users.monitors?.names);
  add(configuration.users.oshis);
  for (const team of configuration.teams) {
    if (team.teamName !== "auto") addLocal(team.sheetId, team.teamName);
    addLocal(team.sheetId, team.userNames);
    Match.value(team.isv).pipe(
      Match.discriminator("kind")("combined", ({ range }) => {
        addLocal(team.sheetId, range);
      }),
      Match.discriminator("kind")("split", ({ lead, backline, talent }) => {
        addLocal(team.sheetId, lead);
        addLocal(team.sheetId, backline);
        addLocal(team.sheetId, talent);
      }),
      Match.exhaustive,
    );
    Match.value(team.tags).pipe(
      Match.discriminator("kind")("constants", () => undefined),
      Match.discriminator("kind")("ranges", ({ range }) => {
        addLocal(team.sheetId, range);
      }),
      Match.exhaustive,
    );
    addLocal(team.sheetId, team.oshiRange);
  }
  for (const schedule of configuration.schedules) {
    addLocal(schedule.sheetId, schedule.hourRange);
    if (schedule.breakRange !== "auto") addLocal(schedule.sheetId, schedule.breakRange);
    addLocal(schedule.sheetId, schedule.monitorRange);
    addLocal(schedule.sheetId, schedule.fillRange);
    addLocal(schedule.sheetId, schedule.overfillRange);
    addLocal(schedule.sheetId, schedule.standbyRange);
    addLocal(schedule.sheetId, schedule.screenshotRange);
    addLocal(schedule.sheetId, schedule.noteRange);
    addLocal(schedule.sheetId, schedule.visibleCell);
  }
  return ranges;
};

const row = (...values: ReadonlyArray<string | undefined>): ReadonlyArray<string> =>
  values.map((value) => value ?? "");

/**
 * Builds the old provider row grammar from the canonical configuration without reading the
 * legacy settings tab. The row grammar is only an adapter for existing value parsers; the
 * persisted source remains the typed web configuration.
 */
const rowsFromConfiguration = (
  configuration: Configuration,
  titleFor: (sheetId: number) => string,
  qualifiedRange: (range: Range) => string,
  localRange: (range: LocalRange) => string,
): WebConfigurationSheetRows => {
  const users = configuration.users;
  const rangesRows: ValueRows = [
    row("User IDs", qualifiedRange(users.userIds)),
    row("User Sheet Names", qualifiedRange(users.userSheetNames)),
    ...(users.userNotes === undefined ? [] : [row("User Notes", qualifiedRange(users.userNotes))]),
    ...(users.monitors?.ids === undefined
      ? []
      : [row("Moni IDs", qualifiedRange(users.monitors.ids))]),
    ...(users.monitors?.names === undefined
      ? []
      : [row("Moni Names", qualifiedRange(users.monitors.names))]),
    ...(users.oshis === undefined ? [] : [row("Oshis", qualifiedRange(users.oshis))]),
  ];

  const teamsRows: ValueRows = configuration.teams.map((team) => {
    const sheetTitle = titleFor(team.sheetId);
    const isv = Match.value(team.isv).pipe(
      Match.discriminator("kind")(
        "combined",
        ({ range }) => ["combined", localRange(range)] as const,
      ),
      Match.discriminator("kind")(
        "split",
        ({ lead, backline, talent }) =>
          [
            "split",
            [localRange(lead), localRange(backline), localRange(talent)].join(","),
          ] as const,
      ),
      Match.exhaustive,
    );
    const tags = Match.value(team.tags).pipe(
      Match.discriminator("kind")(
        "constants",
        ({ values }) => ["constants", values.join(",")] as const,
      ),
      Match.discriminator("kind")("ranges", ({ range }) => ["ranges", localRange(range)] as const),
      Match.exhaustive,
    );
    return row(
      team.name ?? team.entryId,
      sheetTitle,
      localRange(team.userNames),
      team.teamName === "auto" ? "auto" : localRange(team.teamName),
      isv[0],
      isv[1],
      tags[0],
      tags[1],
      team.oshiRange === undefined ? undefined : localRange(team.oshiRange),
    );
  });

  const eventRows: ValueRows = [
    row("Start Time", String(configuration.event.startTimeEpochMs / 1_000)),
  ];
  const schedulesRows: ValueRows = configuration.schedules.map((schedule) => {
    const scheduleRow = Array.from({ length: 13 }, () => "");
    scheduleRow[0] = schedule.channel;
    scheduleRow[1] = String(schedule.day);
    scheduleRow[2] = titleFor(schedule.sheetId);
    scheduleRow[3] = localRange(schedule.hourRange);
    scheduleRow[4] = schedule.breakRange === "auto" ? "auto" : localRange(schedule.breakRange);
    scheduleRow[5] = schedule.monitorRange === undefined ? "" : localRange(schedule.monitorRange);
    scheduleRow[6] = schedule.encoding;
    scheduleRow[7] = localRange(schedule.fillRange);
    scheduleRow[8] = localRange(schedule.overfillRange);
    scheduleRow[9] = localRange(schedule.standbyRange);
    scheduleRow[10] =
      schedule.screenshotRange === undefined ? "" : localRange(schedule.screenshotRange);
    scheduleRow[11] = schedule.noteRange === undefined ? "" : localRange(schedule.noteRange);
    scheduleRow[12] = localRange(schedule.visibleCell);
    return scheduleRow;
  });
  const runnersRows: ValueRows = configuration.runners.map((runner) =>
    row(runner.name, runner.hours.map(({ start, end }) => `${start}-${end}`).join(",")),
  );

  return { rangesRows, teamsRows, eventRows, schedulesRows, runnersRows };
};

/** Resolves stable sheet IDs to current titles before any canonical range is read. */
export const loadWebConfigurationSheetAdapter = <E extends { readonly cause: unknown }>(options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly configuration: Configuration;
  readonly makeError: (cause: unknown) => E;
}): Effect.Effect<WebConfigurationSheetAdapter, E> =>
  Effect.tryPromise({
    try: () =>
      options.client.spreadsheets.get(
        {
          spreadsheetId: options.spreadsheetId,
          fields: "spreadsheetId,sheets(properties(sheetId,title,sheetType))",
        },
        { timeout: providerRequestTimeoutMillis },
      ),
    catch: options.makeError,
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((error) => (Cause.isTimeoutError(error) ? options.makeError(error) : error)),
    Effect.retry({
      schedule: retrySchedule,
      times: 2,
      while: isRetryableRunnerLocalSheetsReadFailure,
    }),
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(sheetsProviderMetadataResponse)(response.data).pipe(
        Effect.mapError(options.makeError),
      ),
    ),
    Effect.flatMap((data) => {
      if (data.spreadsheetId !== options.spreadsheetId) {
        return Effect.fail(
          options.makeError(new Error("The Sheets provider returned a different spreadsheet")),
        );
      }
      // Metadata normalization rejects malformed tabs before they become addressable grid targets.
      // fallow-ignore-next-line complexity
      const tabs = (data.sheets ?? []).flatMap(({ properties }) => {
        const sheetId = properties?.sheetId;
        const title = properties?.title;
        const sheetType = properties?.sheetType;
        if (
          !Predicate.isNumber(sheetId) ||
          !Number.isInteger(sheetId) ||
          sheetId < 0 ||
          !Predicate.isString(title) ||
          title.length === 0 ||
          !Predicate.isString(sheetType) ||
          sheetType.length === 0
        ) {
          return [];
        }
        return [{ sheetId, title, sheetType }];
      });
      const rawTabs = data.sheets ?? [];
      if (tabs.length !== rawTabs.length) {
        return Effect.fail(
          options.makeError(new Error("The Sheets provider returned invalid tab metadata")),
        );
      }
      if (
        new Set(tabs.map(({ sheetId }) => sheetId)).size !== tabs.length ||
        new Set(tabs.map(({ title }) => title)).size !== tabs.length
      ) {
        return Effect.fail(
          options.makeError(new Error("The Sheets provider returned ambiguous tab metadata")),
        );
      }
      const byId = new Map(tabs.map((tab) => [tab.sheetId, tab] as const));
      const titleFor = (sheetId: number): string => {
        const tab = byId.get(sheetId);
        if (tab === undefined) throw new Error(`Configured sheet ${sheetId} was not found`);
        if (tab.sheetType !== "GRID") {
          throw new Error(`Configured sheet ${sheetId} is not a GRID tab`);
        }
        return tab.title;
      };
      const qualifiedRange = (range: Range) => {
        const formatted = formatSheetRangeOption(titleFor(range.sheetId), range);
        if (formatted === undefined) {
          throw new Error("The persisted Sheet Configuration range is invalid");
        }
        return formatted;
      };
      const localRange = (range: LocalRange) => rangeEnd(range);
      try {
        for (const range of rangesInConfiguration(options.configuration)) titleFor(range.sheetId);
        const rows = rowsFromConfiguration(
          options.configuration,
          titleFor,
          qualifiedRange,
          localRange,
        );
        return Effect.succeed({
          ...rows,
          tabs: tabs.map(({ sheetId, title }) => ({ sheetId, title })),
        });
      } catch (cause) {
        return Effect.fail(options.makeError(cause));
      }
    }),
  );

export const validateConfigurationSpreadsheet = <E extends { readonly cause: unknown }>(options: {
  readonly spreadsheetId: string;
  readonly configuration: Configuration | null | undefined;
  readonly makeError: (cause: unknown) => E;
}): Effect.Effect<Configuration | null | undefined, E> =>
  Predicate.isNotNullish(options.configuration) &&
  options.configuration.spreadsheetId !== options.spreadsheetId
    ? Effect.fail(
        options.makeError(
          new Error("The configured spreadsheet does not match the requested sheet"),
        ),
      )
    : Effect.succeed(options.configuration);

export const readConfiguredEventStart = <E extends { readonly cause: unknown }>(options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly configuration: Configuration | null | undefined;
  readonly makeError: (cause: unknown) => E;
}): Effect.Effect<number, E> =>
  validateConfigurationSpreadsheet(options).pipe(
    Effect.flatMap((configuration) =>
      Predicate.isNullish(configuration)
        ? readEventStart(options)
        : Effect.succeed(configuration.event.startTimeEpochMs),
    ),
  );

/**
 * Reads the configuration rows through either the legacy sheet grammar or the canonical web
 * configuration adapter, keeping the row ordering explicit at each provider call site.
 */
export const loadConfigurationValueRanges = <E extends { readonly cause: unknown }>(options: {
  readonly client: sheets_v4.Sheets;
  readonly spreadsheetId: string;
  readonly configuration: Configuration | null | undefined;
  readonly legacyRanges: ReadonlyArray<string>;
  readonly selectConfiguredRows: (
    adapter: WebConfigurationSheetAdapter,
  ) => ReadonlyArray<ValueRows>;
  readonly makeError: (cause: unknown) => E;
}): Effect.Effect<ReadonlyArray<typeof ValueRange.Type>, E> =>
  validateConfigurationSpreadsheet(options).pipe(
    Effect.flatMap((configuration) =>
      Predicate.isNullish(configuration)
        ? readSheetsValueRanges({
            client: options.client,
            spreadsheetId: options.spreadsheetId,
            ranges: options.legacyRanges,
            makeError: options.makeError,
          })
        : loadWebConfigurationSheetAdapter({
            client: options.client,
            spreadsheetId: options.spreadsheetId,
            configuration,
            makeError: options.makeError,
          }).pipe(
            Effect.flatMap((adapter) => {
              const configuredRows = options.selectConfiguredRows(adapter);
              if (configuredRows.length !== options.legacyRanges.length) {
                return Effect.fail(
                  options.makeError(
                    new Error("The configured Sheet Configuration row layout is incomplete"),
                  ),
                );
              }
              return Effect.succeed(configuredRows.map((values) => ({ values })));
            }),
          ),
    ),
  );
