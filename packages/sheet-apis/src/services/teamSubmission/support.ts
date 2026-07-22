import { Effect, Match, Option, String, pipe } from "effect";
import type { RangesConfig, TeamConfig } from "sheet-ingress-api/schemas/sheetConfig";
import { TEAM_SUBMISSION_FEATURE_FLAG } from "sheet-ingress-api/schemas/teamSubmission";
import {
  type MessageTeamSubmission,
  type ParsedOshi,
  type ParsedTeamEntry,
  type TeamSubmissionRollbackSnapshot,
  type TeamSubmissionRowMapping,
  type TeamSubmissionUpsertFromDiscordPayload,
  type TeamSubmissionUpsertResult,
} from "sheet-ingress-api/schemas/teamSubmission";
import type { WorkspaceTeamSubmissionChannel } from "sheet-ingress-api/schemas/workspaceConfig";
import { makeArgumentError } from "typhoon-core/error";
import type { TeamSubmissionDependencies } from "./dependencies";
import {
  type ProcessedTeamSubmissionEntry,
  type SheetValueUpdate,
  type SkippedTeamSubmissionEntry,
  type TeamConfigLookup,
  type TeamSubmissionRowTarget,
  appendRangeForCells,
  appendRowValues,
  appendedRowIndex,
  appendedRowTarget,
  chooseNamedTeamConfig,
  flattenRangeValues,
  isUsableTeamConfig,
  optionString,
  sourceMessageRef,
  tagMatchesEntry,
} from "./pure";

