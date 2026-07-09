import { Effect, Exit, Layer, Match, Option, Predicate, Semaphore, String, pipe } from "effect";
import type { RangesConfig, TeamConfig } from "sheet-ingress-api/schemas/sheetConfig";
import {
  MessageTeamSubmission,
  ParsedOshi,
  ParsedTeamEntry,
  TeamSubmissionConfirmFromDiscordPayload,
  TeamSubmissionConfirmResult,
  TeamSubmissionRevertFromDiscordPayload,
  TeamSubmissionRevertResult,
  TeamSubmissionRollbackSnapshot,
  TeamSubmissionRollbackSnapshotEntry,
  TeamSubmissionSkippedEntry,
  TeamSubmissionRowMapping,
  TeamSubmissionSetConfirmationPayload,
  TeamSubmissionUpsertFromDiscordPayload,
  TeamSubmissionUpsertResult,
} from "sheet-ingress-api/schemas/teamSubmission";
import type { WorkspaceTeamSubmissionChannel } from "sheet-ingress-api/schemas/workspaceConfig";
import { makeArgumentError } from "typhoon-core/error";
import { Context } from "effect";
import { GoogleSheets } from "./google/sheets";
import { SheetConfigService } from "./sheetConfig";
import { SheetZeroClient } from "./sheetZeroClient";
import { WorkspaceConfigService } from "./workspaceConfig";

type A1Cell = {
  readonly sheet: string;
  readonly column: string;
  readonly row: number;
};

type SheetValueUpdate = {
  readonly range: string;
  readonly values: string[][];
};

type TeamSubmissionRowTarget = {
  readonly rowIndex: number;
  readonly playerNameRange: string;
  readonly teamNameRange: string;
  readonly oshiRange: string | null;
};

type ProcessedTeamSubmissionEntry = {
  readonly entry: ParsedTeamEntry;
  readonly mapping: TeamSubmissionRowMapping;
  readonly updates: ReadonlyArray<SheetValueUpdate>;
};

type SkippedTeamSubmissionEntry = typeof TeamSubmissionSkippedEntry.Type;

type ProcessedTeamSubmissionResult =
  | { readonly _tag: "registered"; readonly entry: ProcessedTeamSubmissionEntry }
  | { readonly _tag: "skipped"; readonly entry: SkippedTeamSubmissionEntry };

const isProcessedResult =
  <Tag extends ProcessedTeamSubmissionResult["_tag"]>(tag: Tag) =>
  (
    entry: ProcessedTeamSubmissionResult,
  ): entry is Extract<ProcessedTeamSubmissionResult, { readonly _tag: Tag }> =>
    Predicate.isTagged(tag)(entry);

type TeamConfigLookup = {
  readonly config: TeamConfig;
  readonly tags: ReadonlyArray<string>;
  readonly oshis: ReadonlyArray<string>;
};

type SubmissionLockEntry = {
  readonly semaphore: Semaphore.Semaphore;
  active: number;
};

const actionableSubmissionStatuses = new Set<MessageTeamSubmission["status"]>([
  "registered",
  "updated",
]);
const editableSubmissionStatuses = new Set<MessageTeamSubmission["status"]>([
  "registered",
  "updated",
  "empty",
]);

const requireSubmissionStatus = (
  submission: MessageTeamSubmission,
  allowedStatuses: ReadonlySet<MessageTeamSubmission["status"]>,
) =>
  allowedStatuses.has(submission.status)
    ? Effect.void
    : Effect.fail(
        makeArgumentError(`Team submission is already ${submission.status} and cannot be changed`),
      );

const requireActionableSubmission = (submission: MessageTeamSubmission) =>
  requireSubmissionStatus(submission, actionableSubmissionStatuses);

const requireEditableSubmission = (submission: MessageTeamSubmission) =>
  requireSubmissionStatus(submission, editableSubmissionStatuses);

const a1RangeRegex = /^'?(?<sheet>[^'!]+)'?!\s*(?<column>[A-Z]+)(?<row>\d+)/i;

const parseA1Start = (range: string): A1Cell | null => {
  const match = a1RangeRegex.exec(range.trim());
  const groups = match?.groups;
  if (!groups?.sheet || !groups.column || !groups.row) {
    return null;
  }

  return { sheet: groups.sheet, column: groups.column.toUpperCase(), row: Number(groups.row) };
};

const cellForRow = (range: string, row: number) => {
  const start = parseA1Start(range);
  return start === null ? null : `'${start.sheet}'!${start.column}${row}`;
};

const columnToNumber = (column: string) =>
  column
    .toUpperCase()
    .split("")
    .reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);

const numberToColumn = (value: number) => {
  let remaining = value;
  let column = "";
  while (remaining > 0) {
    const mod = (remaining - 1) % 26;
    column = globalThis.String.fromCharCode(65 + mod) + column;
    remaining = Math.floor((remaining - mod) / 26);
  }
  return column;
};

const appendRangeForCells = (
  playerNameRange: string,
  teamNameRange: string,
  oshiRange: string | null,
) => {
  const cells = [
    ["playerColumn", parseA1Start(playerNameRange)],
    ["teamColumn", parseA1Start(teamNameRange)],
    ...(oshiRange === null ? [] : ([["oshiColumn", parseA1Start(oshiRange)]] as const)),
  ] as const;
  if (cells.some(([, cell]) => cell === null)) {
    return null;
  }
  const parsedCells = cells as ReadonlyArray<
    readonly ["playerColumn" | "teamColumn" | "oshiColumn", A1Cell]
  >;
  const sheet = parsedCells[0]?.[1].sheet;
  if (!sheet || parsedCells.some(([, cell]) => cell.sheet !== sheet)) {
    return null;
  }

  const columns = parsedCells.map(([key, cell]) => [key, columnToNumber(cell.column)] as const);
  const uniqueColumns = new Set(columns.map(([, column]) => column));
  if (uniqueColumns.size !== columns.length) {
    return null;
  }
  const startColumn = Math.min(...columns.map(([, column]) => column));
  const endColumn = Math.max(...columns.map(([, column]) => column));
  const columnMap = Object.fromEntries(columns) as {
    readonly playerColumn: number;
    readonly teamColumn: number;
    readonly oshiColumn?: number;
  };

  return {
    range: `'${sheet}'!${numberToColumn(startColumn)}:${numberToColumn(endColumn)}`,
    startColumn,
    endColumn,
    playerColumn: columnMap.playerColumn,
    teamColumn: columnMap.teamColumn,
    oshiColumn: columnMap.oshiColumn ?? null,
  };
};

