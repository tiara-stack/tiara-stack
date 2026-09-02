import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Predicate, Schedule, Schema } from "effect";
import {
  cellText,
  isRetryableRunnerLocalSheetsReadFailure,
  makeRunnerLocalSheetsClient,
  parseLegacyNumber,
  readSheetsValueRanges,
  scheduleConfigRange,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import { ScreenshotRenderTargetSchema, type ScreenshotRenderTarget } from "./schema";
import type { WebSheetConfiguration } from "sheet-domain";
import {
  loadWebConfigurationSheetAdapter,
  validateConfigurationSpreadsheet,
  type WebConfigurationSheetTab,
} from "../shared/webConfigurationSheets";

const SpreadsheetId = Schema.Trimmed.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[A-Za-z0-9_-]+$/u));
const SheetTitle = Schema.Trimmed.check(Schema.isNonEmpty()).check(Schema.isMaxLength(256));
const ScreenshotRange = Schema.Trimmed.check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(256))
  .check(Schema.isPattern(/^[^#?&\p{Cc}]+$/u));
const SheetGid = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const SpreadsheetMetadata = Schema.Struct({
  sheets: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          properties: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                title: Schema.optional(Schema.NullOr(Schema.String)),
                sheetId: Schema.optional(Schema.NullOr(Schema.Number)),
              }),
            ),
          ),
        }),
      ),
    ),
  ),
});

export const ScreenshotSourceResolutionCode = Schema.Literals([
  "MissingSchedule",
  "MissingSheet",
  "MissingScreenshotRange",
  "MissingSheetGid",
  "InvalidSpreadsheetId",
  "InvalidSheet",
  "InvalidScreenshotRange",
  "InvalidSheetGid",
  "InvalidMetadata",
  "InvalidRenderTarget",
]);

class ScreenshotSourceResolutionError extends Data.TaggedError("ScreenshotSourceResolutionError")<{
  readonly code: typeof ScreenshotSourceResolutionCode.Type;
}> {}

export class ScreenshotSourceProviderError extends Data.TaggedError(
  "ScreenshotSourceProviderError",
)<{
  readonly operation: "create-client" | "read-metadata" | "read-schedule";
  readonly cause: unknown;
}> {}

interface ScreenshotSourceProviderShape {
  readonly resolve: (
    spreadsheetId: string,
    conversationName: string,
    day: number,
    configuration?: WebSheetConfiguration | null,
  ) => Effect.Effect<
    ScreenshotRenderTarget,
    ScreenshotSourceProviderError | ScreenshotSourceResolutionError
  >;
}

export class ScreenshotSourceProvider extends Context.Service<
  ScreenshotSourceProvider,
  ScreenshotSourceProviderShape
>()("sheet-workflows/ScreenshotSourceProvider") {}

const providerError =
  (operation: ScreenshotSourceProviderError["operation"]) =>
  (cause: unknown): ScreenshotSourceProviderError =>
    new ScreenshotSourceProviderError({ operation, cause });

const resolutionError = (code: typeof ScreenshotSourceResolutionCode.Type) =>
  new ScreenshotSourceResolutionError({ code });

const metadataRetrySchedule = Schedule.exponential("100 millis").pipe(Schedule.jittered);

