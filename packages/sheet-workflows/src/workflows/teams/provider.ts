import type { sheets_v4 } from "@googleapis/sheets";
import { Context, Data, Effect, Layer, Match, Option, Predicate, Schema } from "effect";
import {
  cellText,
  commaSeparated,
  firstCell,
  isRetryableRunnerLocalSheetsReadFailure,
  makeRunnerLocalSheetsClient,
  parseKeyValueRows,
  parseLegacyNumber,
  parseSheetIdentities,
  readBatchedSheetsValueRanges,
  readSheetsValueRanges,
  upperFirst,
  type ValueRows,
  ValueRange,
  valueRowsAt,
} from "../shared/runnerLocalSheets";
import type { UserTeamsView } from "./schema";

export class UserTeamsProviderError extends Data.TaggedError("UserTeamsProviderError")<{
  readonly operation: "create-client" | "read-configuration" | "read-user-teams";
  readonly cause: unknown;
}> {}

interface UserTeamsProviderShape {
  readonly load: (spreadsheetId: string) => Effect.Effect<UserTeamsView, UserTeamsProviderError>;
}

export class UserTeamsProvider extends Context.Service<UserTeamsProvider, UserTeamsProviderShape>()(
  "sheet-workflows/UserTeamsProvider",
) {}

const teamConfigRange = "'Thee''s Sheet Settings'!E8:M";
const rangesConfigRange = "'Thee''s Sheet Settings'!B8:C";

const IsvConfiguration = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("split"),
    leadRange: Schema.String,
    backlineRange: Schema.String,
    talentRange: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("combined"),
    isvRange: Schema.String,
  }),
]);
type IsvConfiguration = typeof IsvConfiguration.Type;

const TagsConfiguration = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("constants"),
    tags: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ranges"),
    tagsRange: Schema.String,
  }),
]);
type TagsConfiguration = typeof TagsConfiguration.Type;

const TeamConfiguration = Schema.Struct({
  name: Schema.String,
  sheet: Schema.String,
  playerNameRange: Schema.String,
  teamNameRange: Schema.String,
  isv: IsvConfiguration,
  tags: TagsConfiguration,
});
type TeamConfiguration = typeof TeamConfiguration.Type;

interface DroppedTeamConfiguration {
  readonly rowIndex: number;
  readonly invalidFields: ReadonlyArray<string>;
}

interface ParsedTeamConfigurations {
  readonly configurations: ReadonlyArray<TeamConfiguration>;
  readonly dropped: ReadonlyArray<DroppedTeamConfiguration>;
}

interface ParsedTeamConfigurationRow {
  readonly configuration: TeamConfiguration | undefined;
  readonly dropped: DroppedTeamConfiguration | undefined;
}

const parseIsvConfiguration = (
  type: string | undefined,
  ranges: string | undefined,
): Option.Option<IsvConfiguration> =>
  Match.value(type).pipe(
    Match.when("split", () => {
      const [leadRange, backlineRange, talentRange] = commaSeparated(ranges);
      return { _tag: "split", leadRange, backlineRange, talentRange };
    }),
    Match.when("combined", () => ({ _tag: "combined", isvRange: ranges })),
    Match.orElse(() => undefined),
    Schema.decodeUnknownOption(IsvConfiguration),
  );

const parseTagsConfiguration = (
  type: string | undefined,
  tags: string | undefined,
): Option.Option<TagsConfiguration> =>
  Match.value(type).pipe(
    Match.when("constants", () => ({ _tag: "constants", tags: commaSeparated(tags) })),
    Match.when("ranges", () => ({ _tag: "ranges", tagsRange: tags })),
    Match.orElse(() => undefined),
    Schema.decodeUnknownOption(TagsConfiguration),
  );

const parseTeamConfigurations = (rows: ValueRows): Effect.Effect<ParsedTeamConfigurations> =>
  Effect.forEach(rows, (row, rowIndex): Effect.Effect<ParsedTeamConfigurationRow> => {
    const name = cellText(row[0]);
    const sheet = cellText(row[1]);
    const playerNameRange = cellText(row[2]);
    const teamNameRange = cellText(row[3]);
    const isv = Option.getOrUndefined(parseIsvConfiguration(cellText(row[4]), cellText(row[5])));
    const tags = Option.getOrUndefined(parseTagsConfiguration(cellText(row[6]), cellText(row[7])));
    if (row.every((cell) => Predicate.isUndefined(cellText(cell)))) {
      return Effect.succeed<ParsedTeamConfigurationRow>({
        configuration: undefined,
        dropped: undefined,
      });
    }
    const invalidFields = [
      ["name", name],
      ["sheet", sheet],
      ["playerNameRange", playerNameRange],
      ["teamNameRange", teamNameRange],
      ["isv", isv],
      ["tags", tags],
    ].flatMap(([field, value]) => (Predicate.isUndefined(value) ? [field as string] : []));
    if (invalidFields.length > 0) {
      return Effect.succeed<ParsedTeamConfigurationRow>({
        configuration: undefined,
        dropped: { rowIndex, invalidFields },
      });
    }
    return Schema.decodeUnknownEffect(TeamConfiguration)({
      name,
      sheet,
      playerNameRange,
      teamNameRange,
      isv,
      tags,
    }).pipe(
      Effect.map(
        (configuration): ParsedTeamConfigurationRow => ({
          configuration,
          dropped: undefined,
        }),
      ),
      Effect.catch(() =>
        Effect.succeed<ParsedTeamConfigurationRow>({
          configuration: undefined,
          dropped: { rowIndex, invalidFields: ["configuration"] },
        }),
      ),
    );
  }).pipe(
    Effect.map((results) => ({
      configurations: results.flatMap(({ configuration }) =>
        Predicate.isUndefined(configuration) ? [] : [configuration],
      ),
      dropped: results.flatMap(({ dropped }) => (Predicate.isUndefined(dropped) ? [] : [dropped])),
    })),
  );