type AppendRangeForCells = NonNullable<ReturnType<typeof appendRangeForCells>>;

const appendRowValues = (
  appendRange: AppendRangeForCells,
  entry: ParsedTeamEntry,
  oshi: ParsedOshi,
) => {
  const row = new globalThis.Array<string>(
    appendRange.endColumn - appendRange.startColumn + 1,
  ).fill("");
  row[appendRange.playerColumn - appendRange.startColumn] = entry.playerName;
  row[appendRange.teamColumn - appendRange.startColumn] = entry.teamName;
  if (appendRange.oshiColumn !== null) {
    row[appendRange.oshiColumn - appendRange.startColumn] = oshi.value ?? "";
  }
  return row;
};

const appendedRowTarget = ({
  rowIndex,
  playerNameRange,
  teamNameRange,
  oshiRange,
}: {
  readonly rowIndex: number;
  readonly playerNameRange: string;
  readonly teamNameRange: string;
  readonly oshiRange: string | null;
}): TeamSubmissionRowTarget | null => {
  const appendedPlayerNameRange = cellForRow(playerNameRange, rowIndex);
  const appendedTeamNameRange = cellForRow(teamNameRange, rowIndex);
  const appendedOshiRange = oshiRange === null ? null : cellForRow(oshiRange, rowIndex);
  if (
    appendedPlayerNameRange === null ||
    appendedTeamNameRange === null ||
    (oshiRange !== null && appendedOshiRange === null)
  ) {
    return null;
  }

  return {
    rowIndex,
    playerNameRange: appendedPlayerNameRange,
    teamNameRange: appendedTeamNameRange,
    oshiRange: appendedOshiRange,
  };
};

const appendedRowIndex = (updatedRange: string | null | undefined) => {
  const start = updatedRange ? parseA1Start(updatedRange) : null;
  return start?.row ?? null;
};

const optionString = (value: Option.Option<string>) => Option.getOrUndefined(value);

const optionArray = <A>(value: Option.Option<ReadonlyArray<A>>) =>
  Option.getOrElse(value, () => [] as ReadonlyArray<A>);

const sourceMessageRef = (payload: TeamSubmissionUpsertFromDiscordPayload) => ({
  conversation: {
    workspace: {
      client: payload.client,
      workspaceId: payload.workspaceId,
    },
    conversationId: payload.conversationId,
  },
  messageId: payload.messageId,
});

const sourceMessageUrl = (payload: TeamSubmissionUpsertFromDiscordPayload) =>
  `https://discord.com/channels/${payload.workspaceId}/${payload.conversationId}/${payload.messageId}`;

type SubmissionLockPayload = {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly messageId: string;
};

const submissionLockKey = (payload: SubmissionLockPayload) =>
  [payload.workspaceId, payload.conversationId, payload.messageId].join(":");

const normalizeLine = (line: string) => line.trim().replace(/\s+/g, " ");

const normalizeSectionAlias = (value: string) =>
  value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

const teamTypeAliases = {
  fullFill: ["fullFill", "full fill", "fullfill", "fill", "ff"],
  heal: ["heal", "healer"],
  encore: ["encore", "enc"],
  alt: ["alt", "alts", "alternative"],
} as const;

type ParsedLine = {
  readonly type: ParsedTeamEntry["teamType"];
  readonly teamName: string;
  readonly notes: ReadonlyArray<string>;
};

const sectionAliasLookup = new Map<string, ParsedTeamEntry["teamType"]>(
  Object.entries(teamTypeAliases).flatMap(([type, aliases]) =>
    aliases.map((alias) => [normalizeSectionAlias(alias), type as ParsedTeamEntry["teamType"]]),
  ),
);

const lineType = (label: string): ParsedTeamEntry["teamType"] | null =>
  sectionAliasLookup.get(normalizeSectionAlias(label)) ?? null;

const parentheticalNotes = (value: string) =>
  [...value.matchAll(/\(([^)]+)\)/g)].map((match) => match[1]?.trim()).filter(Predicate.isString);

const splitFullFillOptions = (value: string) =>
  value
    .split(/\s+(?:or|\/or)\s+|;\s*/i)
    .map(normalizeLine)
    .filter(String.isNonEmpty);

const teamTypeLabels: Record<ParsedTeamEntry["teamType"], ReadonlyArray<string>> = teamTypeAliases;

const inferredTypes = ["fullFill", "heal", "encore"] as const;

type ParsedSubmissionLine =
  | {
      readonly _tag: "oshi";
      readonly value: string;
      readonly inferredIndex: number;
    }
  | {
      readonly _tag: "teams";
      readonly lines: ReadonlyArray<ParsedLine>;
      readonly inferredIndex: number;
    };

const parsedLinesForValue = (type: ParsedTeamEntry["teamType"], value: string) =>
  (type === "fullFill" ? splitFullFillOptions(value) : [value]).map((teamName) => ({
    type,
    teamName,
    notes: parentheticalNotes(teamName),
  }));

const parseSubmissionLine = (line: string, inferredIndex: number): ParsedSubmissionLine => {
  const colonIndex = line.indexOf(":");
  const label = colonIndex >= 0 ? line.slice(0, colonIndex).trim() : "";
  const value = colonIndex >= 0 ? line.slice(colonIndex + 1).trim() : line;
  if (label.toLowerCase() === "oshi") {
    return { _tag: "oshi", value, inferredIndex };
  }

  const explicitType = colonIndex >= 0 ? lineType(label) : null;
  const type = explicitType ?? inferredTypes[Math.min(inferredIndex, inferredTypes.length - 1)];
  return {
    _tag: "teams",
    lines: parsedLinesForValue(type, value),
    inferredIndex: explicitType === null ? inferredIndex + 1 : inferredIndex,
  };
};