const readMetadata = (client: sheets_v4.Sheets, spreadsheetId: string) =>
  Effect.tryPromise({
    try: () =>
      client.spreadsheets.get({
        spreadsheetId,
        fields: "sheets.properties(sheetId,title)",
      }),
    catch: providerError("read-metadata"),
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.mapError((error) =>
      Predicate.isTagged("ScreenshotSourceProviderError")(error)
        ? error
        : providerError("read-metadata")(error),
    ),
    Effect.retry({
      schedule: metadataRetrySchedule,
      times: 2,
      while: isRetryableRunnerLocalSheetsReadFailure,
    }),
    Effect.flatMap(({ data }) =>
      Schema.decodeUnknownEffect(SpreadsheetMetadata)(data).pipe(
        Effect.mapError(() => resolutionError("InvalidMetadata")),
      ),
    ),
  );

interface SelectedSchedule {
  readonly sheet: string | undefined;
  readonly screenshotRange: string | undefined;
}

const legacyScheduleColumns = {
  channel: 0,
  day: 1,
  sheet: 2,
  screenshotRange: 10,
} as const;

export const selectLegacyScreenshotSchedule = (
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  conversationName: string,
  day: number,
): SelectedSchedule | undefined => {
  for (const row of rows) {
    const channel = cellText(row[legacyScheduleColumns.channel]);
    const parsedDay = parseLegacyNumber(cellText(row[legacyScheduleColumns.day]));
    const screenshotRange = cellText(row[legacyScheduleColumns.screenshotRange]);
    if (channel === conversationName && parsedDay === day) {
      return { sheet: cellText(row[legacyScheduleColumns.sheet]), screenshotRange };
    }
  }
  return undefined;
};

const gidForSheet = (
  tabs: ReadonlyArray<WebConfigurationSheetTab>,
  sheetTitle: string,
): number | "ambiguous" | undefined => {
  const matches = tabs.filter(({ title }) => title === sheetTitle);
  return matches.length > 1 ? "ambiguous" : (matches[0]?.sheetId ?? undefined);
};

const tabsFromMetadata = (
  metadata: typeof SpreadsheetMetadata.Type,
): ReadonlyArray<WebConfigurationSheetTab> =>
  (metadata.sheets ?? []).flatMap(({ properties }) => {
    const sheetId = properties?.sheetId;
    const title = properties?.title;
    return Predicate.isNumber(sheetId) && Predicate.isString(title) ? [{ sheetId, title }] : [];
  });

export const makeGoogleEmbeddedTableUrl = (
  spreadsheetId: string,
  gid: number,
  range: string,
): string => {
  const url = new URL(
    `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/htmlembed`,
  );
  url.searchParams.set("single", "true");
  url.searchParams.set("gid", String(gid));
  url.searchParams.set("range", range);
  url.searchParams.set("widget", "false");
  url.searchParams.set("chrome", "false");
  url.searchParams.set("headers", "false");
  return url.toString();
};

export const makeScreenshotSourceProvider = (
  client: sheets_v4.Sheets,
): ScreenshotSourceProviderShape => ({
  resolve: (rawSpreadsheetId, conversationName, day, configuration) =>
    Effect.gen(function* () {
      const spreadsheetId = yield* Schema.decodeUnknownEffect(SpreadsheetId)(rawSpreadsheetId).pipe(
        Effect.mapError(() => resolutionError("InvalidSpreadsheetId")),
      );
      const validatedConfiguration = yield* validateConfigurationSpreadsheet({
        spreadsheetId,
        configuration,
        makeError: providerError("read-schedule"),
      });
      const { tabs, scheduleRows } = Predicate.isNullish(validatedConfiguration)
        ? yield* Effect.all(
            {
              tabs: readMetadata(client, spreadsheetId).pipe(Effect.map(tabsFromMetadata)),
              scheduleRows: readSheetsValueRanges({
                client,
                spreadsheetId,
                ranges: [scheduleConfigRange],
                makeError: providerError("read-schedule"),
              }).pipe(Effect.map((ranges) => valueRowsAt(ranges, 0))),
            },
            { concurrency: "unbounded" },
          )
        : yield* loadWebConfigurationSheetAdapter({
            client,
            spreadsheetId,
            configuration: validatedConfiguration,
            makeError: providerError("read-schedule"),
          }).pipe(
            Effect.map(({ schedulesRows, tabs }) => ({
              tabs,
              scheduleRows: schedulesRows,
            })),
          );
      const selected = selectLegacyScreenshotSchedule(scheduleRows, conversationName, day);
      if (Predicate.isUndefined(selected)) {
        return yield* resolutionError("MissingSchedule");
      }
      const sheet = yield* Schema.decodeUnknownEffect(SheetTitle)(selected.sheet).pipe(
        Effect.mapError(() =>
          Predicate.isUndefined(selected.sheet)
            ? resolutionError("MissingSheet")
            : resolutionError("InvalidSheet"),
        ),
      );
      const range = yield* Schema.decodeUnknownEffect(ScreenshotRange)(
        selected.screenshotRange,
      ).pipe(
        Effect.mapError(() =>
          Predicate.isUndefined(selected.screenshotRange)
            ? resolutionError("MissingScreenshotRange")
            : resolutionError("InvalidScreenshotRange"),
        ),
      );
      const rawGid = gidForSheet(tabs, sheet);
      if (rawGid === "ambiguous") {
        return yield* resolutionError("InvalidMetadata");
      }
      const gid = yield* Schema.decodeUnknownEffect(SheetGid)(rawGid).pipe(
        Effect.mapError(() =>
          Predicate.isUndefined(rawGid)
            ? resolutionError("MissingSheetGid")
            : resolutionError("InvalidSheetGid"),
        ),
      );
      const url = makeGoogleEmbeddedTableUrl(spreadsheetId, gid, range);
      return yield* Schema.decodeUnknownEffect(ScreenshotRenderTargetSchema)({ url }).pipe(
        Effect.mapError(() => resolutionError("InvalidRenderTarget")),
      );
    }),
});

export const screenshotSourceProviderLayer = Layer.effect(
  ScreenshotSourceProvider,
  makeRunnerLocalSheetsClient(providerError("create-client")).pipe(
    Effect.map(makeScreenshotSourceProvider),
  ),
);
