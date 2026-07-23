import {
  EventConfig,
  HourRange,
  RangesConfig,
  RunnerConfig,
  ScheduleConfig,
  SheetConfigError,
  TeamConfig,
  TeamTagsConstantsConfig,
  TeamTagsRangesConfig,
  TeamIsvCombinedConfig,
  TeamIsvSplitConfig,
} from "sheet-ingress-api/schemas/sheetConfig";
import { type sheets_v4 } from "@googleapis/sheets";
import {
  Array,
  Effect,
  Option,
  pipe,
  Schema,
  SchemaGetter,
  SchemaIssue,
  Context,
  String,
  Layer,
  Metric,
  Record,
  Result,
} from "effect";
import { DefaultTaggedClass, OptionArrayToOptionStructValueSchema } from "typhoon-core/schema";
import { ScopedCache } from "typhoon-core/utils";
import { GoogleSheets } from "./google/sheets";

const configSheet = "Thee's Sheet Settings";

interface ConfigRangeCoordinates {
  readonly spreadsheetId: string;
  readonly range: string;
  readonly startRow: number;
}

interface ConfigRowFailure {
  readonly reason: "hour_range" | "schema_validation";
  readonly details: string;
}

export const sheetConfigRejectedRows = Metric.counter("sheet_config_rejected_rows_total", {
  description: "Number of rejected Google Sheets configuration rows",
  incremental: true,
});

const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

const schemaFailure = (issue: SchemaIssue.Issue): ConfigRowFailure => ({
  reason: "schema_validation",
  details: formatSchemaIssue(issue),
});

const mapRowSchemaFailures = <A>(rows: ReadonlyArray<Result.Result<A, SchemaIssue.Issue>>) =>
  Array.map(rows, Result.mapError(schemaFailure));

const validateConfigRows = <A>(
  rows: ReadonlyArray<Result.Result<A, ConfigRowFailure>>,
  coordinates: ConfigRangeCoordinates,
) =>
  Effect.gen(function* () {
    const [failures, successes] = Array.separate(
      Array.map(rows, (result, index) =>
        pipe(
          result,
          Result.mapError((failure) => ({
            row: coordinates.startRow + index,
            failure,
          })),
        ),
      ),
    );

    if (failures.length > 0) {
      yield* Effect.forEach(
        failures,
        ({ failure }) =>
          Metric.update(
            Metric.withAttributes(sheetConfigRejectedRows, {
              sheet: configSheet,
              range: coordinates.range,
              reason: failure.reason,
            }),
            1,
          ),
        { discard: true },
      );

      return yield* Effect.fail(
        new SheetConfigError({
          message: [
            `Invalid sheet configuration in spreadsheet "${coordinates.spreadsheetId}"`,
            ...failures.map(
              ({ failure, row }) =>
                `sheet="${configSheet}" range="${coordinates.range}" row=${row}: ${failure.details}`,
            ),
          ].join("\n"),
        }),
      );
    }

    return successes;
  });

const scheduleConfigParser = (
  [range = {}]: sheets_v4.Schema$ValueRange[],
  coordinates: ConfigRangeCoordinates,
) =>
  GoogleSheets.parseValueRanges(
    [range],
    Schema.Tuple([
      OptionArrayToOptionStructValueSchema(
        [
          "channel",
          "day",
          "sheet",
          "hourRange",
          "breakRange",
          "monitorRange",
          "encType",
          "fillRange",
          "overfillRange",
          "standbyRange",
          "screenshotRange",
          "noteRange",
          "visibleCell",
          "draft",
        ],
        Schema.String,
      ).pipe(
        Schema.decodeTo(
          Schema.Struct({
            channel: GoogleSheets.cellToStringSchema,
            day: GoogleSheets.cellToNumberSchema,
            sheet: GoogleSheets.cellToStringSchema,
            hourRange: GoogleSheets.cellToStringSchema,
            breakRange: GoogleSheets.cellToStringSchema,
            monitorRange: GoogleSheets.cellToStringSchema,
            encType: GoogleSheets.cellToLiteralSchema(["none", "regex", "bold", "underline"]),
            fillRange: GoogleSheets.cellToStringSchema,
            overfillRange: GoogleSheets.cellToStringSchema,
            standbyRange: GoogleSheets.cellToStringSchema,
            screenshotRange: GoogleSheets.cellToStringSchema,
            noteRange: GoogleSheets.cellToStringSchema,
            visibleCell: GoogleSheets.cellToStringSchema,
            draft: GoogleSheets.cellToStringSchema,
          }),
        ),
      ),
    ]),
  ).pipe(
    Effect.map(mapRowSchemaFailures),
    Effect.map(Array.map(Result.map(([config]) => new ScheduleConfig(config)))),
    Effect.flatMap((rows) => validateConfigRows(rows, coordinates)),
    Effect.withSpan("scheduleConfigParser"),
  );