const entrySuffix = (line: ParsedLine, index: number, totalFullFill: number) => {
  if (line.type === "alt") {
    return ` (alt ${index})`;
  }
  if (line.type === "fullFill" && totalFullFill > 1) {
    return ` (full fill ${index})`;
  }
  return "";
};

const parsedEntryFromLine = (
  line: ParsedLine,
  index: number,
  totalFullFill: number,
  basePlayerName: string,
  oshiCandidate: string | null,
) =>
  ({
    stableKey: `${line.type}:${index}`,
    playerName: `${basePlayerName}${entrySuffix(line, index, totalFullFill)}`,
    teamName: line.teamName,
    teamType: line.type,
    notes: [...line.notes],
    teamConfigName: null,
    oshi: { candidate: oshiCandidate, value: null, status: "notConfigured" },
  }) satisfies ParsedTeamEntry;

export const parseTeamSubmissionMessage = (
  content: string,
  basePlayerName: string,
): {
  readonly entries: ReadonlyArray<ParsedTeamEntry>;
  readonly oshiCandidate: string | null;
} => {
  const rawLines = content.split(/\r?\n/).map(normalizeLine).filter(String.isNonEmpty);
  let inferredIndex = 0;
  const parsedLines: ParsedLine[] = [];
  let oshiCandidate: string | null = null;

  for (const line of rawLines) {
    const result = parseSubmissionLine(line, inferredIndex);
    inferredIndex = result.inferredIndex;
    if (result._tag === "oshi") {
      oshiCandidate = result.value;
      continue;
    }
    parsedLines.push(...result.lines);
  }

  const typeCounts = new Map<ParsedTeamEntry["teamType"], number>();
  const totalFullFill = parsedLines.filter((line) => line.type === "fullFill").length;
  const entries = parsedLines.map((line) => {
    const index = (typeCounts.get(line.type) ?? 0) + 1;
    typeCounts.set(line.type, index);
    return parsedEntryFromLine(line, index, totalFullFill, basePlayerName, oshiCandidate);
  });

  return { entries, oshiCandidate };
};

const flattenRangeValues = (range: { readonly values?: unknown[][] | null }) =>
  range.values
    ?.flat()
    .filter(Predicate.isString)
    .map((value) => value.trim()) ?? [];

const tagMatchesEntry = (tag: string, entry: ParsedTeamEntry) => {
  const normalizedTag = tag.toLowerCase().trim();
  const labels = teamTypeLabels[entry.teamType].map((label) => label.toLowerCase());
  const notes = entry.notes.map((note) => note.toLowerCase());
  const teamName = entry.teamName.toLowerCase();

  return (
    labels.includes(normalizedTag) ||
    notes.includes(normalizedTag) ||
    (String.isNonEmpty(normalizedTag) && teamName.includes(normalizedTag))
  );
};

const isUsableTeamConfig = (config: TeamConfig) =>
  Option.isSome(config.name) &&
  Option.isSome(config.sheet) &&
  Option.isSome(config.playerNameRange);

const chooseNamedTeamConfig = (
  teamConfigs: ReadonlyArray<TeamConfigLookup>,
  destinationTeamConfigName: Option.Option<string>,
) => {
  const named = Option.getOrUndefined(destinationTeamConfigName);
  const configs = teamConfigs.filter(({ config }) => isUsableTeamConfig(config));
  return named ? (configs.find(({ config }) => Option.contains(config.name, named)) ?? null) : null;
};

const existingMappingByKey = (submission: Option.Option<MessageTeamSubmission>) =>
  new Map(
    optionArray(
      pipe(
        submission,
        Option.map((value) => value.rowMappings),
      ),
    ).map((mapping) => [mapping.stableKey, mapping] as const),
  );

const existingTeamKeys = (submission: Option.Option<MessageTeamSubmission>) =>
  new Set(
    optionArray(
      pipe(
        submission,
        Option.map((value) => value.rowMappings),
      ),
    ).map((mapping) => mapping.stableKey),
  );

const renderConfirmation = (
  payload: TeamSubmissionUpsertFromDiscordPayload,
  entries: ReadonlyArray<ParsedTeamEntry>,
  skippedEntries: ReadonlyArray<SkippedTeamSubmissionEntry> = [],
) => {
  const sourceUrl = sourceMessageUrl(payload);
  if (entries.length === 0 && skippedEntries.length === 0) {
    return `No teams could be parsed from ${sourceUrl}.`;
  }

  const lines = [
    entries.length === 0
      ? `Skipped teams from ${sourceUrl}:`
      : `Registered teams from ${sourceUrl}:`,
  ];

  for (const entry of entries) {
    const oshi =
      entry.oshi.status === "matched"
        ? ` | oshi: ${entry.oshi.value}`
        : entry.oshi.candidate
          ? ` | oshi: ${entry.oshi.candidate} (${entry.oshi.status}, not assigned)`
          : "";
    lines.push(
      `- ${entry.playerName} | ${entry.teamType} | ${entry.teamName}${
        entry.notes.length > 0 ? ` | notes: ${entry.notes.join(", ")}` : ""
      }${oshi}`,
    );
  }
  for (const entry of skippedEntries) {
    lines.push(
      `- skipped ${entry.playerName} | ${entry.teamType} | ${entry.teamName} | reason: ${entry.reason}`,
    );
  }

  return lines.join("\n");
};