export const makeTeamSubmissionSupport = ({
  googleSheets,
  workspaceConfigService,
}: Pick<TeamSubmissionDependencies, "googleSheets" | "workspaceConfigService">) => {
  const isFeatureEnabled = Effect.fn("TeamSubmissionService.isFeatureEnabled")(function* (
    workspaceId: string,
  ) {
    const flag = yield* workspaceConfigService.getWorkspaceFeatureFlag(
      workspaceId,
      TEAM_SUBMISSION_FEATURE_FLAG,
    );
    return Option.isSome(flag);
  });

  const requireFeatureEnabled = Effect.fn("TeamSubmissionService.requireFeatureEnabled")(function* (
    workspaceId: string,
  ) {
    if (!(yield* isFeatureEnabled(workspaceId))) {
      return yield* Effect.fail(
        makeArgumentError(`Team submissions are not enabled for workspace ${workspaceId}`),
      );
    }
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

  const requireSheetId = Effect.fn("TeamSubmissionService.requireSheetId")(function* (
    payload: TeamSubmissionUpsertFromDiscordPayload,
  ) {
    const workspaceConfig = yield* workspaceConfigService.getWorkspaceConfig(payload.workspaceId);
    return yield* Option.match(
      pipe(
        workspaceConfig,
        Option.flatMap((config) => config.sheetId),
      ),
      {
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            makeArgumentError(`Workspace ${payload.workspaceId} does not have a configured sheet`),
          ),
      },
    );
  });

  const requireChannel = Effect.fn("TeamSubmissionService.requireChannel")(function* (
    payload: TeamSubmissionUpsertFromDiscordPayload,
  ) {
    const channelConfig = yield* workspaceConfigService.getTeamSubmissionChannelByConversationId({
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

  const matchOshi = (candidate: string | null, validOshis: ReadonlyArray<string>): ParsedOshi => {
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
    !channel.requireValidOshi || oshi.status === "matched";

  const keepAllowedOshi = (
    channel: WorkspaceTeamSubmissionChannel,
    oshi: ParsedOshi,
  ): Option.Option<ParsedOshi> => (oshiAllowed(channel, oshi) ? Option.some(oshi) : Option.none());

  const writableRanges = (config: TeamConfig) => {
    const playerNameRange = optionString(config.playerNameRange);
    const teamNameRange = optionString(config.teamNameRange);
    return playerNameRange && teamNameRange && teamNameRange !== "auto"
      ? { playerNameRange, teamNameRange }
      : null;
  };

  const skippedEntry = (entry: ParsedTeamEntry, reason: string): SkippedTeamSubmissionEntry => ({
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

  const rowTargetFromMapping = (mapping: TeamSubmissionRowMapping): TeamSubmissionRowTarget => ({
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

  type AppendEntryParams = {
    readonly sheetId: string;
    readonly appendIdentity: string;
    readonly entry: ParsedTeamEntry;
    readonly oshi: ParsedOshi;
    readonly playerNameRange: string;
    readonly teamNameRange: string;
    readonly oshiRange: string | null;
  };

  const markedPlayerName = (playerName: string, appendIdentity: string) =>
    `${playerName}\u2063tiara:${appendIdentity}\u2063`;

  const appendTeamRow = Effect.fn("TeamSubmissionService.appendTeamRow")(function* ({
    sheetId,
    appendIdentity,
    entry,
    oshi,
    playerNameRange,
    teamNameRange,
    oshiRange,
  }: AppendEntryParams) {
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
      requestBody: {
        values: [
          appendRowValues(
            appendRange,
            { ...entry, playerName: markedPlayerName(entry.playerName, appendIdentity) },
            oshi,
          ),
        ],
      },
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

  const reconcilePendingAppend = Effect.fn("TeamSubmissionService.reconcilePendingAppend")(
    function* (params: AppendEntryParams) {
      const appendRange = appendRangeForCells(
        params.playerNameRange,
        params.teamNameRange,
        params.oshiRange,
      );
      if (appendRange === null) {
        return null;
      }
      const response = yield* googleSheets.get({
        spreadsheetId: params.sheetId,
        ranges: [appendRange.range],
      });
      const expected = appendRowValues(appendRange, params.entry, params.oshi);
      expected[appendRange.playerColumn - appendRange.startColumn] = markedPlayerName(
        params.entry.playerName,
        params.appendIdentity,
      );
      const matchingRowOffsets = (response.data.valueRanges?.[0]?.values ?? []).flatMap(
        (row, index) =>
          expected.every((value, valueIndex) => globalThis.String(row[valueIndex] ?? "") === value)
            ? [index]
            : [],
      );
      const rowOffset = matchingRowOffsets.length === 1 ? matchingRowOffsets[0] : undefined;
      return rowOffset === undefined
        ? null
        : appendedRowTarget({
            rowIndex: rowOffset + 1,
            playerNameRange: params.playerNameRange,
            teamNameRange: params.teamNameRange,
            oshiRange: params.oshiRange,
          });
    },
  );

  const rowTargetForEntry = Effect.fn("TeamSubmissionService.rowTargetForEntry")(function* ({
    appendIdentity,
    beforeAppend,
    entry,
    oshi,
    oshiRange,
    previousMapping,
    ranges,
    sheetId,
  }: {
    readonly sheetId: string;
    readonly appendIdentity: string;
    readonly entry: ParsedTeamEntry;
    readonly oshi: ParsedOshi;
    readonly ranges: { readonly playerNameRange: string; readonly teamNameRange: string };
    readonly oshiRange: string | null;
    readonly previousMapping: TeamSubmissionRowMapping | undefined;
    readonly beforeAppend: (
      entry: ParsedTeamEntry,
      mapping: TeamSubmissionRowMapping,
    ) => Effect.Effect<void, unknown>;
  }) {
    if (previousMapping && previousMapping.rowIndex > 0) {
      return rowTargetFromMapping(previousMapping);
    }
    if (previousMapping) {
      const reconciled = yield* reconcilePendingAppend({
        sheetId,
        appendIdentity,
        entry,
        oshi,
        playerNameRange: ranges.playerNameRange,
        teamNameRange: ranges.teamNameRange,
        oshiRange,
      });
      if (reconciled !== null) {
        return reconciled;
      }
    } else {
      yield* beforeAppend(entry, {
        stableKey: entry.stableKey,
        playerNameRange: ranges.playerNameRange,
        teamNameRange: ranges.teamNameRange,
        oshiRange,
        rowIndex: 0,
      });
    }
    return yield* appendTeamRow({
      sheetId,
      appendIdentity,
      entry,
      oshi,
      playerNameRange: ranges.playerNameRange,
      teamNameRange: ranges.teamNameRange,
      oshiRange,
    });
  });

  const buildProcessedEntry = (
    entry: ParsedTeamEntry,
    config: TeamConfig,
    oshi: ParsedOshi,
    rowTarget: TeamSubmissionRowTarget,
    appended: boolean,
  ): ProcessedTeamSubmissionEntry => {
    const parsedEntry = {
      ...entry,
      teamConfigName: optionString(config.name) ?? null,
      oshi,
    } satisfies ParsedTeamEntry;
    return {
      appended,
      entry: parsedEntry,
      mapping: mappingForRowTarget(rowTarget, entry),
      updates: updatesForRowTarget(rowTarget, parsedEntry),
    };
  };

  const processParsedEntry = Effect.fn("TeamSubmissionService.processParsedEntry")(
    function* (params: {
      readonly sheetId: string;
      readonly appendIdentity: string;
      readonly teamConfigs: ReadonlyArray<TeamConfigLookup>;
      readonly channel: WorkspaceTeamSubmissionChannel;
      readonly entry: ParsedTeamEntry;
      readonly oshiCandidate: string | null;
      readonly previousMapping: TeamSubmissionRowMapping | undefined;
      readonly beforeAppend: (
        entry: ParsedTeamEntry,
        mapping: TeamSubmissionRowMapping,
      ) => Effect.Effect<void, unknown>;
      readonly afterAppend: (entry: ProcessedTeamSubmissionEntry) => Effect.Effect<void, unknown>;
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
          entry: skippedEntry(
            params.entry,
            params.oshiCandidate === null
              ? "Oshi is required"
              : `Oshi ${params.oshiCandidate} is not valid`,
          ),
        };
      }

      const rowTarget = yield* rowTargetForEntry({
        sheetId: params.sheetId,
        appendIdentity: params.appendIdentity,
        entry: params.entry,
        oshi: oshi.value,
        ranges: config.value.ranges,
        oshiRange: optionString(config.value.lookup.config.oshiRange) ?? null,
        previousMapping: params.previousMapping,
        beforeAppend: params.beforeAppend,
      });
      const processedEntry = buildProcessedEntry(
        params.entry,
        config.value.lookup.config,
        oshi.value,
        rowTarget,
        !params.previousMapping || params.previousMapping.rowIndex === 0,
      );
      if (!params.previousMapping || params.previousMapping.rowIndex === 0) {
        yield* params.afterAppend(processedEntry);
      }
      return {
        _tag: "registered" as const,
        entry: processedEntry,
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
              ...(mapping.oshiRange === null ? [] : [{ range: mapping.oshiRange, values: [[""]] }]),
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

  const blankRollbackSnapshotForAppendedRows = (
    entries: ReadonlyArray<ProcessedTeamSubmissionEntry>,
  ): TeamSubmissionRollbackSnapshot =>
    entries
      .filter((entry) => entry.appended)
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

  return {
    blankRemovedRows,
    blankRollbackSnapshotForAppendedRows,
    buildTeamConfigLookups,
    confirmationMessage,
    isFeatureEnabled,
    processParsedEntry,
    readValidOshis,
    requireChannel,
    requireFeatureEnabled,
    requireSheetId,
    statusForEntries,
  };
};

export type TeamSubmissionSupport = ReturnType<typeof makeTeamSubmissionSupport>;