const parseTeamIsvConfig = (
  isvType: Option.Option<"split" | "combined">,
  isvRanges: Option.Option<string>,
) =>
  Option.match(isvType, {
    onNone: () => Option.none<TeamIsvSplitConfig | TeamIsvCombinedConfig>(),
    onSome: (type) => {
      if (type === "split") {
        return pipe(
          isvRanges,
          Option.flatMap((value) => {
            const [leadRange, backlineRange, talentRange] = value
              .split(",")
              .map((item) => item.trim());

            return leadRange && backlineRange && talentRange
              ? Option.some(
                  new TeamIsvSplitConfig({
                    leadRange,
                    backlineRange,
                    talentRange,
                  }),
                )
              : Option.none<TeamIsvSplitConfig>();
          }),
        );
      }

      return pipe(
        isvRanges,
        Option.map((value) => new TeamIsvCombinedConfig({ isvRange: value })),
      );
    },
  });

const parseTeamTagsConfig = (
  tagsType: Option.Option<"constants" | "ranges">,
  tags: Option.Option<string>,
) =>
  Option.match(tagsType, {
    onNone: () => Option.none<TeamTagsConstantsConfig | TeamTagsRangesConfig>(),
    onSome: (type) => {
      if (type === "constants") {
        return Option.some(
          new TeamTagsConstantsConfig({
            tags: pipe(
              tags,
              Option.getOrElse(() => ""),
              String.split(","),
              Array.map(String.trim),
              Array.filter(String.isNonEmpty),
            ),
          }),
        );
      }

      return pipe(
        tags,
        Option.map((value) => new TeamTagsRangesConfig({ tagsRange: value })),
      );
    },
  });

const teamConfigParser = (
  [range = {}]: sheets_v4.Schema$ValueRange[],
  coordinates: ConfigRangeCoordinates,
) =>
  GoogleSheets.parseValueRanges(
    [range],
    Schema.Tuple([
      OptionArrayToOptionStructValueSchema(
        [
          "name",
          "sheet",
          "playerNameRange",
          "teamNameRange",
          "isvType",
          "isvRanges",
          "tagsType",
          "tags",
          "oshiRange",
        ],
        Schema.String,
      ).pipe(
        Schema.decodeTo(
          Schema.Struct({
            name: GoogleSheets.cellToStringSchema,
            sheet: GoogleSheets.cellToStringSchema,
            playerNameRange: GoogleSheets.cellToStringSchema,
            teamNameRange: GoogleSheets.cellToStringSchema,
            isvType: GoogleSheets.cellToLiteralSchema(["split", "combined"]),
            isvRanges: GoogleSheets.cellToStringSchema,
            tagsType: GoogleSheets.cellToLiteralSchema(["constants", "ranges"]),
            tags: GoogleSheets.cellToStringSchema,
            oshiRange: GoogleSheets.cellToStringSchema,
          }),
        ),
      ),
    ]),
  ).pipe(
    Effect.map(mapRowSchemaFailures),
    Effect.map(
      Array.map(
        Result.map(
          ([
            {
              name,
              sheet,
              playerNameRange,
              teamNameRange,
              isvType,
              isvRanges,
              tagsType,
              tags,
              oshiRange,
            },
          ]) =>
            new TeamConfig({
              name,
              sheet,
              playerNameRange,
              teamNameRange,
              isvConfig: parseTeamIsvConfig(isvType, isvRanges),
              tagsConfig: parseTeamTagsConfig(tagsType, tags),
              oshiRange,
            }),
        ),
      ),
    ),
    Effect.flatMap((rows) => validateConfigRows(rows, coordinates)),
    Effect.withSpan("teamConfigParser"),
  );

const hourRangeValueSchema = Schema.Struct({
  start: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  end: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}).check(
  Schema.makeFilter(({ end, start }) =>
    start <= end
      ? undefined
      : { path: ["end"], issue: "end must be greater than or equal to start" },
  ),
);

export const hourRangeSchema = Schema.Trim.check(
  Schema.isPattern(/^\d+\s*-\s*\d+$/u, {
    message: "expected hour range grammar start-end",
  }),
).pipe(
  Schema.decodeTo(hourRangeValueSchema, {
    decode: SchemaGetter.transform((range) => {
      const [start = "", end = ""] = range.split("-").map((item) => item.trim());
      return {
        start: Number.parseInt(start, 10),
        end: Number.parseInt(end, 10),
      };
    }),
    encode: SchemaGetter.transform(({ end, start }) => `${start}-${end}`),
  }),
);

