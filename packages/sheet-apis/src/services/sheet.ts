import { ParserFieldError } from "sheet-ingress-api/schemas/sheet/error";
import {
  HourRange,
  RunnerConfig,
  ScheduleConfig,
  TeamConfig,
  TeamIsvSplitConfig,
  TeamIsvCombinedConfig,
  TeamTagsRangesConfig,
} from "sheet-ingress-api/schemas/sheetConfig";
import {
  RawPlayer,
  RawMonitor,
  RawSchedulePlayer,
  Team,
  makeSchedule,
  BreakSchedule,
  Schedule,
} from "sheet-ingress-api/schemas/sheet";
import { regex } from "arkregex";
import { type sheets_v4 } from "@googleapis/sheets";
import {
  Array,
  Data,
  Effect,
  HashMap,
  Layer,
  Match,
  Number,
  Option,
  pipe,
  Schema,
  Context,
  String,
} from "effect";
import { upperFirst } from "scule";
import { TupleToStructValueSchema } from "typhoon-core/schema";
import { Array as ArrayUtils, ScopedCache, Struct as StructUtils } from "typhoon-core/utils";

import { GoogleSheets, toCellOption } from "./google/sheets";
import { SheetConfigService } from "./sheetConfig";

class ConfigField<Range> extends Data.TaggedClass("ConfigField")<{
  range: Range;
  field: string;
}> {}

const makeParserFieldError = <Range>(configField: ConfigField<Range>) =>
  new ParserFieldError({
    message: `Error getting ${configField.field}, no config field found`,
    range: configField.range,
    field: configField.field,
  });

const getConfigFieldValueRange =
  <Range>(configField: ConfigField<Range>) =>
  (sheet: HashMap.HashMap<ConfigField<Range>, sheets_v4.Schema$ValueRange>) =>
    pipe(
      sheet,
      HashMap.get(configField),
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(makeParserFieldError(configField)),
      }),
      (e) => Effect.suspend(() => e),
      Effect.withSpan("getConfigFieldValueRange"),
    );

const getConfigFieldRowData =
  <Range>(configField: ConfigField<Range>) =>
  (sheet: HashMap.HashMap<ConfigField<Range>, sheets_v4.Schema$RowData[]>) =>
    pipe(
      sheet,
      HashMap.get(configField),
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(makeParserFieldError(configField)),
      }),
      (e) => Effect.suspend(() => e),
      Effect.withSpan("getConfigFieldRowData"),
    );

const playerParser = ([userIds, userSheetNames]: sheets_v4.Schema$ValueRange[]) =>
  pipe(
    GoogleSheets.parseValueRanges(
      [userIds, userSheetNames],
      pipe(
        TupleToStructValueSchema(["id", "name"] as const, GoogleSheets.rowToCellSchema),
        Schema.decodeTo(
          Schema.Struct({
            id: GoogleSheets.cellToStringSchema,
            name: GoogleSheets.cellToStringSchema,
          }),
        ),
      ),
    ),
    Effect.map(Array.getSuccesses),
    Effect.map(
      Array.map(
        (config, index) =>
          new RawPlayer({
            index,
            id: config.id,
            name: pipe(
              config.name,
              Option.map((name) => upperFirst(name)),
            ),
          }),
      ),
    ),
    Effect.withSpan("playerParser"),
  );

const monitorParser = ([monitorIds, monitorNames]: sheets_v4.Schema$ValueRange[]) =>
  pipe(
    GoogleSheets.parseValueRanges(
      [monitorIds, monitorNames],
      pipe(
        TupleToStructValueSchema(["id", "name"] as const, GoogleSheets.rowToCellSchema),
        Schema.decodeTo(
          Schema.Struct({
            id: GoogleSheets.cellToStringSchema,
            name: GoogleSheets.cellToStringSchema,
          }),
        ),
      ),
    ),
    Effect.map(Array.getSuccesses),
    Effect.map(
      Array.map(
        (config, index) =>
          new RawMonitor({
            index,
            id: config.id,
            name: pipe(
              config.name,
              Option.map((name) => upperFirst(name)),
            ),
          }),
      ),
    ),
    Effect.withSpan("monitorParser"),
  );

class TeamConfigRange extends Data.TaggedClass("TeamConfigRange")<{
  name: string;
}> {}
class TeamConfigField extends ConfigField<TeamConfigRange> {}

const teamConfigFields = [
  "name",
  "sheet",
  "playerNameRange",
  "teamNameRange",
  "isvConfig",
  "tagsConfig",
] as const;

type FilteredTeamConfigValue = Option.Option.Value<
  StructUtils.GetSomeFields.GetSomeFields<TeamConfig, (typeof teamConfigFields)[number]>
>;
const filterTeamConfigValues = (teamConfigValues: TeamConfig[]) =>
  pipe(
    teamConfigValues,
    Array.map(StructUtils.GetSomeFields.getSomeFields(teamConfigFields)),
    Array.getSomes,
  );

const makeTeamConfigField = (teamConfigValue: FilteredTeamConfigValue, field: string) =>
  new TeamConfigField({
    range: new TeamConfigRange({ name: teamConfigValue.name }),
    field,
  });

