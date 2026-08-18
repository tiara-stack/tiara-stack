import { Match, Predicate } from "effect";
import type { CalculationDeclaredFailure } from "sheet-workflow-contracts";
import { cellText, parseLegacyNumber } from "../shared/runnerLocalSheets";
import {
  calculationConfigurationMissing,
  calculationInvalidRequest,
  calculationInvalidRequestCodes,
} from "./failure";
import type {
  CalculationRows,
  CalculationSource,
  CalculationSourceSnapshot,
  CalculationSourceTeam,
} from "./schema";
import { isPersistedCalculationRows } from "./schema";

const maximumCalculationTeamsPerPlayer = 32;
const maximumCalculationConfigurations = 32;

const rowText = (rows: CalculationRows, row: number, column: number): string | undefined =>
  cellText(rows[row]?.[column]);

const upperFirst = (value: string): string =>
  value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;

const normalizePlayerName = (value: string): string =>
  upperFirst(value.replace(/\s+\(e(?:nc)?\)$/iu, ""));

const legacyNumber = (value: unknown): number | undefined =>
  parseLegacyNumber(cellText(value) ?? "");

const quotedRange = (sheetTitle: string, range: string): string =>
  `'${sheetTitle.replaceAll("'", "''")}'!${range}`;

interface TeamConfiguration {
  readonly name: string;
  readonly sheet: string;
  readonly playerNameRange: string;
  readonly teamNameRange: string;
  readonly isv:
    | {
        readonly kind: "split";
        readonly lead: string;
        readonly backline: string;
        readonly talent: string;
      }
    | { readonly kind: "combined"; readonly range: string };
  readonly tags:
    | { readonly kind: "constants"; readonly values: ReadonlyArray<string> }
    | { readonly kind: "ranges"; readonly range: string };
}

type IsvConfiguration = TeamConfiguration["isv"];
type TagsConfiguration = TeamConfiguration["tags"];

const isvDecoders: ReadonlyMap<string, (ranges: string) => IsvConfiguration | undefined> = new Map([
  ["combined", (range: string): IsvConfiguration => ({ kind: "combined" as const, range })],
  [
    "split",
    (ranges: string): IsvConfiguration | undefined => {
      const [lead, backline, talent] = ranges.split(",").map((part) => part.trim());
      return lead && backline && talent
        ? { kind: "split" as const, lead, backline, talent }
        : undefined;
    },
  ],
]);

const tagsDecoders: ReadonlyMap<
  string,
  (value: string | undefined) => TagsConfiguration | undefined