const decodeHourRange = Schema.decodeUnknownResult(hourRangeSchema);

export const hourRangeParser = (range: string): HourRange =>
  Result.match(decodeHourRange(range), {
    onSuccess: (value) => new HourRange(value),
    onFailure: (issue) => {
      throw new RangeError(`Invalid hour range: ${range}\n${formatSchemaIssue(issue)}`);
    },
  });

const runnerConfigParser = (
  [range = {}]: sheets_v4.Schema$ValueRange[],
  coordinates: ConfigRangeCoordinates,
) =>
  GoogleSheets.parseValueRanges(
    [range],
    Schema.Tuple([
      OptionArrayToOptionStructValueSchema(["name", "hours"], Schema.String).pipe(
        Schema.decodeTo(
          Schema.Struct({
            name: GoogleSheets.cellToStringSchema,
            hours: GoogleSheets.cellToStringArraySchema,
          }),
        ),
      ),
    ]),
  ).pipe(
    Effect.map(mapRowSchemaFailures),
    Effect.map(
      Array.map(
        Result.flatMap(([{ name, hours }]) => {
          const decodedHours = pipe(
            hours,
            Option.getOrElse(() => []),
            Array.map((hour, index) =>
              pipe(
                decodeHourRange(hour),
                Result.map((value) => new HourRange(value)),
                Result.mapError(
                  (issue): ConfigRowFailure => ({
                    reason: "hour_range",
                    details: `field=hours[${index}]: ${formatSchemaIssue(issue)}`,
                  }),
                ),
              ),
            ),
          );
          const [failures, decodedHourRanges] = Array.separate(decodedHours);

          return failures.length > 0
            ? Result.fail<ConfigRowFailure>({
                reason: "hour_range",
                details: failures.map(({ details }) => details).join("\n"),
              })
            : Result.succeed(
                new RunnerConfig({
                  name,
                  hours: decodedHourRanges,
                }),
              );
        }),
      ),
    ),
    Effect.flatMap((rows) => validateConfigRows(rows, coordinates)),
    Effect.withSpan("runnerConfigParser"),
  );

const keyValueRangeSchema = Schema.Array(
  Schema.Union([
    Schema.Tuple([]),
    Schema.Tuple([Schema.String]),
    Schema.Tuple([Schema.String, Schema.Unknown]),
  ]),
);

const decodeKeyValueRange = (range: unknown) =>
  Schema.decodeUnknownEffect(keyValueRangeSchema)(range).pipe(
    Effect.map(
      Array.filterMap(([key, value]) =>
        Option.fromNullishOr(key).pipe(
          Option.match({
            onNone: () => Result.failVoid,
            onSome: (presentKey) => Result.succeed([presentKey, value ?? null] as const),
          }),
        ),
      ),
    ),
  );

let serviceInstanceCount = 0;