interface TeamRangeIndexes {
  readonly playerName: number;
  readonly teamName: number | undefined;
  readonly lead: number | undefined;
  readonly backline: number | undefined;
  readonly talent: number | undefined;
  readonly isv: number | undefined;
  readonly tags: number | undefined;
}

interface UserTeamsRangePlan {
  readonly ranges: ReadonlyArray<string>;
  readonly teamIndexes: ReadonlyArray<TeamRangeIndexes>;
  readonly playerIds: number;
  readonly playerNames: number;
}

const quotedRange = (configuration: TeamConfiguration, range: string): string =>
  `'${configuration.sheet.replaceAll("'", "''")}'!${range}`;

const makeUserTeamsRangePlan = (
  configurations: ReadonlyArray<TeamConfiguration>,
  playerRanges: { readonly ids: string; readonly names: string },
): UserTeamsRangePlan => {
  const ranges: Array<string> = [];
  const add = (range: string) => {
    const index = ranges.length;
    ranges.push(range);
    return index;
  };
  const teamIndexes = configurations.map((configuration): TeamRangeIndexes => {
    const playerName = add(quotedRange(configuration, configuration.playerNameRange));
    const teamName =
      configuration.teamNameRange === "auto"
        ? undefined
        : add(quotedRange(configuration, configuration.teamNameRange));
    const isvIndexes = Match.value(configuration.isv).pipe(
      Match.discriminatorsExhaustive("_tag")({
        split: (isv) => ({
          lead: add(quotedRange(configuration, isv.leadRange)),
          backline: add(quotedRange(configuration, isv.backlineRange)),
          talent: add(quotedRange(configuration, isv.talentRange)),
          isv: undefined,
        }),
        combined: (isv) => ({
          lead: undefined,
          backline: undefined,
          talent: undefined,
          isv: add(quotedRange(configuration, isv.isvRange)),
        }),
      }),
    );
    return {
      playerName,
      teamName,
      ...isvIndexes,
      tags: Match.value(configuration.tags).pipe(
        Match.discriminatorsExhaustive("_tag")({
          constants: () => undefined,
          ranges: ({ tagsRange }) => add(quotedRange(configuration, tagsRange)),
        }),
      ),
    };
  });
  return {
    ranges,
    teamIndexes,
    playerIds: add(playerRanges.ids),
    playerNames: add(playerRanges.names),
  };
};

const playerNamePattern = /^(?<name>.*?)\s+(?<enc>\(e(?:nc)?\))?$/u;

const parseCombinedIsv = (value: string | undefined) => {
  const [lead, backline, talent] = Predicate.isUndefined(value)
    ? []
    : value.split("/").map((part) => parseLegacyNumber(part.trim()));
  return { lead, backline, talent };
};

interface TeamValueRows {
  readonly player: ValueRows;
  readonly team: ValueRows;
  readonly lead: ValueRows;
  readonly backline: ValueRows;
  readonly talent: ValueRows;
  readonly isv: ValueRows;
  readonly tags: ValueRows;
}

const playerNameFrom = (rawPlayerName: string | undefined): string | undefined =>
  Predicate.isUndefined(rawPlayerName)
    ? undefined
    : upperFirst(playerNamePattern.exec(rawPlayerName)?.groups?.name ?? rawPlayerName);

const teamNameFrom = (
  configuration: TeamConfiguration,
  rows: TeamValueRows,
  rowIndex: number,
  rawPlayerName: string | undefined,
): string | undefined =>
  configuration.teamNameRange === "auto"
    ? Predicate.isUndefined(rawPlayerName)
      ? undefined
      : `${rawPlayerName} | ${configuration.name}`
    : firstCell(rows.team, rowIndex);

const isvFrom = (configuration: TeamConfiguration, rows: TeamValueRows, rowIndex: number) =>
  Match.value(configuration.isv).pipe(
    Match.discriminatorsExhaustive("_tag")({
      split: () => ({
        lead: parseLegacyNumber(firstCell(rows.lead, rowIndex)),
        backline: parseLegacyNumber(firstCell(rows.backline, rowIndex)),
        talent: parseLegacyNumber(firstCell(rows.talent, rowIndex)),
      }),
      combined: () => parseCombinedIsv(firstCell(rows.isv, rowIndex)),
    }),
  );