export class TeamSubmissionService extends Context.Service<TeamSubmissionService>()(
  "TeamSubmissionService",
  {
    make: Effect.gen(function* () {
      const googleSheets = yield* GoogleSheets;
      const sheetConfigService = yield* SheetConfigService;
      const workspaceConfigService = yield* WorkspaceConfigService;
      const zero = yield* SheetZeroClient;
      const submissionLocks = new Map<string, SubmissionLockEntry>();

      const submissionLockFor = (payload: SubmissionLockPayload) =>
        Effect.sync(() => {
          const key = submissionLockKey(payload);
          const existingEntry = submissionLocks.get(key);
          if (existingEntry) {
            existingEntry.active += 1;
            return { key, entry: existingEntry };
          }

          const entry = { semaphore: Semaphore.makeUnsafe(1), active: 1 };
          submissionLocks.set(key, entry);
          return { key, entry };
        });

      const releaseSubmissionLock = (key: string, entry: SubmissionLockEntry) =>
        Effect.sync(() => {
          entry.active -= 1;
          if (entry.active === 0 && submissionLocks.get(key) === entry) {
            submissionLocks.delete(key);
          }
        });

      const withSubmissionLock = <A, E, R>(
        payload: SubmissionLockPayload,
        effect: Effect.Effect<A, E, R>,
      ) =>
        Effect.acquireRelease(submissionLockFor(payload), ({ entry, key }) =>
          releaseSubmissionLock(key, entry),
        ).pipe(Effect.flatMap(({ entry }) => Semaphore.withPermit(entry.semaphore, effect)));

      const getExisting = (payload: TeamSubmissionUpsertFromDiscordPayload) =>
        zero.messageTeamSubmission.getMessageTeamSubmission({
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
        });

      const getConfigTags = Effect.fn("TeamSubmissionService.getConfigTags")(function* (
        sheetId: string,
        config: TeamConfig,
      ) {
        return yield* pipe(
          config.tagsConfig,
          Option.match({
            onNone: () => Effect.succeed([] as ReadonlyArray<string>),
            onSome: (tagsConfig) =>
              Match.value(tagsConfig).pipe(
                Match.tag("TeamTagsConstantsConfig", (config) => Effect.succeed(config.tags)),
                Match.orElse((config) =>
                  googleSheets
                    .get({ spreadsheetId: sheetId, ranges: [config.tagsRange] })
                    .pipe(
                      Effect.map((response) =>
                        flattenRangeValues(response.data.valueRanges?.[0] ?? {}),
                      ),
                    ),
                ),
              ),
          }),
        );
      });

      const readValidOshis = Effect.fn("TeamSubmissionService.readValidOshis")(function* (
        sheetId: string,
        rangesConfig: RangesConfig,
      ) {
        const oshiRange = Option.getOrNull(rangesConfig.oshis);
        if (oshiRange === null || !String.isNonEmpty(oshiRange)) {
          return [] as string[];
        }

        const response = yield* googleSheets.get({ spreadsheetId: sheetId, ranges: [oshiRange] });
        return (response.data.valueRanges ?? []).flatMap(flattenRangeValues);
      });

      const buildTeamConfigLookups = Effect.fn("TeamSubmissionService.buildTeamConfigLookups")(
        function* (
          sheetId: string,
          teamConfigs: ReadonlyArray<TeamConfig>,
          validOshis: ReadonlyArray<string>,
        ) {
          return yield* Effect.forEach(teamConfigs, (config) =>
            Effect.gen(function* () {
              const tags = yield* getConfigTags(sheetId, config);
              return { config, tags, oshis: validOshis } satisfies TeamConfigLookup;
            }),
          );
        },
      );

      const chooseTeamConfig = (
        teamConfigs: ReadonlyArray<TeamConfigLookup>,
        entry: ParsedTeamEntry,
        destinationTeamConfigName: Option.Option<string>,
      ) => {
        const named = chooseNamedTeamConfig(teamConfigs, destinationTeamConfigName);
        if (named !== null) {
          return named;
        }

        const configs = teamConfigs.filter(({ config }) => isUsableTeamConfig(config));
        const scoredConfigs = configs.map((lookup) => ({
          lookup,
          score: lookup.tags.filter((tag) => tagMatchesEntry(tag, entry)).length,
        }));
        const matched = scoredConfigs
          .filter(({ score }) => score > 0)
          .sort((left, right) => right.score - left.score)[0];

        if (matched) {
          return matched.lookup;
        }

        return configs.length === 1 ? (configs[0] ?? null) : null;
      };

      const resultFromRecord = (
        payload: TeamSubmissionUpsertFromDiscordPayload,
        record: MessageTeamSubmission,
      ): TeamSubmissionUpsertResult => ({
        sourceMessage: sourceMessageRef(payload),
        confirmationMessage: pipe(
          record.confirmationMessageId,
          Option.map((messageId) => ({
            conversation: sourceMessageRef(payload).conversation,
            messageId,
          })),
        ),
        parsedTeams: record.parsedSubmission,
        rowMappings: record.rowMappings,
        rollbackSnapshot: Option.getOrNull(record.rollbackSnapshot),
        skippedTeams: [],
        confirmationText: renderConfirmation(payload, record.parsedSubmission),
        status: record.status,
      });

      const setConfirmationMessage = Effect.fn("TeamSubmissionService.setConfirmationMessage")(
        function* (payload: TeamSubmissionSetConfirmationPayload) {
          yield* zero.messageTeamSubmission.setMessageTeamSubmissionConfirmation(payload);
          const record = yield* zero.messageTeamSubmission.getMessageTeamSubmission({
            workspaceId: payload.workspaceId,
            conversationId: payload.conversationId,
            messageId: payload.messageId,
          });
          if (Option.isNone(record)) {
            return yield* Effect.fail(makeArgumentError("Team submission is not registered"));
          }
          return resultFromRecord(
            {
              client: { platform: "discord", clientId: record.value.clientId },
              dispatchRequestId: `confirmation:${payload.workspaceId}:${payload.conversationId}:${payload.messageId}`,
              workspaceId: payload.workspaceId,
              conversationId: payload.conversationId,
              messageId: payload.messageId,
              authorId: record.value.discordAuthorId,
              authorDisplayName: "",
              content: "",
            },
            record.value,
          );
        },
      );

      const requireSheetId = Effect.fn("TeamSubmissionService.requireSheetId")(function* (
        payload: TeamSubmissionUpsertFromDiscordPayload,
      ) {
        const workspaceConfig = yield* workspaceConfigService.getWorkspaceConfig(
          payload.workspaceId,
        );
        return yield* Option.match(
          pipe(
            workspaceConfig,
            Option.flatMap((config) => config.sheetId),
          ),
          {
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                makeArgumentError(
                  `Workspace ${payload.workspaceId} does not have a configured sheet`,
                ),
              ),
          },
        );
      });

      const requireChannel = Effect.fn("TeamSubmissionService.requireChannel")(function* (
        payload: TeamSubmissionUpsertFromDiscordPayload,
      ) {
        const channelConfig =
          yield* workspaceConfigService.getTeamSubmissionChannelByConversationId({
            workspaceId: payload.workspaceId,
            conversationId: payload.conversationId,
          });
        return yield* Option.match(channelConfig, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              makeArgumentError(
                `Conversation ${payload.conversationId} is not configured for team submissions`,
              ),
            ),
        });
      });

      const matchOshi = (
        candidate: string | null,
        validOshis: ReadonlyArray<string>,
      ): ParsedOshi => {
        if (candidate === null) {
          return { candidate: null, value: null, status: "none" };
        }
        if (validOshis.length === 0) {
          return { candidate, value: null, status: "notConfigured" };
        }

        const normalizedCandidate = candidate.trim().toLowerCase();
        const matches = validOshis.filter((oshi) => {
          const normalizedOshi = oshi.trim().toLowerCase();
          return String.isNonEmpty(normalizedOshi) && normalizedCandidate.includes(normalizedOshi);
        });
        if (matches.length === 1) {
          return { candidate, value: matches[0] ?? null, status: "matched" };
        }
        return {
          candidate,
          value: null,
          status: matches.length > 1 ? "ambiguous" : "invalid",
        };
      };

      const oshiAllowed = (channel: WorkspaceTeamSubmissionChannel, oshi: ParsedOshi) =>
        !channel.requireValidOshi || oshi.status === "matched" || oshi.candidate === null;

      const keepAllowedOshi = (
        channel: WorkspaceTeamSubmissionChannel,
        oshi: ParsedOshi,
      ): Option.Option<ParsedOshi> =>
        oshiAllowed(channel, oshi) ? Option.some(oshi) : Option.none();

      const writableRanges = (config: TeamConfig) => {
        const playerNameRange = optionString(config.playerNameRange);
        const teamNameRange = optionString(config.teamNameRange);
        return playerNameRange && teamNameRange && teamNameRange !== "auto"
          ? { playerNameRange, teamNameRange }
          : null;
      };

      const skippedEntry = (
        entry: ParsedTeamEntry,
        reason: string,
      ): SkippedTeamSubmissionEntry => ({
        stableKey: entry.stableKey,
        playerName: entry.playerName,
        teamName: entry.teamName,
        teamType: entry.teamType,
        reason,
      });

      const writableTeamConfig = (
        teamConfigs: ReadonlyArray<TeamConfigLookup>,
        entry: ParsedTeamEntry,
        destinationTeamConfigName: Option.Option<string>,
      ) => {
        const config = chooseTeamConfig(teamConfigs, entry, destinationTeamConfigName);
        const ranges = config === null ? null : writableRanges(config.config);
        return config === null || ranges === null
          ? Option.none<{
              readonly lookup: TeamConfigLookup;
              readonly ranges: NonNullable<typeof ranges>;
            }>()
          : Option.some({ lookup: config, ranges });
      };

      const rowTargetFromMapping = (
        mapping: TeamSubmissionRowMapping,
      ): TeamSubmissionRowTarget => ({
        rowIndex: mapping.rowIndex,
        playerNameRange: mapping.playerNameRange,
        teamNameRange: mapping.teamNameRange,
        oshiRange: mapping.oshiRange,
      });

      const updatesForRowTarget = (
        target: TeamSubmissionRowTarget,
        entry: ParsedTeamEntry,
      ): ReadonlyArray<SheetValueUpdate> => [
        { range: target.playerNameRange, values: [[entry.playerName]] },
        { range: target.teamNameRange, values: [[entry.teamName]] },
        ...(target.oshiRange === null
          ? []
          : [{ range: target.oshiRange, values: [[entry.oshi.value ?? ""]] }]),
      ];

      const mappingForRowTarget = (
        target: TeamSubmissionRowTarget,
        entry: ParsedTeamEntry,
      ): TeamSubmissionRowMapping => ({
        stableKey: entry.stableKey,
        playerNameRange: target.playerNameRange,
        teamNameRange: target.teamNameRange,
        oshiRange: target.oshiRange,
        rowIndex: target.rowIndex,
      });

      const appendTeamRow = Effect.fn("TeamSubmissionService.appendTeamRow")(function* (
        sheetId: string,
        entry: ParsedTeamEntry,
        oshi: ParsedOshi,
        playerNameRange: string,
        teamNameRange: string,
        oshiRange: string | null,
      ) {
        const appendRange = appendRangeForCells(playerNameRange, teamNameRange, oshiRange);
        if (appendRange === null) {
          return yield* Effect.fail(
            makeArgumentError(
              `Cannot append team submission row because playerNameRange (${playerNameRange}), teamNameRange (${teamNameRange}), and oshiRange (${oshiRange ?? "not configured"}) must be unique columns on the same sheet`,
            ),
          );
        }

        const appendResponse = yield* googleSheets.append({
          spreadsheetId: sheetId,
          range: appendRange.range,
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: [appendRowValues(appendRange, entry, oshi)] },
        });
        const rowIndex = appendedRowIndex(appendResponse.data.updates?.updatedRange);
        if (rowIndex === null) {
          return yield* Effect.fail(
            makeArgumentError("Google Sheets append did not return an updated row range"),
          );
        }
        const rowTarget = appendedRowTarget({
          rowIndex,
          playerNameRange,
          teamNameRange,
          oshiRange,
        });
        if (rowTarget === null) {
          return yield* Effect.fail(
            makeArgumentError(
              `Cannot map appended team submission row ${rowIndex} for playerNameRange (${playerNameRange}), teamNameRange (${teamNameRange}), and oshiRange (${oshiRange ?? "not configured"})`,
            ),
          );
        }

        return rowTarget;
      });

      const rowTargetForEntry = Effect.fn("TeamSubmissionService.rowTargetForEntry")(function* (
        sheetId: string,
        entry: ParsedTeamEntry,
        oshi: ParsedOshi,
        ranges: { readonly playerNameRange: string; readonly teamNameRange: string },
        oshiRange: string | null,
        previousMapping: TeamSubmissionRowMapping | undefined,
      ) {
        return previousMapping
          ? rowTargetFromMapping(previousMapping)
          : yield* appendTeamRow(
              sheetId,
              entry,
              oshi,
              ranges.playerNameRange,
              ranges.teamNameRange,
              oshiRange,
            );
      });

      const buildProcessedEntry = (
        entry: ParsedTeamEntry,
        config: TeamConfig,
        oshi: ParsedOshi,
        rowTarget: TeamSubmissionRowTarget,
        shouldUpdateExistingRow: boolean,
      ): ProcessedTeamSubmissionEntry => {
        const parsedEntry = {
          ...entry,
          teamConfigName: optionString(config.name) ?? null,
          oshi,
        } satisfies ParsedTeamEntry;
        return {
          entry: parsedEntry,
          mapping: mappingForRowTarget(rowTarget, entry),
          updates: shouldUpdateExistingRow ? updatesForRowTarget(rowTarget, parsedEntry) : [],
        };
      };

      const processParsedEntry = Effect.fn("TeamSubmissionService.processParsedEntry")(
        function* (params: {
          readonly sheetId: string;
          readonly teamConfigs: ReadonlyArray<TeamConfigLookup>;
          readonly channel: WorkspaceTeamSubmissionChannel;
          readonly entry: ParsedTeamEntry;
          readonly oshiCandidate: string | null;
          readonly previousMapping: TeamSubmissionRowMapping | undefined;
        }) {
          const config = writableTeamConfig(
            params.teamConfigs,
            params.entry,
            params.channel.destinationTeamConfigName,
          );
          if (Option.isNone(config)) {
            return {
              _tag: "skipped" as const,
              entry: skippedEntry(params.entry, "No writable team config matched this team"),
            };
          }

          const oshi = keepAllowedOshi(
            params.channel,
            matchOshi(params.oshiCandidate, config.value.lookup.oshis),
          );
          if (Option.isNone(oshi)) {
            return {
              _tag: "skipped" as const,
              entry: skippedEntry(params.entry, `Oshi ${params.oshiCandidate ?? ""} is not valid`),
            };
          }

          const rowTarget = yield* rowTargetForEntry(
            params.sheetId,
            params.entry,
            oshi.value,
            config.value.ranges,
            optionString(config.value.lookup.config.oshiRange) ?? null,
            params.previousMapping,
          );
          return {
            _tag: "registered" as const,
            entry: buildProcessedEntry(
              params.entry,
              config.value.lookup.config,
              oshi.value,
              rowTarget,
              params.previousMapping !== undefined,
            ),
          };
        },
      );

      const blankRemovedRows = (
        previousKeys: ReadonlySet<string>,
        nextKeys: ReadonlySet<string>,
        previousMappings: ReadonlyMap<string, TeamSubmissionRowMapping>,
      ) =>
        [...previousKeys]
          .filter((key) => !nextKeys.has(key))
          .flatMap((key) => {
            const mapping = previousMappings.get(key);
            return mapping
              ? [
                  { range: mapping.playerNameRange, values: [[""]] },
                  { range: mapping.teamNameRange, values: [[""]] },
                  ...(mapping.oshiRange === null
                    ? []
                    : [{ range: mapping.oshiRange, values: [[""]] }]),
                ]
              : [];
          });

      const confirmationMessage = (
        existing: Option.Option<MessageTeamSubmission>,
        payload: TeamSubmissionUpsertFromDiscordPayload,
      ) =>
        pipe(
          existing,
          Option.flatMap((record) => record.confirmationMessageId),
          Option.map((messageId) => ({
            conversation: sourceMessageRef(payload).conversation,
            messageId,
          })),
        );

      const persistSubmission = (
        payload: TeamSubmissionUpsertFromDiscordPayload,
        sheetId: string,
        confirmationMessageId: string | null,
        entries: ReadonlyArray<ParsedTeamEntry>,
        rowMappings: ReadonlyArray<TeamSubmissionRowMapping>,
        rollbackSnapshot: TeamSubmissionRollbackSnapshot | null,
        status: TeamSubmissionUpsertResult["status"],
      ) =>
        zero.messageTeamSubmission.upsertMessageTeamSubmission({
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          clientPlatform: payload.client.platform,
          clientId: payload.client.clientId,
          discordGuildId: payload.workspaceId,
          discordChannelId: payload.conversationId,
          discordAuthorId: payload.authorId,
          sheetId,
          confirmationMessageId,
          parsedSubmission: entries,
          rowMappings,
          rollbackSnapshot,
          status,
        });

      const persistExistingSubmissionStatus = (
        existing: MessageTeamSubmission,
        status: TeamSubmissionUpsertResult["status"],
      ) =>
        zero.messageTeamSubmission.upsertMessageTeamSubmission({
          workspaceId: existing.workspaceId,
          conversationId: existing.conversationId,
          messageId: existing.messageId,
          clientPlatform: existing.clientPlatform,
          clientId: existing.clientId,
          discordGuildId: existing.discordGuildId,
          discordChannelId: existing.discordChannelId,
          discordAuthorId: existing.discordAuthorId,
          sheetId: existing.sheetId,
          confirmationMessageId: Option.getOrNull(existing.confirmationMessageId),
          parsedSubmission: existing.parsedSubmission,
          rowMappings: existing.rowMappings,
          rollbackSnapshot: Option.getOrNull(existing.rollbackSnapshot),
          status,
        });

      const rollbackSnapshotForUpdates = (
        sheetId: string,
        data: ReadonlyArray<SheetValueUpdate>,
        stableKeyByRange: ReadonlyMap<string, string>,
      ) =>
        data.length === 0
          ? Effect.succeed([] as TeamSubmissionRollbackSnapshot)
          : googleSheets
              .get({
                spreadsheetId: sheetId,
                ranges: [...new Set(data.map((update) => update.range))],
              })
              .pipe(
                Effect.map((response) =>
                  (response.data.valueRanges ?? []).map((valueRange) => {
                    const range = valueRange.range ?? "";
                    return {
                      stableKey: stableKeyByRange.get(range) ?? range,
                      range,
                      values: (valueRange.values ?? []).map((row) =>
                        row.map((cell) => globalThis.String(cell)),
                      ),
                    } satisfies TeamSubmissionRollbackSnapshotEntry;
                  }),
                ),
              );

      const blankRollbackSnapshotForAppendedRows = (
        entries: ReadonlyArray<ProcessedTeamSubmissionEntry>,
      ): TeamSubmissionRollbackSnapshot =>
        entries
          .filter((entry) => entry.updates.length === 0)
          .flatMap((entry) => [
            {
              stableKey: entry.mapping.stableKey,
              range: entry.mapping.playerNameRange,
              values: [],
            },
            {
              stableKey: entry.mapping.stableKey,
              range: entry.mapping.teamNameRange,
              values: [],
            },
            ...(entry.mapping.oshiRange === null
              ? []
              : [
                  {
                    stableKey: entry.mapping.stableKey,
                    range: entry.mapping.oshiRange,
                    values: [],
                  },
                ]),
          ]);

      const statusForEntries = (
        entries: ReadonlyArray<ParsedTeamEntry>,
        existing: Option.Option<MessageTeamSubmission>,
      ): TeamSubmissionUpsertResult["status"] =>
        entries.length === 0 ? "empty" : Option.isSome(existing) ? "updated" : "registered";

      const upsertFromDiscord = Effect.fn("TeamSubmissionService.upsertFromDiscord")(function* (
        payload: TeamSubmissionUpsertFromDiscordPayload,
      ) {
        return yield* withSubmissionLock(
          payload,
          Effect.gen(function* () {
            const sheetId = yield* requireSheetId(payload);
            const channel = yield* requireChannel(payload);
            const { teamConfigs, rangesConfig } = yield* Effect.all({
              teamConfigs: sheetConfigService.getTeamConfig(sheetId),
              rangesConfig: sheetConfigService.getRangesConfig(sheetId),
            });
            const validOshis = yield* readValidOshis(sheetId, rangesConfig);
            const teamConfigLookups = yield* buildTeamConfigLookups(
              sheetId,
              teamConfigs,
              validOshis,
            );
            const existing = yield* getExisting(payload);
            yield* pipe(
              existing,
              Option.match({
                onNone: () => Effect.void,
                onSome: requireEditableSubmission,
              }),
            );
            const parsed = parseTeamSubmissionMessage(payload.content, payload.authorDisplayName);
            const previousMappings = existingMappingByKey(existing);
            const previousKeys = existingTeamKeys(existing);
            const confirmation = confirmationMessage(existing, payload);
            const confirmationMessageId = pipe(
              confirmation,
              Option.map((ref) => ref.messageId),
              Option.getOrNull,
            );
            const interimMappings = new Map(previousMappings);
            const processed: Array<ProcessedTeamSubmissionResult> = [];
            const registeredEntries: Array<ProcessedTeamSubmissionEntry> = [];
            const isRegistered = isProcessedResult("registered");
            const isSkipped = isProcessedResult("skipped");
            const entriesForPersist = () => registeredEntries.map((registered) => registered.entry);
            const flushRegisteredUpdates = () => {
              const data = registeredEntries.flatMap((registered) => registered.updates);
              return data.length === 0
                ? Effect.void
                : googleSheets.update({
                    spreadsheetId: sheetId,
                    requestBody: {
                      valueInputOption: "USER_ENTERED",
                      data,
                    },
                  });
            };
            const flushPartialSubmission = () => {
              const entries = entriesForPersist();
              return entries.length === 0
                ? Effect.void
                : Effect.gen(function* () {
                    yield* flushRegisteredUpdates();
                    yield* persistSubmission(
                      payload,
                      sheetId,
                      confirmationMessageId,
                      entries,
                      [...interimMappings.values()],
                      pipe(
                        existing,
                        Option.flatMap((submission) => submission.rollbackSnapshot),
                        Option.getOrNull,
                      ),
                      statusForEntries(entries, existing),
                    );
                  });
            };

            yield* Effect.forEach(
              parsed.entries,
              (entry) =>
                Effect.gen(function* () {
                  const processedEntry = yield* processParsedEntry({
                    sheetId,
                    teamConfigs: teamConfigLookups,
                    channel,
                    entry,
                    oshiCandidate: parsed.oshiCandidate,
                    previousMapping: previousMappings.get(entry.stableKey),
                  });
                  processed.push(processedEntry);
                  if (isRegistered(processedEntry)) {
                    registeredEntries.push(processedEntry.entry);
                    interimMappings.set(
                      processedEntry.entry.mapping.stableKey,
                      processedEntry.entry.mapping,
                    );
                  }
                }),
              { discard: true },
            ).pipe(
              Effect.tapError(() =>
                flushPartialSubmission().pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Failed to persist partial team submission state").pipe(
                      Effect.andThen(Effect.logDebug(cause)),
                    ),
                  ),
                ),
              ),
            );
            const registered = processed.filter(isRegistered).map((entry) => entry.entry);
            const skippedEntries = processed.filter(isSkipped).map((entry) => entry.entry);
            const entries = registered.map((entry) => entry.entry);
            const rowMappings = registered.map((entry) => entry.mapping);
            const nextKeys = new Set(rowMappings.map((mapping) => mapping.stableKey));
            const data = [
              ...registered.flatMap((entry) => entry.updates),
              ...blankRemovedRows(previousKeys, nextKeys, previousMappings),
            ];
            const stableKeyByRange = new Map<string, string>();
            for (const entry of registered) {
              stableKeyByRange.set(entry.mapping.playerNameRange, entry.mapping.stableKey);
              stableKeyByRange.set(entry.mapping.teamNameRange, entry.mapping.stableKey);
              if (entry.mapping.oshiRange !== null) {
                stableKeyByRange.set(entry.mapping.oshiRange, entry.mapping.stableKey);
              }
            }
            for (const mapping of previousMappings.values()) {
              stableKeyByRange.set(mapping.playerNameRange, mapping.stableKey);
              stableKeyByRange.set(mapping.teamNameRange, mapping.stableKey);
              if (mapping.oshiRange !== null) {
                stableKeyByRange.set(mapping.oshiRange, mapping.stableKey);
              }
            }
            const rollbackSnapshot = [
              ...(yield* rollbackSnapshotForUpdates(sheetId, data, stableKeyByRange)),
              ...blankRollbackSnapshotForAppendedRows(registered),
            ];

            if (data.length > 0) {
              yield* googleSheets.update({
                spreadsheetId: sheetId,
                requestBody: {
                  valueInputOption: "USER_ENTERED",
                  data,
                },
              });
            }

            const status = statusForEntries(entries, existing);
            yield* persistSubmission(
              payload,
              sheetId,
              confirmationMessageId,
              entries,
              rowMappings,
              rollbackSnapshot,
              status,
            );

            return {
              sourceMessage: sourceMessageRef(payload),
              confirmationMessage: confirmation,
              parsedTeams: entries,
              rowMappings,
              rollbackSnapshot,
              skippedTeams: skippedEntries,
              confirmationText: renderConfirmation(payload, entries, skippedEntries),
              status,
            } satisfies TeamSubmissionUpsertResult;
          }),
        );
      });

      const revertFromDiscord = Effect.fn("TeamSubmissionService.revertFromDiscord")(function* (
        payload: TeamSubmissionRevertFromDiscordPayload,
      ) {
        return yield* withSubmissionLock(
          payload,
          Effect.gen(function* () {
            const existing = yield* zero.messageTeamSubmission.getMessageTeamSubmission({
              workspaceId: payload.workspaceId,
              conversationId: payload.conversationId,
              messageId: payload.messageId,
            });
            if (Option.isNone(existing)) {
              return yield* Effect.fail(makeArgumentError("Team submission record was not found"));
            }

            const submission = existing.value;
            yield* requireActionableSubmission(submission);
            if (submission.discordAuthorId !== payload.requesterUserId) {
              return yield* Effect.fail(
                makeArgumentError("Only the original submitter can reject this team submission"),
              );
            }

            const snapshot = Option.getOrNull(submission.rollbackSnapshot);
            if (snapshot === null || snapshot.length === 0) {
              yield* persistExistingSubmissionStatus(submission, "rollbackFailed");
              return {
                status: "rollbackFailed",
                rowMappings: submission.rowMappings,
                rollbackSnapshot: snapshot,
                confirmationText: "Rollback failed: no rollback snapshot is available.",
              } satisfies TeamSubmissionRevertResult;
            }

            const rollbackExit = yield* Effect.exit(
              googleSheets.update({
                spreadsheetId: submission.sheetId,
                requestBody: {
                  valueInputOption: "USER_ENTERED",
                  data: snapshot.map((entry) => ({
                    range: entry.range,
                    values:
                      entry.values.length === 0 ? [[""]] : entry.values.map((row) => [...row]),
                  })),
                },
              }),
            );
            if (Exit.isFailure(rollbackExit)) {
              yield* persistExistingSubmissionStatus(submission, "rollbackFailed");
              return {
                status: "rollbackFailed",
                rowMappings: submission.rowMappings,
                rollbackSnapshot: snapshot,
                confirmationText: "Rollback failed: Tiara could not restore the sheet.",
              } satisfies TeamSubmissionRevertResult;
            }

            yield* persistExistingSubmissionStatus(submission, "rejected");
            return {
              status: "rejected",
              rowMappings: submission.rowMappings,
              rollbackSnapshot: snapshot,
              confirmationText: "Team submission was rejected and the sheet was restored.",
            } satisfies TeamSubmissionRevertResult;
          }),
        );
      });

      const confirmFromDiscord = Effect.fn("TeamSubmissionService.confirmFromDiscord")(function* (
        payload: TeamSubmissionConfirmFromDiscordPayload,
      ) {
        return yield* withSubmissionLock(
          payload,
          Effect.gen(function* () {
            const existing = yield* zero.messageTeamSubmission.getMessageTeamSubmission({
              workspaceId: payload.workspaceId,
              conversationId: payload.conversationId,
              messageId: payload.messageId,
            });
            if (Option.isNone(existing)) {
              return yield* Effect.fail(makeArgumentError("Team submission record was not found"));
            }

            const submission = existing.value;
            yield* requireActionableSubmission(submission);
            if (submission.discordAuthorId !== payload.requesterUserId) {
              return yield* Effect.fail(
                makeArgumentError("Only the original submitter can confirm this team submission"),
              );
            }

            yield* persistExistingSubmissionStatus(submission, "confirmed");
            return { status: "confirmed" } satisfies TeamSubmissionConfirmResult;
          }),
        );
      });

      return { upsertFromDiscord, setConfirmationMessage, revertFromDiscord, confirmFromDiscord };
    }),
  },
) {
  static layer = Layer.effect(TeamSubmissionService, this.make).pipe(
    Layer.provide([
      GoogleSheets.layer,
      SheetConfigService.layer,
      WorkspaceConfigService.layer,
      SheetZeroClient.layer,
    ]),
  );
}
