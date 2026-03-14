import { ParserFieldError } from "@/schemas/sheet/error";
import {
  HourRange,
  RunnerConfig,
  ScheduleConfig,
  TeamConfig,
  TeamIsvSplitConfig,
  TeamIsvCombinedConfig,
  TeamTagsRangesConfig,
} from "@/schemas/sheetConfig";
import {
  RawPlayer,
  RawMonitor,
  RawSchedulePlayer,
  Team,
  makeSchedule,
  BreakSchedule,
  Schedule,
} from "@/schemas/sheet";
import { regex } from "arkregex";
import { type sheets_v4 } from "@googleapis/sheets";
import { Array, Data, Effect, HashMap, Match, Number, Option, pipe, Schema, String } from "effect";
import { upperFirst } from "scule";
import { TupleToStructValueSchema } from "typhoon-core/schema";
import { Array as ArrayUtils, ScopedCache, Struct as StructUtils } from "typhoon-core/utils";

import { GoogleSheets } from "./google/sheets";
import { SheetConfigService } from "./sheetConfig";

class ConfigField<Range> extends Data.TaggedClass("ConfigField")<{
  range: Range;
  field: string;
}> {}

const getConfigFieldValueRange =
  <Range>(configField: ConfigField<Range>) =>
  (sheet: HashMap.HashMap<ConfigField<Range>, sheets_v4.Schema$ValueRange>) =>
    pipe(
      sheet,
      HashMap.get(configField),
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            new ParserFieldError({
              message: `Error getting ${configField.field}, no config field found`,
              range: configField.range,
              field: configField.field,
            }),
          ),
      }),
      (e) => Effect.suspend(() => e),
      Effect.withSpan("getConfigFieldValueRange", { captureStackTrace: true }),
    );

const getConfigFieldRowData =
  <Range>(configField: ConfigField<Range>) =>
  (sheet: HashMap.HashMap<ConfigField<Range>, sheets_v4.Schema$RowData[]>) =>
    pipe(
      sheet,
      HashMap.get(configField),
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            new ParserFieldError({
              message: `Error getting ${configField.field}, no config field found`,
              range: configField.range,
              field: configField.field,
            }),
          ),
      }),
      (e) => Effect.suspend(() => e),
      Effect.withSpan("getConfigFieldRowData", { captureStackTrace: true }),
    );

const playerParser = ([userIds, userSheetNames]: sheets_v4.Schema$ValueRange[]) =>
  pipe(
    GoogleSheets.parseValueRanges(
      [userIds, userSheetNames],
      pipe(
        TupleToStructValueSchema(["id", "name"], GoogleSheets.rowToCellSchema),
        Schema.compose(
          Schema.Struct({
            id: GoogleSheets.cellToStringSchema,
            name: GoogleSheets.cellToStringSchema,
          }),
        ),
      ),
    ),
    Effect.map(Array.getRights),
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
    Effect.withSpan("playerParser", { captureStackTrace: true }),
  );