> = new Map([
  [
    "constants",
    (value: string | undefined): TagsConfiguration => ({
      kind: "constants" as const,
      values: (value ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    }),
  ],
  [
    "ranges",
    (value: string | undefined): TagsConfiguration | undefined =>
      Predicate.isNotUndefined(value) ? { kind: "ranges" as const, range: value } : undefined,
  ],
]);

const teamConfigurations = (rows: CalculationRows): ReadonlyArray<TeamConfiguration> =>
  rows.flatMap(
    // The row parser mirrors the Apps Script table grammar; each branch is a legacy shape.
    // fallow-ignore-next-line complexity
    (row) => {
      const name = cellText(row[0]);
      const sheet = cellText(row[1]);
      const playerNameRange = cellText(row[2]);
      const teamNameRange = cellText(row[3]);
      const isvType = cellText(row[4]);
      const isvRanges = cellText(row[5]);
      const tagsType = cellText(row[6]);
      const tagsValue = cellText(row[7]);
      if (
        Predicate.isUndefined(name) ||
        Predicate.isUndefined(sheet) ||
        Predicate.isUndefined(playerNameRange) ||
        Predicate.isUndefined(teamNameRange) ||
        Predicate.isUndefined(isvType) ||
        Predicate.isUndefined(isvRanges) ||
        Predicate.isUndefined(tagsType)
      ) {
        return [];
      }
      const isv = isvDecoders.get(isvType)?.(isvRanges);
      const tags = tagsDecoders.get(tagsType)?.(tagsValue);
      return Predicate.isUndefined(isv) || Predicate.isUndefined(tags)
        ? []
        : [{ name, sheet, playerNameRange, teamNameRange, isv, tags }];
    },
  );

interface TeamReadIndexes {
  readonly configuration: TeamConfiguration;
  readonly playerName: number;
  readonly teamName: number | undefined;
  readonly lead: number | undefined;
  readonly backline: number | undefined;
  readonly talent: number | undefined;
  readonly combined: number | undefined;
  readonly tags: number | undefined;
}

export interface CalculationSourceReadPlan {
  readonly ranges: ReadonlyArray<string>;
  readonly playerIds: number;
  readonly playerNames: number;
  readonly teams: ReadonlyArray<TeamReadIndexes>;
  readonly configurationOverflow: boolean;
}

export const makeCalculationSourceReadPlan = (
  rangesRows: CalculationRows,
  configurationRows: CalculationRows,
): CalculationSourceReadPlan | undefined => {
  const allConfigurations = teamConfigurations(configurationRows);
  const configurations = allConfigurations.slice(0, maximumCalculationConfigurations);
  if (configurations.length === 0) return undefined;
  const entries = new Map<string, string>();
  for (const row of rangesRows) {
    const key = cellText(row[0]);
    const value = cellText(row[1]);
    if (Predicate.isNotUndefined(key) && Predicate.isNotUndefined(value)) entries.set(key, value);
  }
  const userIds = entries.get("User IDs");
  const userNames = entries.get("User Sheet Names");
  if (Predicate.isUndefined(userIds) || Predicate.isUndefined(userNames)) return undefined;
  const ranges: Array<string> = [];
  const add = (range: string): number => {
    const index = ranges.length;
    ranges.push(range);
    return index;
  };
  const playerIds = add(userIds);
  const playerNames = add(userNames);
  const teams = configurations.map((configuration): TeamReadIndexes => {
    const playerName = add(quotedRange(configuration.sheet, configuration.playerNameRange));
    const teamName =
      configuration.teamNameRange === "auto"
        ? undefined
        : add(quotedRange(configuration.sheet, configuration.teamNameRange));
    const isv = Match.value(configuration.isv).pipe(
      Match.discriminatorsExhaustive("kind")({
        split: (isv) => ({
          lead: add(quotedRange(configuration.sheet, isv.lead)),
          backline: add(quotedRange(configuration.sheet, isv.backline)),
          talent: add(quotedRange(configuration.sheet, isv.talent)),
          combined: undefined,
        }),
        combined: (isv) => ({
          lead: undefined,
          backline: undefined,
          talent: undefined,
          combined: add(quotedRange(configuration.sheet, isv.range)),
        }),
      }),
    );
    return {
      configuration,
      playerName,
      teamName,
      ...isv,
      tags: Match.value(configuration.tags).pipe(
        Match.discriminatorsExhaustive("kind")({
          ranges: (tags) => add(quotedRange(configuration.sheet, tags.range)),
          constants: () => undefined,
        }),
      ),
    };
  });
  return {
    ranges,
    playerIds,
    playerNames,
    teams,
    configurationOverflow: allConfigurations.length > maximumCalculationConfigurations,
  };
};

const rowsAt = (
  valueRanges: ReadonlyArray<CalculationRows>,
  index: number | undefined,
): CalculationRows => (Predicate.isUndefined(index) ? [] : (valueRanges[index] ?? []));

// The row zipper deliberately validates every optional legacy column before admitting a team.
// fallow-ignore-next-line complexity
const teamRows = (
  indexes: TeamReadIndexes,
  valueRanges: ReadonlyArray<CalculationRows>,
): ReadonlyArray<CalculationSourceTeam> => {
  const playerNames = rowsAt(valueRanges, indexes.playerName);
  const teamNames = rowsAt(valueRanges, indexes.teamName);
  const leads = rowsAt(valueRanges, indexes.lead);
  const backlines = rowsAt(valueRanges, indexes.backline);
  const talents = rowsAt(valueRanges, indexes.talent);
  const combined = rowsAt(valueRanges, indexes.combined);
  const tags = rowsAt(valueRanges, indexes.tags);
  const rowCount = Math.max(
    playerNames.length,
    teamNames.length,
    leads.length,
    backlines.length,
    talents.length,
    combined.length,
    tags.length,
  );
  const result: Array<CalculationSourceTeam> = [];
  for (let index = 0; index < rowCount; index++) {
    const originalPlayerName = rowText(playerNames, index, 0);
    const normalizedPlayerName = Predicate.isUndefined(originalPlayerName)
      ? undefined
      : normalizePlayerName(originalPlayerName);
    const teamName =
      indexes.configuration.teamNameRange === "auto"
        ? Predicate.isUndefined(originalPlayerName)
          ? undefined
          : `${originalPlayerName} | ${indexes.configuration.name}`
        : rowText(teamNames, index, 0);
    const combinedValues = rowText(combined, index, 0)
      ?.split("/")
      .map((part) => part.trim());
    const lead = legacyNumber(
      Predicate.isNotUndefined(indexes.combined) ? combinedValues?.[0] : leads[index]?.[0],
    );
    const backline = legacyNumber(
      Predicate.isNotUndefined(indexes.combined) ? combinedValues?.[1] : backlines[index]?.[0],
    );
    const talent = legacyNumber(
      Predicate.isNotUndefined(indexes.combined) ? combinedValues?.[2] : talents[index]?.[0],
    );
    if (
      Predicate.isUndefined(normalizedPlayerName) ||
      Predicate.isUndefined(teamName) ||
      Predicate.isUndefined(lead) ||
      Predicate.isUndefined(backline)
    ) {
      continue;
    }
    result.push({
      type: indexes.configuration.name,
      playerId: null,
      playerName: normalizedPlayerName,
      teamName,
      tags:
        indexes.configuration.tags.kind === "constants"
          ? [...indexes.configuration.tags.values]
          : (rowText(tags, index, 0) ?? "")
              .split(",")
              .map((tag) => tag.trim())
              .filter((tag) => tag.length > 0),
      lead,
      backline,
      talent: talent ?? null,
    });
  }
  return result;
};

const playersWithTeams = (
  requestedNames: ReadonlyArray<string>,
  plan: CalculationSourceReadPlan,
  valueRanges: ReadonlyArray<CalculationRows>,
): {
  readonly players: ReadonlyArray<CalculationSource["players"][number]>;
  readonly duplicatePlayerNames: boolean;
  readonly missingPlayerNames: boolean;
  readonly exceeded: boolean;
} => {
  const idRows = rowsAt(valueRanges, plan.playerIds);
  const nameRows = rowsAt(valueRanges, plan.playerNames);
  const playersByName = new Map<string, Array<{ readonly id: string; readonly name: string }>>();
  let duplicatePlayerNames = false;
  for (let index = 0; index < Math.max(idRows.length, nameRows.length); index++) {
    const id = rowText(idRows, index, 0);
    const rawName = rowText(nameRows, index, 0);
    if (Predicate.isUndefined(id) || Predicate.isUndefined(rawName)) continue;
    const name = normalizePlayerName(rawName);
    const existingPlayers = playersByName.get(name);
    if (Predicate.isUndefined(existingPlayers)) {
      playersByName.set(name, [{ id, name }]);
    } else {
      existingPlayers.push({ id, name });
    }
  }
  const teams = plan.teams.flatMap((indexes) => teamRows(indexes, valueRanges));
  const teamsByPlayerName = new Map<string, Array<CalculationSourceTeam>>();
  for (const team of teams) {
    if (Predicate.isNull(team.playerName)) continue;
    const playerTeams = teamsByPlayerName.get(team.playerName);
    if (Predicate.isUndefined(playerTeams)) {
      teamsByPlayerName.set(team.playerName, [team]);
    } else {
      playerTeams.push(team);
    }
  }
  let exceeded = false;
  let missingPlayerNames = false;
  const players = requestedNames.map((requestedName) => {
    const normalizedName = normalizePlayerName(requestedName);
    const matchingPlayers = playersByName.get(normalizedName) ?? [];
    if (matchingPlayers.length > 1) duplicatePlayerNames = true;
    if (matchingPlayers.length === 0) missingPlayerNames = true;
    const player = matchingPlayers[0];
    const matchingTeams = Predicate.isUndefined(player)
      ? []
      : (teamsByPlayerName.get(normalizedName) ?? []).map((team) => ({
          ...team,
          playerId: player.id,
        }));
    if (matchingTeams.length > maximumCalculationTeamsPerPlayer) exceeded = true;
    return {
      name: requestedName,
      teams: matchingTeams.slice(0, maximumCalculationTeamsPerPlayer),
    };
  });
  return { players, duplicatePlayerNames, missingPlayerNames, exceeded };
};

const configurationFailure = (): CalculationDeclaredFailure =>
  calculationConfigurationMissing("spreadsheet.calculationTeams");

type CalculationSourceBase = Pick<
  CalculationSource,
  "sheetId" | "sheetTitle" | "canonicalSheetRef" | "preWriteProjection"
>;

const failedSource = (
  base: CalculationSourceBase,
  requestedNames: ReadonlyArray<string>,
  failure: CalculationDeclaredFailure,
  preWriteProjection = base.preWriteProjection,
): CalculationSource => ({
  ...base,
  preWriteProjection,
  players: requestedNames.map((name) => ({ name, teams: [] })),
  failure,
});

const unconfiguredSource = (
  base: CalculationSourceBase,
  requestedNames: ReadonlyArray<string>,
): CalculationSource => failedSource(base, requestedNames, configurationFailure());

const incompleteSource = (
  base: CalculationSourceBase,
  requestedNames: ReadonlyArray<string>,
): CalculationSource =>
  failedSource(
    base,
    requestedNames,
    calculationInvalidRequest(
      calculationInvalidRequestCodes.incompleteSource,
      "The provider read did not include every configured calculation range",
    ),
  );

const oversizedSource = (
  base: CalculationSourceBase,
  requestedNames: ReadonlyArray<string>,
): CalculationSource =>
  failedSource(
    base,
    requestedNames,
    calculationInvalidRequest(
      calculationInvalidRequestCodes.payloadTooLarge,
      "The calculation projection exceeds the supported persisted payload limit",
    ),
    [],
  );

export const decodeCalculationSource = (
  snapshot: CalculationSourceSnapshot,
  requestedNames: ReadonlyArray<string>,
): CalculationSource => {
  const base: CalculationSourceBase = {
    sheetId: snapshot.sheetId,
    sheetTitle: snapshot.sheetTitle,
    canonicalSheetRef: snapshot.canonicalSheetRef,
    preWriteProjection: snapshot.preWriteProjection,
  };
  if (!isPersistedCalculationRows(snapshot.preWriteProjection)) {
    return oversizedSource(base, requestedNames);
  }
  const plan = makeCalculationSourceReadPlan(snapshot.settingsRows, snapshot.teamConfigurationRows);
  if (Predicate.isUndefined(plan)) return unconfiguredSource(base, requestedNames);
  if (plan.configurationOverflow) {
    return failedSource(
      base,
      requestedNames,
      calculationInvalidRequest(
        calculationInvalidRequestCodes.sourceSearchSpaceTooLarge,
        "The calculation source contains too many team configurations",
      ),
    );
  }
  const ranges = new Map(snapshot.sourceRanges.map(({ range, rows }) => [range, rows]));
  const missingRange = plan.ranges.some((range) => !ranges.has(range));
  if (missingRange) return incompleteSource(base, requestedNames);
  const decoded = playersWithTeams(
    requestedNames,
    plan,
    plan.ranges.map((range) => ranges.get(range) ?? []),
  );
  return {
    ...base,
    players: decoded.players,
    failure: decoded.duplicatePlayerNames
      ? calculationInvalidRequest(
          calculationInvalidRequestCodes.invalidSource,
          "The calculation source contains duplicate player names",
        )
      : decoded.missingPlayerNames
        ? calculationInvalidRequest(
            calculationInvalidRequestCodes.invalidSource,
            "The calculation source does not contain every requested player",
          )
        : decoded.exceeded
          ? calculationInvalidRequest(
              calculationInvalidRequestCodes.sourceSearchSpaceTooLarge,
              "The calculation source exceeds the supported team limit",
            )
          : null,
  };
};