const teamBaseRange = (teamConfigValue: FilteredTeamConfigValue) =>
  ({
    playerName: {
      field: makeTeamConfigField(teamConfigValue, "playerName"),
      range: Option.some(`'${teamConfigValue.sheet}'!${teamConfigValue.playerNameRange}`),
    },
    teamName: {
      field: makeTeamConfigField(teamConfigValue, "teamName"),
      range: pipe(
        Match.value(teamConfigValue.teamNameRange),
        Match.when("auto", () => Option.none()),
        Match.orElse(() =>
          Option.some(`'${teamConfigValue.sheet}'!${teamConfigValue.teamNameRange}`),
        ),
      ),
    },
  }) as const;

const playerNameRegex = regex("^(?<name>.*?)\\s+(?<enc>\\(e(?:nc)?\\))?$");
type RowDataCell = Schema.Schema.Type<typeof GoogleSheets.rowDataSchema>[number];

const isRegexEnc = (value: string) => playerNameRegex.exec(value)?.groups?.enc !== undefined;

const isFillEnc = (encType: string, fillCell: RowDataCell, value: string) =>
  Match.value(encType).pipe(
    Match.when("regex", () => isRegexEnc(value)),
    Match.when("bold", () => GoogleSheets.rowDataCellIsBold(fillCell)),
    Match.when("underline", () => GoogleSheets.rowDataCellIsUnderline(fillCell)),
    Match.orElse(() => false),
  );