export class SheetConfigService extends Context.Service<SheetConfigService>()(
  "SheetConfigService",
  {
    make: Effect.gen(function* () {
      const instanceId = ++serviceInstanceCount;
      console.log(`[SheetConfigService] Creating instance #${instanceId}`);

      const googleSheets = yield* GoogleSheets;

      const getRangesConfig = Effect.fn("SheetConfigService.getRangesConfig")(function* (
        sheetId: string,
      ) {
        const response = yield* googleSheets.get({
          spreadsheetId: sheetId,
          ranges: ["'Thee's Sheet Settings'!B8:C"],
        });

        const range = yield* Option.fromNullishOr(response.data.valueRanges).pipe(
          Option.flatMap(Array.get(0)),
          Option.flatMapNullishOr((range) => range.values),
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new SheetConfigError({
                  message: "Error getting ranges config, no value ranges found",
                }),
              ),
          }),
        );
        const rangeStruct = Record.fromEntries(yield* decodeKeyValueRange(range));

        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            userIds: Schema.String,
            userSheetNames: Schema.String,
            userNotes: Schema.NullishOr(Schema.String),
            monitorIds: Schema.NullishOr(Schema.String),
            monitorNames: Schema.NullishOr(Schema.String),
            oshis: Schema.NullishOr(Schema.String),
          }).pipe(
            Schema.encodeKeys({
              userIds: "User IDs",
              userSheetNames: "User Sheet Names",
              userNotes: "User Notes",
              monitorIds: "Moni IDs",
              monitorNames: "Moni Names",
              oshis: "Oshis",
            }),
            Schema.decodeTo(DefaultTaggedClass(RangesConfig)),
          ),
        )(rangeStruct);
      });

      const getTeamConfig = Effect.fn("SheetConfigService.getTeamConfig")(function* (
        sheetId: string,
      ) {
        const response = yield* googleSheets.get({
          spreadsheetId: sheetId,
          ranges: ["'Thee's Sheet Settings'!E8:M"],
        });
        const ranges = yield* Option.fromNullishOr(response.data.valueRanges).pipe(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new SheetConfigError({
                  message: "Error getting team config, no value ranges found",
                }),
              ),
          }),
        );

        return yield* teamConfigParser(ranges, {
          spreadsheetId: sheetId,
          range: "E8:M",
          startRow: 8,
        });
      });

      const getEventConfig = Effect.fn("SheetConfigService.getEventConfig")(function* (
        sheetId: string,
      ) {
        const response = yield* googleSheets.get({
          spreadsheetId: sheetId,
          ranges: ["'Thee's Sheet Settings'!O8:P"],
        });

        const range = yield* Option.fromNullishOr(response.data.valueRanges).pipe(
          Option.flatMap(Array.get(0)),
          Option.flatMapNullishOr((range) => range.values),
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new SheetConfigError({
                  message: "Error getting event config, no value ranges found",
                }),
              ),
          }),
        );
        const rangeStruct = Record.fromEntries(yield* decodeKeyValueRange(range));

        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            startTime: Schema.NumberFromString.pipe(
              Schema.decodeTo(Schema.Number, {
                decode: SchemaGetter.transform((value) => value * 1000),
                encode: SchemaGetter.transform((value) => value / 1000),
              }),
            ),
          }).pipe(
            Schema.encodeKeys({
              startTime: "Start Time",
            }),
            Schema.decodeTo(DefaultTaggedClass(EventConfig)),
          ),
        )(rangeStruct);
      });

      const getScheduleConfig = Effect.fn("SheetConfigService.getScheduleConfig")(function* (
        sheetId: string,
      ) {
        const response = yield* googleSheets.get({
          spreadsheetId: sheetId,
          ranges: ["'Thee's Sheet Settings'!R8:AE"],
        });
        const ranges = yield* Option.fromNullishOr(response.data.valueRanges).pipe(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new SheetConfigError({
                  message: "Error getting schedule config, no value ranges found",
                }),
              ),
          }),
        );

        return yield* scheduleConfigParser(ranges, {
          spreadsheetId: sheetId,
          range: "R8:AE",
          startRow: 8,
        });
      });

      const getRunnerConfig = Effect.fn("SheetConfigService.getRunnerConfig")(function* (
        sheetId: string,
      ) {
        const response = yield* googleSheets.get({
          spreadsheetId: sheetId,
          ranges: ["'Thee's Sheet Settings'!AG8:AH"],
        });
        const ranges = yield* Option.fromNullishOr(response.data.valueRanges).pipe(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new SheetConfigError({
                  message: "Error getting runner config, no value ranges found",
                }),
              ),
          }),
        );

        return yield* runnerConfigParser(ranges, {
          spreadsheetId: sheetId,
          range: "AG8:AH",
          startRow: 8,
        });
      });

      console.log(`[SheetConfigService #${instanceId}] Creating caches...`);
      const {
        getRangesConfigCache,
        getTeamConfigCache,
        getEventConfigCache,
        getScheduleConfigCache,
        getRunnerConfigCache,
      } = yield* Effect.all({
        getRangesConfigCache: ScopedCache.make({ lookup: getRangesConfig }),
        getTeamConfigCache: ScopedCache.make({ lookup: getTeamConfig }),
        getEventConfigCache: ScopedCache.make({ lookup: getEventConfig }),
        getScheduleConfigCache: ScopedCache.make({ lookup: getScheduleConfig }),
        getRunnerConfigCache: ScopedCache.make({ lookup: getRunnerConfig }),
      });
      console.log(`[SheetConfigService #${instanceId}] Caches created`);

      return {
        getRangesConfig: (sheetId: string) => getRangesConfigCache.get(sheetId),
        getTeamConfig: (sheetId: string) => getTeamConfigCache.get(sheetId),
        getEventConfig: (sheetId: string) => getEventConfigCache.get(sheetId),
        getScheduleConfig: (sheetId: string) => getScheduleConfigCache.get(sheetId),
        getRunnerConfig: (sheetId: string) => getRunnerConfigCache.get(sheetId),
      };
    }),
  },
) {
  static layer = Layer.effect(SheetConfigService, this.make);
}
