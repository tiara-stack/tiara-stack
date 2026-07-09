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
  Context,
  String,
  Layer,
  Record,
} from "effect";
import { DefaultTaggedClass, OptionArrayToOptionStructValueSchema } from "typhoon-core/schema";
import { ScopedCache } from "typhoon-core/utils";
import { GoogleSheets } from "./google/sheets";

const scheduleConfigParser = ([range]: sheets_v4.Schema$ValueRange[]) =>
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
            encType: GoogleSheets.cellToLiteralSchema(["none", "regex", "bold"]),
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
    Effect.map(Array.getSuccesses),
    Effect.map(Array.map(([config]) => new ScheduleConfig(config))),
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

const teamConfigParser = ([range]: sheets_v4.Schema$ValueRange[]) =>
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
    Effect.map(Array.getSuccesses),
    Effect.map(
      Array.map(
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
    Effect.withSpan("teamConfigParser"),
  );

const hourRangeParser = (range: string): HourRange => {
  const [start, end] = range.split("-").map((item) => item.trim());
  return new HourRange({
    start: Number.parseInt(start, 10),
    end: Number.parseInt(end, 10),
  });
};

const runnerConfigParser = ([range]: sheets_v4.Schema$ValueRange[]) =>
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
    Effect.map(Array.getSuccesses),
    Effect.map(
      Array.map(
        ([{ name, hours }]) =>
          new RunnerConfig({
            name,
            hours: pipe(
              hours,
              Option.getOrElse(() => []),
              Array.map(hourRangeParser),
            ),
          }),
      ),
    ),
    Effect.withSpan("runnerConfigParser"),
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
        const rangeStruct = Record.fromEntries(range as [string, any][]);

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

        return yield* teamConfigParser(ranges);
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
        const rangeStruct = Record.fromEntries(range as [string, any][]);

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

        return yield* scheduleConfigParser(ranges);
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

        return yield* runnerConfigParser(ranges);
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
  static layer = Layer.effect(SheetConfigService, this.make).pipe(
    Layer.provide(GoogleSheets.layer),
  );
}