const teamBaseParser = (
  teamConfigValue: FilteredTeamConfigValue,
  sheet: HashMap.HashMap<TeamConfigField, sheets_v4.Schema$ValueRange>,
) =>
  pipe(
    Effect.Do,
    Effect.let("range", () => teamBaseRange(teamConfigValue)),
    Effect.flatMap(({ range }) =>
      Effect.all(
        [
          pipe(sheet, getConfigFieldValueRange(range.playerName.field)),
          pipe(
            Match.value(teamConfigValue.teamNameRange),
            Match.when("auto", () => Effect.succeed({ values: [] })),
            Match.orElse(() => pipe(sheet, getConfigFieldValueRange(range.teamName.field))),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    ),
    Effect.flatMap((valueRanges) =>
      GoogleSheets.parseValueRanges(
        valueRanges,
        pipe(
          TupleToStructValueSchema(
            ["playerName", "teamName"] as const,
            GoogleSheets.rowToCellSchema,
          ),
          Schema.decodeTo(
            Schema.Struct({
              playerName: GoogleSheets.cellToStringSchema,
              teamName: GoogleSheets.cellToStringSchema,
            }),
          ),
        ),
      ),
    ),
    Effect.map(
      ArrayUtils.WithDefault.wrapEither({
        default: () => ({
          playerName: Option.none<string>(),
          teamName: Option.none<string>(),
        }),
      }),
    ),
    Effect.map(
      ArrayUtils.WithDefault.map(({ playerName, teamName }) => ({
        playerName: pipe(
          playerName,
          Option.map((name) => playerNameRegex.exec(name)?.groups?.name ?? name),
          Option.map((name) => upperFirst(name)),
        ),
        teamName: pipe(
          Match.value(teamConfigValue.teamNameRange),
          Match.when("auto", () =>
            pipe(
              playerName,
              Option.map((name) => `${name} | ${teamConfigValue.name}`),
            ),
          ),
          Match.orElse(() => teamName),
        ),
      })),
    ),
  );

const teamSplitIsvRange = (teamConfigValue: FilteredTeamConfigValue, cfg: TeamIsvSplitConfig) =>
  ({
    lead: {
      field: makeTeamConfigField(teamConfigValue, "lead"),
      range: Option.some(`'${teamConfigValue.sheet}'!${cfg.leadRange}`),
    },
    backline: {
      field: makeTeamConfigField(teamConfigValue, "backline"),
      range: Option.some(`'${teamConfigValue.sheet}'!${cfg.backlineRange}`),
    },
    talent: {
      field: makeTeamConfigField(teamConfigValue, "talent"),
      range: Option.some(`'${teamConfigValue.sheet}'!${cfg.talentRange}`),
    },
  }) as const;

const teamSplitIsvParser = (
  teamConfigValue: FilteredTeamConfigValue,
  cfg: TeamIsvSplitConfig,
  sheet: HashMap.HashMap<TeamConfigField, sheets_v4.Schema$ValueRange>,
) =>
  pipe(
    Effect.Do,
    Effect.let("range", () => teamSplitIsvRange(teamConfigValue, cfg)),
    Effect.flatMap(({ range }) =>
      Effect.all(
        [
          pipe(sheet, getConfigFieldValueRange(range.lead.field)),
          pipe(sheet, getConfigFieldValueRange(range.backline.field)),
          pipe(sheet, getConfigFieldValueRange(range.talent.field)),
        ],
        { concurrency: "unbounded" },
      ),
    ),
    Effect.flatMap((valueRanges) =>
      GoogleSheets.parseValueRanges(
        valueRanges,
        pipe(
          TupleToStructValueSchema(
            ["lead", "backline", "talent"] as const,
            GoogleSheets.rowToCellSchema,
          ),
          Schema.decodeTo(
            Schema.Struct({
              lead: GoogleSheets.cellToNumberSchema,
              backline: GoogleSheets.cellToNumberSchema,
              talent: GoogleSheets.cellToNumberSchema,
            }),
          ),
        ),
      ),
    ),
    Effect.map(
      ArrayUtils.WithDefault.wrapEither({
        default: () => ({
          lead: Option.none<number>(),
          backline: Option.none<number>(),
          talent: Option.none<number>(),
        }),
      }),
    ),
  );

const teamCombinedIsvRange = (
  teamConfigValue: FilteredTeamConfigValue,
  cfg: TeamIsvCombinedConfig,
) =>
  ({
    isv: {
      field: makeTeamConfigField(teamConfigValue, "isv"),
      range: Option.some(`'${teamConfigValue.sheet}'!${cfg.isvRange}`),
    },
  }) as const;

const teamCombinedIsvParser = (
  teamConfigValue: FilteredTeamConfigValue,
  cfg: TeamIsvCombinedConfig,
  sheet: HashMap.HashMap<TeamConfigField, sheets_v4.Schema$ValueRange>,
) =>
  pipe(
    Effect.Do,
    Effect.let("range", () => teamCombinedIsvRange(teamConfigValue, cfg)),
    Effect.flatMap(({ range }) =>
      Effect.all([pipe(sheet, getConfigFieldValueRange(range.isv.field))], {
        concurrency: "unbounded",
      }),
    ),
    Effect.flatMap((valueRanges) =>
      GoogleSheets.parseValueRanges(
        valueRanges,
        pipe(
          TupleToStructValueSchema(["isv"] as const, GoogleSheets.rowToCellSchema),
          Schema.decodeTo(
            Schema.Struct({
              isv: GoogleSheets.cellToStringSchema,
            }),
          ),
        ),
      ),
    ),
    Effect.map(
      ArrayUtils.WithDefault.wrapEither({
        default: () => ({
          isv: Option.none<string>(),
        }),
      }),
    ),
    Effect.map(
      ArrayUtils.WithDefault.map(({ isv }) =>
        pipe(isv, Option.map(String.split("/")), Option.map(Array.map(String.trim)), (isv) => ({
          lead: pipe(isv, Option.flatMap(Array.get(0))),
          backline: pipe(isv, Option.flatMap(Array.get(1))),
          talent: pipe(isv, Option.flatMap(Array.get(2))),
        })),
      ),
    ),
    Effect.map(ArrayUtils.WithDefault.toArray),
    Effect.flatMap(
      Effect.forEach((isv) =>
        pipe(
          isv,
          Schema.decodeUnknownEffect(
            Schema.Struct({
              lead: GoogleSheets.cellToNumberSchema,
              backline: GoogleSheets.cellToNumberSchema,
              talent: GoogleSheets.cellToNumberSchema,
            }),
          ),
          Effect.option,
        ),
      ),
    ),
    Effect.map(
      ArrayUtils.WithDefault.wrapOption({
        default: () => ({
          lead: Option.none<number>(),
          backline: Option.none<number>(),
          talent: Option.none<number>(),
        }),
      }),
    ),
  );

const teamRangesTagsRange = (teamConfigValue: FilteredTeamConfigValue, cfg: TeamTagsRangesConfig) =>
  ({
    tags: {
      field: makeTeamConfigField(teamConfigValue, "tags"),
      range: Option.some(`'${teamConfigValue.sheet}'!${cfg.tagsRange}`),
    },
  }) as const;

const teamRangesTagsParser = (
  teamConfigValue: FilteredTeamConfigValue,
  cfg: TeamTagsRangesConfig,
  sheet: HashMap.HashMap<TeamConfigField, sheets_v4.Schema$ValueRange>,
) =>
  pipe(
    Effect.Do,
    Effect.let("range", () => teamRangesTagsRange(teamConfigValue, cfg)),
    Effect.flatMap(({ range }) =>
      Effect.all([pipe(sheet, getConfigFieldValueRange(range.tags.field))], {
        concurrency: "unbounded",
      }),
    ),
    Effect.flatMap((valueRanges) =>
      GoogleSheets.parseValueRanges(
        valueRanges,
        pipe(
          TupleToStructValueSchema(["tags"] as const, GoogleSheets.rowToCellSchema),
          Schema.decodeTo(
            Schema.Struct({
              tags: GoogleSheets.cellToStringArraySchema,
            }),
          ),
        ),
      ),
    ),
    Effect.map(
      ArrayUtils.WithDefault.wrapEither({
        default: () => ({
          tags: Option.none<string[]>(),
        }),
      }),
    ),
    Effect.map(
      ArrayUtils.WithDefault.map(({ tags }) => ({
        tags: pipe(
          tags,
          Option.getOrElse(() => []),
        ),
      })),
    ),
  );

const teamRanges = (teamConfigValues: FilteredTeamConfigValue[]) =>
  HashMap.fromIterable(
    teamConfigValues.flatMap((teamConfigValue) => {
      const entries: [TeamConfigField, string][] = [];
      const baseRange = teamBaseRange(teamConfigValue);
      const isvConfig = teamConfigValue.isvConfig;
      const tagsConfig = teamConfigValue.tagsConfig;

      if (Option.isSome(baseRange.playerName.range)) {
        entries.push([baseRange.playerName.field, baseRange.playerName.range.value]);
      }
      if (Option.isSome(baseRange.teamName.range)) {
        entries.push([baseRange.teamName.field, baseRange.teamName.range.value]);
      }

      if (isvConfig._tag === "TeamIsvSplitConfig") {
        const isvRange = teamSplitIsvRange(teamConfigValue, isvConfig);
        if (Option.isSome(isvRange.lead.range)) {
          entries.push([isvRange.lead.field, isvRange.lead.range.value]);
        }
        if (Option.isSome(isvRange.backline.range)) {
          entries.push([isvRange.backline.field, isvRange.backline.range.value]);
        }
        if (Option.isSome(isvRange.talent.range)) {
          entries.push([isvRange.talent.field, isvRange.talent.range.value]);
        }
      } else {
        const isvRange = teamCombinedIsvRange(teamConfigValue, isvConfig);
        if (Option.isSome(isvRange.isv.range)) {
          entries.push([isvRange.isv.field, isvRange.isv.range.value]);
        }
      }

      if (tagsConfig._tag === "TeamTagsRangesConfig") {
        const tagsRange = teamRangesTagsRange(teamConfigValue, tagsConfig);
        if (Option.isSome(tagsRange.tags.range)) {
          entries.push([tagsRange.tags.field, tagsRange.tags.range.value]);
        }
      }

      return entries;
    }),
  );

const teamParser = (
  teamConfigValues: FilteredTeamConfigValue[],
  sheet: HashMap.HashMap<TeamConfigField, sheets_v4.Schema$ValueRange>,
) =>
  pipe(
    teamConfigValues,
    Effect.forEach(
      Effect.fnUntraced(function* (teamConfig) {
        const isvConfig = teamConfig.isvConfig;
        const tagsConfig = teamConfig.tagsConfig;
        const base = yield* teamBaseParser(teamConfig, sheet);
        const isv = yield* Match.value(isvConfig).pipe(
          Match.tagsExhaustive({
            TeamIsvSplitConfig: (isvConfig) => teamSplitIsvParser(teamConfig, isvConfig, sheet),
            TeamIsvCombinedConfig: (isvConfig) =>
              teamCombinedIsvParser(teamConfig, isvConfig, sheet),
          }),
        );
        const tags = yield* Match.value(tagsConfig).pipe(
          Match.tagsExhaustive({
            TeamTagsConstantsConfig: (tagsConfig) =>
              Effect.succeed(
                ArrayUtils.WithDefault.wrap<ReadonlyArray<{ tags: readonly string[] }>>({
                  default: () => ({ tags: tagsConfig.tags }),
                })([]),
              ),
            TeamTagsRangesConfig: (tagsConfig) =>
              teamRangesTagsParser(teamConfig, tagsConfig, sheet),
          }),
        );

        return pipe(
          base,
          ArrayUtils.WithDefault.zip(isv),
          ArrayUtils.WithDefault.zip(tags),
          ArrayUtils.WithDefault.toArray,
          Array.map((config) =>
            Option.all({
              playerName: config.playerName,
              teamName: config.teamName,
              lead: config.lead,
              backline: config.backline,
            }).pipe(
              Option.map(
                ({ playerName, teamName, lead, backline }) =>
                  new Team({
                    type: teamConfig.name,
                    playerId: Option.none(),
                    playerName: Option.some(playerName),
                    teamName: Option.some(teamName),
                    tags: [...config.tags],
                    lead,
                    backline,
                    talent: config.talent,
                  }),
              ),
            ),
          ),
          Array.getSomes,
        );
      }),
    ),
    Effect.map(Array.flatten),
    Effect.withSpan("teamParser"),
  );

class ScheduleConfigRange extends Data.TaggedClass("ScheduleConfigRange")<{
  channel: string;
  day: number;
}> {}
class ScheduleConfigField extends ConfigField<ScheduleConfigRange> {}

const scheduleConfigFields = [
  "channel",
  "day",
  "sheet",
  "hourRange",
  "breakRange",
  "encType",
  "fillRange",
  "overfillRange",
  "standbyRange",
  "visibleCell",
] as const;

type FilteredScheduleConfigValue = Option.Option.Value<
  StructUtils.GetSomeFields.GetSomeFields<ScheduleConfig, (typeof scheduleConfigFields)[number]>
>;
const filterScheduleConfigValues = (scheduleConfigValues: ScheduleConfig[]) =>
  pipe(
    scheduleConfigValues,
    Array.map(StructUtils.GetSomeFields.getSomeFields(scheduleConfigFields)),
    Array.getSomes,
  );

const makeScheduleConfigField = (scheduleConfigValue: FilteredScheduleConfigValue, field: string) =>
  new ScheduleConfigField({
    range: new ScheduleConfigRange({
      channel: scheduleConfigValue.channel,
      day: scheduleConfigValue.day,
    }),
    field,
  });

const scheduleRange = (scheduleConfigValue: FilteredScheduleConfigValue) => ({
  hours: {
    field: makeScheduleConfigField(scheduleConfigValue, "hours"),
    range: Option.some(`'${scheduleConfigValue.sheet}'!${scheduleConfigValue.hourRange}`),
  },
  fills: {
    field: makeScheduleConfigField(scheduleConfigValue, "fills"),
    range: Option.some(`'${scheduleConfigValue.sheet}'!${scheduleConfigValue.fillRange}`),
  },
  overfills: {
    field: makeScheduleConfigField(scheduleConfigValue, "overfills"),
    range: Option.some(`'${scheduleConfigValue.sheet}'!${scheduleConfigValue.overfillRange}`),
  },
  standbys: {
    field: makeScheduleConfigField(scheduleConfigValue, "standbys"),
    range: Option.some(`'${scheduleConfigValue.sheet}'!${scheduleConfigValue.standbyRange}`),
  },
  breaks: {
    field: makeScheduleConfigField(scheduleConfigValue, "breaks"),
    range: pipe(
      Match.value(scheduleConfigValue.breakRange),
      Match.when("auto", () => Option.none()),
      Match.orElse(() =>
        Option.some(`'${scheduleConfigValue.sheet}'!${scheduleConfigValue.breakRange}`),
      ),
    ),
  },
  monitor: {
    field: makeScheduleConfigField(scheduleConfigValue, "monitor"),
    range: pipe(
      scheduleConfigValue.monitorRange,
      Option.map((monitorRange) => `'${scheduleConfigValue.sheet}'!${monitorRange}`),
    ),
  },
  visible: {
    field: makeScheduleConfigField(scheduleConfigValue, "visibleCell"),
    range: Option.some(`'${scheduleConfigValue.sheet}'!${scheduleConfigValue.visibleCell}`),
  },
});

const scheduleRanges = (scheduleConfigValues: FilteredScheduleConfigValue[]) =>
  HashMap.fromIterable(
    scheduleConfigValues.flatMap((scheduleConfigValue) => {
      const range = scheduleRange(scheduleConfigValue);
      const entries: [ScheduleConfigField, string][] = [];

      if (Option.isSome(range.hours.range))
        entries.push([range.hours.field, range.hours.range.value]);
      if (Option.isSome(range.fills.range))
        entries.push([range.fills.field, range.fills.range.value]);
      if (Option.isSome(range.overfills.range)) {
        entries.push([range.overfills.field, range.overfills.range.value]);
      }
      if (Option.isSome(range.standbys.range)) {
        entries.push([range.standbys.field, range.standbys.range.value]);
      }
      if (Option.isSome(range.breaks.range))
        entries.push([range.breaks.field, range.breaks.range.value]);
      if (Option.isSome(range.monitor.range)) {
        entries.push([range.monitor.field, range.monitor.range.value]);
      }
      if (Option.isSome(range.visible.range)) {
        entries.push([range.visible.field, range.visible.range.value]);
      }

      return entries;
    }),
  );

const runnersInFills =
  (runnerConfigMap: HashMap.HashMap<Option.Option<string>, RunnerConfig>, hour: number) =>
  (fills: Option.Option<RawSchedulePlayer>[]) =>
    pipe(
      fills,
      Array.getSomes,
      Array.map((player) =>
        pipe(
          runnerConfigMap,
          HashMap.get(Option.some(player.player)),
          Option.map((config) => ({
            player,
            config,
          })),
        ),
      ),
      Array.getSomes,
      Array.filter(({ config }) => pipe(config.hours, Array.some(HourRange.includes(hour)))),
      Array.map(({ player }) => player),
    );

const baseScheduleParser = (
  scheduleConfigValue: FilteredScheduleConfigValue,
  sheet: HashMap.HashMap<ScheduleConfigField, sheets_v4.Schema$RowData[]>,
) =>
  pipe(
    Effect.Do,
    Effect.let("range", () => scheduleRange(scheduleConfigValue)),
    Effect.flatMap(({ range }) =>
      Effect.all(
        [
          pipe(sheet, getConfigFieldRowData(range.hours.field)),
          pipe(sheet, getConfigFieldRowData(range.fills.field)),
          pipe(sheet, getConfigFieldRowData(range.overfills.field)),
          pipe(sheet, getConfigFieldRowData(range.standbys.field)),
          pipe(
            Match.value(scheduleConfigValue.breakRange),
            Match.when("auto", () => Effect.succeed([] as sheets_v4.Schema$RowData[])),
            Match.orElse(() => pipe(sheet, getConfigFieldRowData(range.breaks.field))),
          ),
          pipe(sheet, getConfigFieldRowData(range.visible.field)),
        ],
        { concurrency: "unbounded" },
      ),
    ),
    Effect.flatMap((rowDatas) =>
      GoogleSheets.parseRowDatas(
        rowDatas,
        pipe(
          TupleToStructValueSchema(
            ["hour", "fills", "overfills", "standbys", "breakHour", "visible"] as const,
            Schema.toType(GoogleSheets.rowDataSchema),
          ),
          Schema.decodeTo(
            Schema.Struct({
              hour: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.decodeTo(GoogleSheets.cellToNumberSchema),
              ),
              fills: GoogleSheets.rowDataSchema,
              overfills: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.decodeTo(GoogleSheets.cellToStringArraySchema),
              ),
              standbys: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.decodeTo(GoogleSheets.cellToStringArraySchema),
              ),
              breakHour: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.decodeTo(GoogleSheets.cellToBooleanSchema),
              ),
              visible: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.decodeTo(GoogleSheets.cellToBooleanSchema),
              ),
            }),
          ),
        ),
      ),
    ),
    Effect.map(
      ArrayUtils.WithDefault.wrapEither({
        default: () => ({
          hour: Option.none<number>(),
          fills: [],
          overfills: Option.none<string[]>(),
          standbys: Option.none<string[]>(),
          breakHour: Option.none<boolean>(),
          visible: Option.none<boolean>(),
        }),
      }),
    ),
  );