const monitorParser = ([monitorIds, monitorNames]: sheets_v4.Schema$ValueRange[]) =>
  pipe(
    GoogleSheets.parseValueRanges(
      [monitorIds, monitorNames],
      pipe(
        TupleToStructValueSchema(["id", "name"], GoogleSheets.rowToCellSchema),
        Schema.compose(
          Schema.Struct({
            id: GoogleSheets.cellToStringSchema,
            name: GoogleSheets.cellToStringSchema,
          }),
        ),
      ),
    ),
    Effect.map(Array.getRights),
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
    Effect.withSpan("monitorParser", { captureStackTrace: true }),
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
          TupleToStructValueSchema(["playerName", "teamName"], GoogleSheets.rowToCellSchema),
          Schema.compose(
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
          TupleToStructValueSchema(["lead", "backline", "talent"], GoogleSheets.rowToCellSchema),
          Schema.compose(
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
          TupleToStructValueSchema(["isv"], GoogleSheets.rowToCellSchema),
          Schema.compose(
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
          Schema.decode(
            Schema.Struct({
              lead: GoogleSheets.cellToNumberSchema,
              backline: GoogleSheets.cellToNumberSchema,
              talent: GoogleSheets.cellToNumberSchema,
            }),
          ),
          Effect.either,
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
          TupleToStructValueSchema(["tags"], GoogleSheets.rowToCellSchema),
          Schema.compose(
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
  pipe(
    teamConfigValues,
    Array.reduce(HashMap.empty<TeamConfigField, Option.Option<string>>(), (acc, a) => {
      const range = teamBaseRange(a);
      return pipe(
        acc,
        HashMap.set(range.playerName.field, range.playerName.range),
        HashMap.set(range.teamName.field, range.teamName.range),
        (map) =>
          pipe(
            Match.value(a.isvConfig),
            Match.tagsExhaustive({
              TeamIsvSplitConfig: (cfg) => {
                const range = teamSplitIsvRange(a, cfg);
                return pipe(
                  map,
                  HashMap.set(range.lead.field, range.lead.range),
                  HashMap.set(range.backline.field, range.backline.range),
                  HashMap.set(range.talent.field, range.talent.range),
                );
              },
              TeamIsvCombinedConfig: (cfg) => {
                const range = teamCombinedIsvRange(a, cfg);
                return pipe(map, HashMap.set(range.isv.field, range.isv.range));
              },
            }),
          ),
        (map) =>
          pipe(
            Match.value(a.tagsConfig),
            Match.tagsExhaustive({
              TeamTagsConstantsConfig: () => map,
              TeamTagsRangesConfig: (cfg) => {
                const range = teamRangesTagsRange(a, cfg);
                return pipe(map, HashMap.set(range.tags.field, range.tags.range));
              },
            }),
          ),
      );
    }),
    HashMap.filterMap((a, _) => a),
  );

const teamParser = (
  teamConfigValues: FilteredTeamConfigValue[],
  sheet: HashMap.HashMap<TeamConfigField, sheets_v4.Schema$ValueRange>,
) =>
  pipe(
    teamConfigValues,
    Effect.forEach((teamConfig) =>
      pipe(
        Effect.all({
          base: teamBaseParser(teamConfig, sheet),
          isv: pipe(
            Match.value(teamConfig.isvConfig),
            Match.tagsExhaustive({
              TeamIsvSplitConfig: (cfg) => teamSplitIsvParser(teamConfig, cfg, sheet),
              TeamIsvCombinedConfig: (cfg) => teamCombinedIsvParser(teamConfig, cfg, sheet),
            }),
          ),
          tags: pipe(
            Match.value(teamConfig.tagsConfig),
            Match.tagsExhaustive({
              TeamTagsConstantsConfig: (cfg) =>
                Effect.succeed(
                  pipe(
                    [],
                    ArrayUtils.WithDefault.wrap<{ tags: readonly string[] }[]>({
                      default: () => ({ tags: cfg.tags }),
                    }),
                  ),
                ),
              TeamTagsRangesConfig: (cfg) => teamRangesTagsParser(teamConfig, cfg, sheet),
            }),
          ),
        }),
        Effect.map(({ base, isv, tags }) =>
          pipe(base, ArrayUtils.WithDefault.zip(isv), ArrayUtils.WithDefault.zip(tags)),
        ),
        Effect.map(ArrayUtils.WithDefault.toArray),
        Effect.map(Array.map(StructUtils.GetSomeFields.getSomeFields(["lead", "backline"]))),
        Effect.map(Array.getSomes),
        Effect.map(
          Array.map((config) =>
            Team.make({
              type: teamConfig.name,
              ...config,
            }),
          ),
        ),
      ),
    ),
    Effect.map(Array.flatten),
    Effect.withSpan("teamParser", { captureStackTrace: true }),
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
  pipe(
    scheduleConfigValues,
    Array.reduce(HashMap.empty<ScheduleConfigField, Option.Option<string>>(), (acc, a) => {
      const range = scheduleRange(a);
      return pipe(
        acc,
        HashMap.set(range.hours.field, range.hours.range),
        HashMap.set(range.fills.field, range.fills.range),
        HashMap.set(range.overfills.field, range.overfills.range),
        HashMap.set(range.standbys.field, range.standbys.range),
        HashMap.set(range.breaks.field, range.breaks.range),
        HashMap.set(range.monitor.field, range.monitor.range),
        HashMap.set(range.visible.field, range.visible.range),
      );
    }),
    HashMap.filterMap((a, _) => a),
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
            ["hour", "fills", "overfills", "standbys", "breakHour", "visible"],
            Schema.typeSchema(GoogleSheets.rowDataSchema),
          ),
          Schema.compose(
            Schema.Struct({
              hour: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.compose(GoogleSheets.cellToNumberSchema),
              ),
              fills: GoogleSheets.rowDataToRowSchema,
              overfills: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.compose(GoogleSheets.cellToStringArraySchema),
              ),
              standbys: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.compose(GoogleSheets.cellToStringArraySchema),
              ),
              breakHour: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.compose(GoogleSheets.cellToBooleanSchema),
              ),
              visible: pipe(
                GoogleSheets.rowDataToCellSchema,
                Schema.compose(GoogleSheets.cellToBooleanSchema),
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
          Schema.compose(
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
                    Option.flatten,
                    Option.map((fill) =>
                      RawSchedulePlayer.make({
                        player: upperFirst(fill),
                        enc:
                          scheduleConfig.encType === "regex"
                            ? playerNameRegex.exec(fill)?.groups?.enc !== undefined
                            : false,
                      }),
                    ),
                  ),
                ),
                overfills: pipe(
                  overfills,
                  Option.getOrElse(() => []),
                  Array.map((overfill) =>
                    RawSchedulePlayer.make({
                      player: upperFirst(overfill),
                      enc:
                        scheduleConfig.encType === "regex"
                          ? playerNameRegex.exec(overfill)?.groups?.enc !== undefined
                          : false,
                    }),
                  ),
                ),
                standbys: pipe(
                  standbys,
                  Option.getOrElse(() => []),
                  Array.map((standby) =>
                    RawSchedulePlayer.make({
                      player: upperFirst(standby),
                      enc:
                        scheduleConfig.encType === "regex"
                          ? playerNameRegex.exec(standby)?.groups?.enc !== undefined
                          : false,
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
                    Match.when("auto", () => Array.isEmptyArray(config.runners)),
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
    Effect.withSpan("scheduleParser", { captureStackTrace: true }),
  );

// Helper to filter schedules for fillers
const filterSchedulesForFiller = (schedules: Array<BreakSchedule | Schedule>) =>
  pipe(
    schedules,
    Array.filter((schedule) => schedule.visible),
    Array.map((schedule) =>
      Match.value(schedule).pipe(
        Match.tagsExhaustive({
          BreakSchedule: (breakSchedule) => breakSchedule,
          Schedule: (s) =>
            Schedule.make({
              channel: s.channel,
              day: s.day,
              visible: s.visible,
              hour: s.hour,
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

export class SheetService extends Effect.Service<SheetService>()("SheetService", {
  scoped: pipe(
    Effect.all(
      {
        sheet: GoogleSheets,
        sheetConfigService: SheetConfigService,
      },
      { concurrency: "unbounded" },
    ),
    Effect.map(({ sheet, sheetConfigService }) => ({
      getRangesConfig: (sheetId: string) =>
        pipe(
          sheetConfigService.getRangesConfig(sheetId),
          Effect.withSpan("SheetService.getRangesConfig", {
            captureStackTrace: true,
          }),
        ),
      getTeamConfig: (sheetId: string) =>
        pipe(
          sheetConfigService.getTeamConfig(sheetId),
          Effect.withSpan("SheetService.getTeamConfig", {
            captureStackTrace: true,
          }),
        ),
      getEventConfig: (sheetId: string) =>
        pipe(
          sheetConfigService.getEventConfig(sheetId),
          Effect.withSpan("SheetService.getEventConfig", {
            captureStackTrace: true,
          }),
        ),
      getScheduleConfig: (sheetId: string) =>
        pipe(
          sheetConfigService.getScheduleConfig(sheetId),
          Effect.withSpan("SheetService.getScheduleConfig", {
            captureStackTrace: true,
          }),
        ),
      getRunnerConfig: (sheetId: string) =>
        pipe(
          sheetConfigService.getRunnerConfig(sheetId),
          Effect.withSpan("SheetService.getRunnerConfig", {
            captureStackTrace: true,
          }),
        ),
      getPlayers: (sheetId: string) =>
        pipe(
          Effect.Do,
          Effect.bind("rangesConfig", () => sheetConfigService.getRangesConfig(sheetId)),
          Effect.bind("sheet", ({ rangesConfig }) =>
            sheet.get({
              spreadsheetId: sheetId,
              ranges: [rangesConfig.userIds, rangesConfig.userSheetNames],
            }),
          ),
          Effect.flatMap(({ sheet }) => playerParser(sheet.data.valueRanges ?? [])),
          Effect.withSpan("SheetService.getPlayers", {
            captureStackTrace: true,
          }),
        ),
      getMonitors: (sheetId: string) =>
        pipe(
          Effect.Do,
          Effect.bind("rangesConfig", () => sheetConfigService.getRangesConfig(sheetId)),
          Effect.bind("ranges", ({ rangesConfig }) =>
            Effect.succeed(
              Option.all({ ids: rangesConfig.monitorIds, names: rangesConfig.monitorNames }),
            ),
          ),
          Effect.flatMap(({ ranges }) =>
            pipe(
              ranges,
              Option.match({
                onNone: () => Effect.succeed([] as RawMonitor[]),
                onSome: ({ ids, names }) =>
                  pipe(
                    sheet.get({
                      spreadsheetId: sheetId,
                      ranges: [ids, names],
                    }),
                    Effect.flatMap((response) => monitorParser(response.data.valueRanges ?? [])),
                  ),
              }),
            ),
          ),
          Effect.provideService(GoogleSheets, sheet),
          Effect.withSpan("SheetService.getMonitors", {
            captureStackTrace: true,
          }),
        ),
      getTeams: (sheetId: string) =>
        pipe(
          Effect.Do,
          Effect.bind("teamConfigs", () => sheetConfigService.getTeamConfig(sheetId)),
          Effect.let("filteredTeamConfigValues", ({ teamConfigs }) =>
            filterTeamConfigValues(teamConfigs),
          ),
          Effect.let("ranges", ({ filteredTeamConfigValues }) =>
            teamRanges(filteredTeamConfigValues),
          ),
          Effect.bind("sheet", ({ ranges }) =>
            sheet.getHashMap(ranges, { spreadsheetId: sheetId }),
          ),
          Effect.flatMap(({ filteredTeamConfigValues, sheet }) =>
            teamParser(filteredTeamConfigValues, sheet),
          ),
          Effect.provideService(GoogleSheets, sheet),
          Effect.withSpan("SheetService.getTeams", {
            captureStackTrace: true,
          }),
        ),
      getAllSchedules: (sheetId: string) =>
        pipe(
          Effect.Do,
          Effect.bindAll(
            () => ({
              scheduleConfigs: sheetConfigService.getScheduleConfig(sheetId),
              runnerConfig: sheetConfigService.getRunnerConfig(sheetId),
            }),
            { concurrency: "unbounded" },
          ),
          Effect.let("filteredScheduleConfigs", ({ scheduleConfigs }) =>
            filterScheduleConfigValues(scheduleConfigs),
          ),
          Effect.bind("sheet", ({ filteredScheduleConfigs }) =>
            sheet.getRowDatasHashMap(scheduleRanges(filteredScheduleConfigs), {
              spreadsheetId: sheetId,
            }),
          ),
          Effect.bind("schedules", ({ filteredScheduleConfigs, sheet, runnerConfig }) =>
            scheduleParser(filteredScheduleConfigs, sheet, runnerConfig),
          ),
          Effect.map(({ schedules }) => schedules),
          Effect.provideService(GoogleSheets, sheet),
          Effect.withSpan("SheetService.getAllSchedules", {
            captureStackTrace: true,
          }),
        ),
      getDaySchedules: (sheetId: string, day: number) =>
        pipe(
          Effect.Do,
          Effect.bindAll(
            () => ({
              scheduleConfigs: sheetConfigService.getScheduleConfig(sheetId),
              runnerConfig: sheetConfigService.getRunnerConfig(sheetId),
            }),
            { concurrency: "unbounded" },
          ),
          Effect.let("filteredScheduleConfigs", ({ scheduleConfigs }) =>
            pipe(
              scheduleConfigs,
              filterScheduleConfigValues,
              Array.filter((a) => Number.Equivalence(a.day, day)),
            ),
          ),
          Effect.bind("sheet", ({ filteredScheduleConfigs }) =>
            sheet.getRowDatasHashMap(scheduleRanges(filteredScheduleConfigs), {
              spreadsheetId: sheetId,
            }),
          ),
          Effect.bind("schedules", ({ filteredScheduleConfigs, sheet, runnerConfig }) =>
            scheduleParser(filteredScheduleConfigs, sheet, runnerConfig),
          ),
          Effect.map(({ schedules }) => schedules),
          Effect.provideService(GoogleSheets, sheet),
          Effect.withSpan("SheetService.getDaySchedules", {
            captureStackTrace: true,
          }),
        ),
      getChannelSchedules: (sheetId: string, channel: string) =>
        pipe(
          Effect.Do,
          Effect.bindAll(
            () => ({
              scheduleConfigs: sheetConfigService.getScheduleConfig(sheetId),
              runnerConfig: sheetConfigService.getRunnerConfig(sheetId),
            }),
            { concurrency: "unbounded" },
          ),
          Effect.let("filteredScheduleConfigs", ({ scheduleConfigs }) =>
            pipe(
              scheduleConfigs,
              filterScheduleConfigValues,
              Array.filter((a) => String.Equivalence(a.channel, channel)),
            ),
          ),
          Effect.bind("sheet", ({ filteredScheduleConfigs }) =>
            sheet.getRowDatasHashMap(scheduleRanges(filteredScheduleConfigs), {
              spreadsheetId: sheetId,
            }),
          ),
          Effect.bind("schedules", ({ filteredScheduleConfigs, sheet, runnerConfig }) =>
            scheduleParser(filteredScheduleConfigs, sheet, runnerConfig),
          ),
          Effect.map(({ schedules }) => schedules),
          Effect.provideService(GoogleSheets, sheet),
          Effect.withSpan("SheetService.getChannelSchedules", {
            captureStackTrace: true,
          }),
        ),
      // Filler schedules - filtered by visible, with fill/overfill/standby/runners cleared
      getAllFillerSchedules: (sheetId: string) =>
        pipe(
          Effect.Do,
          Effect.bindAll(
            () => ({
              scheduleConfigs: sheetConfigService.getScheduleConfig(sheetId),
              runnerConfig: sheetConfigService.getRunnerConfig(sheetId),
            }),
            { concurrency: "unbounded" },
          ),
          Effect.let("filteredScheduleConfigs", ({ scheduleConfigs }) =>
            filterScheduleConfigValues(scheduleConfigs),
          ),
          Effect.bind("sheet", ({ filteredScheduleConfigs }) =>
            sheet.getRowDatasHashMap(scheduleRanges(filteredScheduleConfigs), {
              spreadsheetId: sheetId,
            }),
          ),
          Effect.bind("schedules", ({ filteredScheduleConfigs, sheet, runnerConfig }) =>
            scheduleParser(filteredScheduleConfigs, sheet, runnerConfig),
          ),
          Effect.map(({ schedules }) => filterSchedulesForFiller(schedules)),
          Effect.provideService(GoogleSheets, sheet),
          Effect.withSpan("SheetService.getAllFillerSchedules", {
            captureStackTrace: true,
          }),
        ),
      getDayFillerSchedules: (sheetId: string, day: number) =>
        pipe(
          Effect.Do,
          Effect.bindAll(
            () => ({
              scheduleConfigs: sheetConfigService.getScheduleConfig(sheetId),
              runnerConfig: sheetConfigService.getRunnerConfig(sheetId),
            }),
            { concurrency: "unbounded" },
          ),
          Effect.let("filteredScheduleConfigs", ({ scheduleConfigs }) =>
            pipe(
              scheduleConfigs,
              filterScheduleConfigValues,
              Array.filter((a) => Number.Equivalence(a.day, day)),
            ),
          ),
          Effect.bind("sheet", ({ filteredScheduleConfigs }) =>
            sheet.getRowDatasHashMap(scheduleRanges(filteredScheduleConfigs), {
              spreadsheetId: sheetId,
            }),
          ),
          Effect.bind("schedules", ({ filteredScheduleConfigs, sheet, runnerConfig }) =>
            scheduleParser(filteredScheduleConfigs, sheet, runnerConfig),
          ),
          Effect.map(({ schedules }) => filterSchedulesForFiller(schedules)),
          Effect.provideService(GoogleSheets, sheet),
          Effect.withSpan("SheetService.getDayFillerSchedules", {
            captureStackTrace: true,
          }),
        ),
      getChannelFillerSchedules: (sheetId: string, channel: string) =>
        pipe(
          Effect.Do,
          Effect.bindAll(
            () => ({
              scheduleConfigs: sheetConfigService.getScheduleConfig(sheetId),
              runnerConfig: sheetConfigService.getRunnerConfig(sheetId),
            }),
            { concurrency: "unbounded" },
          ),
          Effect.let("filteredScheduleConfigs", ({ scheduleConfigs }) =>
            pipe(
              scheduleConfigs,
              filterScheduleConfigValues,
              Array.filter((a) => String.Equivalence(a.channel, channel)),
            ),
          ),
          Effect.bind("sheet", ({ filteredScheduleConfigs }) =>
            sheet.getRowDatasHashMap(scheduleRanges(filteredScheduleConfigs), {
              spreadsheetId: sheetId,
            }),
          ),
          Effect.bind("schedules", ({ filteredScheduleConfigs, sheet, runnerConfig }) =>
            scheduleParser(filteredScheduleConfigs, sheet, runnerConfig),
          ),
          Effect.map(({ schedules }) => filterSchedulesForFiller(schedules)),
          Effect.provideService(GoogleSheets, sheet),
          Effect.withSpan("SheetService.getChannelFillerSchedules", {
            captureStackTrace: true,
          }),
        ),
    })),
    Effect.flatMap(
      ({
        getRangesConfig,
        getTeamConfig,
        getEventConfig,
        getScheduleConfig,
        getRunnerConfig,
        getPlayers,
        getMonitors,
        getTeams,
        getAllSchedules,
        getDaySchedules,
        getChannelSchedules,
        getAllFillerSchedules,
        getDayFillerSchedules,
        getChannelFillerSchedules,
      }) =>
        Effect.all({
          getRangesConfigCache: ScopedCache.make({
            lookup: getRangesConfig,
          }),
          getTeamConfigCache: ScopedCache.make({
            lookup: getTeamConfig,
          }),
          getEventConfigCache: ScopedCache.make({
            lookup: getEventConfig,
          }),
          getScheduleConfigCache: ScopedCache.make({
            lookup: getScheduleConfig,
          }),
          getRunnerConfigCache: ScopedCache.make({
            lookup: getRunnerConfig,
          }),
          getPlayersCache: ScopedCache.make({
            lookup: getPlayers,
          }),
          getMonitorsCache: ScopedCache.make({
            lookup: getMonitors,
          }),
          getTeamsCache: ScopedCache.make({
            lookup: getTeams,
          }),
          getAllSchedulesCache: ScopedCache.make({
            lookup: getAllSchedules,
          }),
          getDaySchedulesCache: ScopedCache.make({
            lookup: ({ sheetId, day }: { sheetId: string; day: number }) =>
              getDaySchedules(sheetId, day),
          }),
          getChannelSchedulesCache: ScopedCache.make({
            lookup: ({ sheetId, channel }: { sheetId: string; channel: string }) =>
              getChannelSchedules(sheetId, channel),
          }),
          getAllFillerSchedulesCache: ScopedCache.make({
            lookup: getAllFillerSchedules,
          }),
          getDayFillerSchedulesCache: ScopedCache.make({
            lookup: ({ sheetId, day }: { sheetId: string; day: number }) =>
              getDayFillerSchedules(sheetId, day),
          }),
          getChannelFillerSchedulesCache: ScopedCache.make({
            lookup: ({ sheetId, channel }: { sheetId: string; channel: string }) =>
              getChannelFillerSchedules(sheetId, channel),
          }),
        }),
    ),
    Effect.map(
      ({
        getRangesConfigCache,
        getTeamConfigCache,
        getEventConfigCache,
        getScheduleConfigCache,
        getRunnerConfigCache,
        getPlayersCache,
        getMonitorsCache,
        getTeamsCache,
        getAllSchedulesCache,
        getDaySchedulesCache,
        getChannelSchedulesCache,
        getAllFillerSchedulesCache,
        getDayFillerSchedulesCache,
        getChannelFillerSchedulesCache,
      }) => ({
        getRangesConfig: (sheetId: string) => getRangesConfigCache.get(sheetId),
        getTeamConfig: (sheetId: string) => getTeamConfigCache.get(sheetId),
        getEventConfig: (sheetId: string) => getEventConfigCache.get(sheetId),
        getScheduleConfig: (sheetId: string) => getScheduleConfigCache.get(sheetId),
        getRunnerConfig: (sheetId: string) => getRunnerConfigCache.get(sheetId),
        getPlayers: (sheetId: string) => getPlayersCache.get(sheetId),
        getMonitors: (sheetId: string) => getMonitorsCache.get(sheetId),
        getTeams: (sheetId: string) => getTeamsCache.get(sheetId),
        getAllSchedules: (sheetId: string) => getAllSchedulesCache.get(sheetId),
        getDaySchedules: (sheetId: string, day: number) =>
          getDaySchedulesCache.get(Data.struct({ sheetId, day })),
        getChannelSchedules: (sheetId: string, channel: string) =>
          getChannelSchedulesCache.get(Data.struct({ sheetId, channel })),
        getAllFillerSchedules: (sheetId: string) => getAllFillerSchedulesCache.get(sheetId),
        getDayFillerSchedules: (sheetId: string, day: number) =>
          getDayFillerSchedulesCache.get(Data.struct({ sheetId, day })),
        getChannelFillerSchedules: (sheetId: string, channel: string) =>
          getChannelFillerSchedulesCache.get(Data.struct({ sheetId, channel })),
      }),
    ),
  ),
  dependencies: [GoogleSheets.Default, SheetConfigService.Default],
  accessors: true,
}) {}