const tagsFrom = (configuration: TeamConfiguration, rows: TeamValueRows, rowIndex: number) =>
  Match.value(configuration.tags).pipe(
    Match.discriminatorsExhaustive("_tag")({
      constants: ({ tags }) => tags,
      ranges: () => commaSeparated(firstCell(rows.tags, rowIndex)),
    }),
  );

const parseConfiguredTeamRow = (
  configuration: TeamConfiguration,
  rows: TeamValueRows,
  rowIndex: number,
): UserTeamsView["teams"][number] | undefined => {
  const rawPlayerName = firstCell(rows.player, rowIndex);
  const playerName = playerNameFrom(rawPlayerName);
  const teamName = teamNameFrom(configuration, rows, rowIndex, rawPlayerName);
  const isv = isvFrom(configuration, rows, rowIndex);
  return Predicate.isNotUndefined(playerName) &&
    Predicate.isNotUndefined(teamName) &&
    Predicate.isNotUndefined(isv.lead) &&
    Predicate.isNotUndefined(isv.backline)
    ? {
        playerName,
        teamName,
        tags: tagsFrom(configuration, rows, rowIndex),
        lead: isv.lead,
        backline: isv.backline,
        talent: isv.talent ?? null,
      }
    : undefined;
};

const parseConfiguredTeams = (
  configuration: TeamConfiguration,
  indexes: TeamRangeIndexes,
  valueRanges: ReadonlyArray<typeof ValueRange.Type>,
): UserTeamsView["teams"] => {
  const rows = {
    player: valueRowsAt(valueRanges, indexes.playerName),
    team: valueRowsAt(valueRanges, indexes.teamName),
    lead: valueRowsAt(valueRanges, indexes.lead),
    backline: valueRowsAt(valueRanges, indexes.backline),
    talent: valueRowsAt(valueRanges, indexes.talent),
    isv: valueRowsAt(valueRanges, indexes.isv),
    tags: valueRowsAt(valueRanges, indexes.tags),
  } satisfies TeamValueRows;
  const rowCount = Math.max(...Object.values(rows).map(({ length }) => length));
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    parseConfiguredTeamRow(configuration, rows, rowIndex),
  ).filter(Predicate.isNotUndefined);
};

const parsePlayerRanges = (rows: ValueRows) =>
  Effect.gen(function* () {
    const entries = parseKeyValueRows(rows);
    return {
      ids: yield* Schema.decodeUnknownEffect(
        Schema.String.annotate({ message: "The User IDs range configuration is missing" }),
      )(entries.get("User IDs")),
      names: yield* Schema.decodeUnknownEffect(
        Schema.String.annotate({ message: "The User Sheet Names range configuration is missing" }),
      )(entries.get("User Sheet Names")),
    };
  });

export const isRetryableUserTeamsReadFailure = ({ cause }: UserTeamsProviderError): boolean =>
  isRetryableRunnerLocalSheetsReadFailure({ cause });

const makeProviderError = (operation: UserTeamsProviderError["operation"]) => (cause: unknown) =>
  new UserTeamsProviderError({ operation, cause });

export const makeUserTeamsProvider = (client: sheets_v4.Sheets): UserTeamsProviderShape => ({
  load: (spreadsheetId) =>
    Effect.gen(function* () {
      const configurationRanges = yield* readSheetsValueRanges({
        client,
        spreadsheetId,
        ranges: [teamConfigRange, rangesConfigRange],
        makeError: makeProviderError("read-configuration"),
      });
      const parsed = yield* Effect.all({
        teamConfigurationResult: parseTeamConfigurations(valueRowsAt(configurationRanges, 0)),
        playerRanges: parsePlayerRanges(valueRowsAt(configurationRanges, 1)),
      }).pipe(Effect.mapError(makeProviderError("read-configuration")));
      yield* Effect.forEach(
        parsed.teamConfigurationResult.dropped,
        ({ invalidFields, rowIndex }) =>
          Effect.logWarning("Ignoring malformed team configuration").pipe(
            Effect.annotateLogs({
              invalidFields: invalidFields.join(","),
              row: rowIndex + 8,
            }),
          ),
        { discard: true },
      );
      const configurations = parsed.teamConfigurationResult.configurations;
      const plan = makeUserTeamsRangePlan(configurations, parsed.playerRanges);
      const teamRanges = yield* readBatchedSheetsValueRanges({
        client,
        spreadsheetId,
        ranges: plan.ranges,
        makeError: makeProviderError("read-user-teams"),
      });
      return {
        players: parseSheetIdentities(
          valueRowsAt(teamRanges, plan.playerIds),
          valueRowsAt(teamRanges, plan.playerNames),
        ),
        teams: configurations.flatMap((configuration, index) =>
          parseConfiguredTeams(configuration, plan.teamIndexes[index]!, teamRanges),
        ),
      };
    }),
});

export const userTeamsProviderLayer = Layer.effect(
  UserTeamsProvider,
  makeRunnerLocalSheetsClient(makeProviderError("create-client")).pipe(
    Effect.map(makeUserTeamsProvider),
  ),
);