const scheduleMonitorParser = (
  scheduleConfigValue: FilteredScheduleConfigValue,
  sheet: HashMap.HashMap<ScheduleConfigField, sheets_v4.Schema$RowData[]>,
) => {
  const monitorField = makeScheduleConfigField(scheduleConfigValue, "monitor");
  return pipe(
    sheet,
    getConfigFieldRowData(monitorField),
    Effect.flatMap((rowData) =>
      GoogleSheets.parseRowDatas(
        [rowData],
        pipe(
          TupleToStructValueSchema(["monitor"], GoogleSheets.rowDataToCellSchema),
          Schema.decodeTo(
            Schema.Struct({
              monitor: GoogleSheets.cellToStringSchema,
            }),
          ),
        ),
      ),
    ),
    Effect.map(
      ArrayUtils.WithDefault.wrapEither({
        default: () => ({
          monitor: Option.none<string>(),
        }),
      }),
    ),
  );
};

const scheduleParser = (
  scheduleConfigValues: FilteredScheduleConfigValue[],
  sheet: HashMap.HashMap<ScheduleConfigField, sheets_v4.Schema$RowData[]>,
  runnerConfigs: RunnerConfig[],
) =>
  pipe(
    Effect.Do,
    Effect.let("runnerConfigMap", () =>
      pipe(runnerConfigs, ArrayUtils.Collect.toHashMapByKey("name")),
    ),
    Effect.flatMap(({ runnerConfigMap }) =>
      Effect.forEach(scheduleConfigValues, (scheduleConfig) =>
        pipe(
          Effect.all({
            base: baseScheduleParser(scheduleConfig, sheet),
            monitor: pipe(
              scheduleConfig.monitorRange,
              Option.match({
                onNone: () =>
                  Effect.succeed(
                    pipe(
                      [],
                      ArrayUtils.WithDefault.wrap<
                        {
                          monitor: Option.Option<string>;
                        }[]
                      >({
                        default: () => ({ monitor: Option.none<string>() }),
                      }),
                    ),
                  ),
                onSome: () => scheduleMonitorParser(scheduleConfig, sheet),
              }),
            ),
          }),
          Effect.map(({ base, monitor }) => pipe(base, ArrayUtils.WithDefault.zip(monitor))),
          Effect.map(ArrayUtils.WithDefault.replaceKeysFromHead("visible")),
          Effect.map(
            ArrayUtils.WithDefault.map(
              ({ hour, fills, overfills, standbys, breakHour, visible, monitor }) => ({
                hour,
                fills: Array.makeBy(5, (i) =>
                  pipe(
                    Array.get(fills, i),
                    Option.flatMap((fillCell) =>
                      pipe(
                        toCellOption(fillCell.formattedValue),
                        Option.map(
                          (fill) =>
                            new RawSchedulePlayer({
                              player: upperFirst(fill),
                              enc: isFillEnc(scheduleConfig.encType, fillCell, fill),
                            }),
                        ),
                      ),
                    ),
                  ),
                ),
                overfills: pipe(
                  overfills,
                  Option.getOrElse(() => []),
                  Array.map(
                    (overfill) =>
                      new RawSchedulePlayer({
                        player: upperFirst(overfill),
                        enc: scheduleConfig.encType === "regex" ? isRegexEnc(overfill) : false,
                      }),
                  ),
                ),
                standbys: pipe(
                  standbys,
                  Option.getOrElse(() => []),
                  Array.map(
                    (standby) =>
                      new RawSchedulePlayer({
                        player: upperFirst(standby),
                        enc: scheduleConfig.encType === "regex" ? isRegexEnc(standby) : false,
                      }),
                  ),
                ),
                breakHour,
                visible: pipe(
                  visible,
                  Option.getOrElse(() => true),
                ),
                monitor: pipe(
                  monitor,
                  Option.map((monitor) => upperFirst(monitor)),
                ),
              }),
            ),
          ),
          Effect.map(
            ArrayUtils.WithDefault.map((config) => ({
              ...config,
              runners: pipe(
                config.hour,
                Option.map((hour) => pipe(config.fills, runnersInFills(runnerConfigMap, hour))),
                Option.getOrElse(() => []),
              ),
            })),
          ),
          Effect.map(
            ArrayUtils.WithDefault.map((config) => ({
              ...config,
              breakHour: pipe(
                config.breakHour,
                Option.getOrElse(() =>
                  pipe(
                    Match.value(scheduleConfig.breakRange),
                    Match.when("auto", () => config.runners.length === 0),
                    Match.orElse(() => false),
                  ),
                ),
              ),
            })),
          ),
          Effect.map(ArrayUtils.WithDefault.toArray),
          Effect.map(
            Array.map((config) =>
              makeSchedule({
                channel: scheduleConfig.channel,
                day: scheduleConfig.day,
                ...config,
              }),
            ),
          ),
        ),
      ),
    ),
    Effect.map(Array.flatten),
    Effect.withSpan("scheduleParser"),
  );

// Helper to filter schedules for fillers
// Returns all schedules but clears fill data for invisible ones
// (fillers can sign up but can't see if slots are full)
const filterSchedulesForFiller = (schedules: Array<BreakSchedule | Schedule>) =>
  pipe(
    schedules,
    Array.map((schedule) =>
      Match.value(schedule).pipe(
        Match.tagsExhaustive({
          BreakSchedule: (breakSchedule) => breakSchedule,
          Schedule: (s) =>
            s.visible
              ? s // Keep visible schedules as-is
              : new Schedule({
                  channel: s.channel,
                  day: s.day,
                  visible: s.visible,
                  hour: s.hour,
                  hourWindow: s.hourWindow,
                  fills: Array.makeBy(5, () => Option.none()),
                  overfills: [],
                  standbys: [],
                  runners: [],
                  monitor: Option.none(),
                }),
        }),
      ),
    ),
  );

export class SheetService extends Context.Service<SheetService>()("SheetService", {
  make: Effect.gen(function* () {
    const sheet = yield* GoogleSheets;
    const sheetConfigService = yield* SheetConfigService;

    const getRangesConfig = Effect.fn("SheetService.getRangesConfig")(function* (sheetId: string) {
      return yield* sheetConfigService.getRangesConfig(sheetId);
    });
    const getTeamConfig = Effect.fn("SheetService.getTeamConfig")(function* (sheetId: string) {
      return yield* sheetConfigService.getTeamConfig(sheetId);
    });
    const getEventConfig = Effect.fn("SheetService.getEventConfig")(function* (sheetId: string) {
      return yield* sheetConfigService.getEventConfig(sheetId);
    });
    const getScheduleConfig = Effect.fn("SheetService.getScheduleConfig")(function* (
      sheetId: string,
    ) {
      return yield* sheetConfigService.getScheduleConfig(sheetId);
    });
    const getRunnerConfig = Effect.fn("SheetService.getRunnerConfig")(function* (sheetId: string) {
      return yield* sheetConfigService.getRunnerConfig(sheetId);
    });

    const getPlayers = Effect.fn("SheetService.getPlayers")(function* (sheetId: string) {
      const rangesConfig = yield* sheetConfigService.getRangesConfig(sheetId);
      const response = yield* sheet.get({
        spreadsheetId: sheetId,
        ranges: [rangesConfig.userIds, rangesConfig.userSheetNames],
      });
      return yield* playerParser(response.data.valueRanges ?? []);
    });

    const getMonitors = Effect.fn("SheetService.getMonitors")(function* (sheetId: string) {
      const rangesConfig = yield* sheetConfigService.getRangesConfig(sheetId);
      const ranges = Option.all({
        ids: rangesConfig.monitorIds,
        names: rangesConfig.monitorNames,
      });
      if (Option.isNone(ranges)) {
        return [] as readonly RawMonitor[];
      }
      const response = yield* sheet.get({
        spreadsheetId: sheetId,
        ranges: [ranges.value.ids, ranges.value.names],
      });
      return yield* monitorParser(response.data.valueRanges ?? []);
    });

    const getTeams = Effect.fn("SheetService.getTeams")(function* (sheetId: string) {
      const teamConfigs = yield* sheetConfigService.getTeamConfig(sheetId);
      const filteredTeamConfigValues = filterTeamConfigValues(teamConfigs);
      const response = yield* sheet.getHashMap(
        teamRanges(filteredTeamConfigValues) as HashMap.HashMap<TeamConfigField, string>,
        {
          spreadsheetId: sheetId,
        },
      );
      return yield* teamParser(filteredTeamConfigValues, response);
    });

    const getSchedulesForConfigs = Effect.fn("SheetService.getSchedulesForConfigs")(function* (
      sheetId: string,
      filter: (
        configs: ReturnType<typeof filterScheduleConfigValues>,
      ) => ReturnType<typeof filterScheduleConfigValues>,
    ) {
      const { scheduleConfigs, runnerConfig } = yield* Effect.all({
        scheduleConfigs: sheetConfigService.getScheduleConfig(sheetId),
        runnerConfig: sheetConfigService.getRunnerConfig(sheetId),
      });
      const filteredScheduleConfigs = filter(filterScheduleConfigValues(scheduleConfigs));
      const response = yield* sheet.getRowDatasHashMap(
        scheduleRanges(filteredScheduleConfigs) as HashMap.HashMap<ScheduleConfigField, string>,
        {
          spreadsheetId: sheetId,
        },
      );
      return yield* scheduleParser(filteredScheduleConfigs, response, runnerConfig);
    });

    const getAllSchedules = Effect.fn("SheetService.getAllSchedules")(function* (sheetId: string) {
      return yield* getSchedulesForConfigs(sheetId, (configs) => configs);
    });
    const getDaySchedules = Effect.fn("SheetService.getDaySchedules")(function* (
      sheetId: string,
      day: number,
    ) {
      return yield* getSchedulesForConfigs(sheetId, (configs) =>
        pipe(
          configs,
          Array.filter((config) => Number.Equivalence(config.day, day)),
        ),
      );
    });
    const getChannelSchedules = Effect.fn("SheetService.getChannelSchedules")(function* (
      sheetId: string,
      channel: string,
    ) {
      return yield* getSchedulesForConfigs(sheetId, (configs) =>
        pipe(
          configs,
          Array.filter((config) => String.Equivalence(config.channel, channel)),
        ),
      );
    });

    const getAllFillerSchedules = Effect.fn("SheetService.getAllFillerSchedules")(function* (
      sheetId: string,
    ) {
      const schedules = yield* getAllSchedules(sheetId);
      return filterSchedulesForFiller(schedules);
    });
    const getDayFillerSchedules = Effect.fn("SheetService.getDayFillerSchedules")(function* (
      sheetId: string,
      day: number,
    ) {
      const schedules = yield* getDaySchedules(sheetId, day);
      return filterSchedulesForFiller(schedules);
    });
    const getChannelFillerSchedules = Effect.fn("SheetService.getChannelFillerSchedules")(
      function* (sheetId: string, channel: string) {
        const schedules = yield* getChannelSchedules(sheetId, channel);
        return filterSchedulesForFiller(schedules);
      },
    );

    const caches = yield* Effect.all({
      getRangesConfigCache: ScopedCache.make({ lookup: getRangesConfig }),
      getTeamConfigCache: ScopedCache.make({ lookup: getTeamConfig }),
      getEventConfigCache: ScopedCache.make({ lookup: getEventConfig }),
      getScheduleConfigCache: ScopedCache.make({ lookup: getScheduleConfig }),
      getRunnerConfigCache: ScopedCache.make({ lookup: getRunnerConfig }),
      getPlayersCache: ScopedCache.make({ lookup: getPlayers }),
      getMonitorsCache: ScopedCache.make({ lookup: getMonitors }),
      getTeamsCache: ScopedCache.make({ lookup: getTeams }),
      getAllSchedulesCache: ScopedCache.make({ lookup: getAllSchedules }),
      getDaySchedulesCache: ScopedCache.make({
        lookup: ({ sheetId, day }: { sheetId: string; day: number }) =>
          getDaySchedules(sheetId, day),
      }),
      getChannelSchedulesCache: ScopedCache.make({
        lookup: ({ sheetId, channel }: { sheetId: string; channel: string }) =>
          getChannelSchedules(sheetId, channel),
      }),
      getAllFillerSchedulesCache: ScopedCache.make({ lookup: getAllFillerSchedules }),
      getDayFillerSchedulesCache: ScopedCache.make({
        lookup: ({ sheetId, day }: { sheetId: string; day: number }) =>
          getDayFillerSchedules(sheetId, day),
      }),
      getChannelFillerSchedulesCache: ScopedCache.make({
        lookup: ({ sheetId, channel }: { sheetId: string; channel: string }) =>
          getChannelFillerSchedules(sheetId, channel),
      }),
    });

    return {
      getRangesConfig: (sheetId: string) => caches.getRangesConfigCache.get(sheetId),
      getTeamConfig: (sheetId: string) => caches.getTeamConfigCache.get(sheetId),
      getEventConfig: (sheetId: string) => caches.getEventConfigCache.get(sheetId),
      getScheduleConfig: (sheetId: string) => caches.getScheduleConfigCache.get(sheetId),
      getRunnerConfig: (sheetId: string) => caches.getRunnerConfigCache.get(sheetId),
      getPlayers: (sheetId: string) => caches.getPlayersCache.get(sheetId),
      getMonitors: (sheetId: string) => caches.getMonitorsCache.get(sheetId),
      getTeams: (sheetId: string) => caches.getTeamsCache.get(sheetId),
      getAllSchedules: (sheetId: string) => caches.getAllSchedulesCache.get(sheetId),
      getDaySchedules: (sheetId: string, day: number) =>
        caches.getDaySchedulesCache.get({ sheetId, day }),
      getChannelSchedules: (sheetId: string, channel: string) =>
        caches.getChannelSchedulesCache.get({ sheetId, channel }),
      getAllFillerSchedules: (sheetId: string) => caches.getAllFillerSchedulesCache.get(sheetId),
      getDayFillerSchedules: (sheetId: string, day: number) =>
        caches.getDayFillerSchedulesCache.get({ sheetId, day }),
      getChannelFillerSchedules: (sheetId: string, channel: string) =>
        caches.getChannelFillerSchedulesCache.get({ sheetId, channel }),
    };
  }),
}) {
  static layer = Layer.effect(SheetService, this.make).pipe(
    Layer.provide(SheetConfigService.layer),
    Layer.provide(GoogleSheets.layer),
  );
}
