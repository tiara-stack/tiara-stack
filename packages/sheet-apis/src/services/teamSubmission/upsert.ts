import { Cause, Effect, Option, pipe } from "effect";
import {
  type ParsedTeamEntry,
  type TeamSubmissionRollbackSnapshot,
  type TeamSubmissionRowMapping,
  type TeamSubmissionUpsertFromDiscordPayload,
  type TeamSubmissionUpsertResult,
} from "sheet-ingress-api/schemas/teamSubmission";
import type { TeamSubmissionDependencies } from "./dependencies";
import type { SubmissionLocks } from "./locks";
import type { TeamSubmissionPersistence } from "./persistence";
import {
  type ProcessedTeamSubmissionEntry,
  type ProcessedTeamSubmissionResult,
  existingMappingByKey,
  existingTeamKeys,
  isProcessedResult,
  parseTeamSubmissionMessage,
  pendingAppendRollbackRange,
  preserveExistingStableKeys,
  requireEditableSubmission,
  renderConfirmation,
  sourceMessageRef,
} from "./pure";
import type { TeamSubmissionSupport } from "./support";

export const makeUpsertFromDiscord = (
  {
    googleSheets,
    sheetConfigService,
  }: Pick<TeamSubmissionDependencies, "googleSheets" | "sheetConfigService">,
  { withSubmissionLock }: SubmissionLocks,
  {
    blankRemovedRows,
    blankRollbackSnapshotForAppendedRows,
    buildTeamConfigLookups,
    confirmationMessage,
    processParsedEntry,
    readValidOshis,
    requireChannel,
    requireSheetId,
    statusForEntries,
  }: TeamSubmissionSupport,
  { getExisting, persistSubmission, rollbackSnapshotForUpdates }: TeamSubmissionPersistence,
) => {
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
        const teamConfigLookups = yield* buildTeamConfigLookups(sheetId, teamConfigs, validOshis);
        const existing = yield* getExisting(payload);
        yield* pipe(
          existing,
          Option.match({
            onNone: () => Effect.void,
            onSome: requireEditableSubmission,
          }),
        );
        const parsed = parseTeamSubmissionMessage(payload.content, payload.authorDisplayName);
        const parsedEntries = Option.match(existing, {
          onNone: () => parsed.entries,
          onSome: (submission) => preserveExistingStableKeys(submission, parsed.entries),
        });
        const previousMappings = existingMappingByKey(existing);
        const previousKeys = existingTeamKeys(existing);
        const confirmation = confirmationMessage(existing, payload);
        const confirmationMessageId = pipe(
          confirmation,
          Option.map((ref) => ref.messageId),
          Option.getOrNull,
        );
        const interimMappings = new Map(previousMappings);
        let recoveryRollbackSnapshot = pipe(
          existing,
          Option.flatMap((submission) => submission.rollbackSnapshot),
          Option.getOrNull,
        );
        const processed: Array<ProcessedTeamSubmissionResult> = [];
        const registeredEntries: Array<ProcessedTeamSubmissionEntry> = [];
        const pendingAppendKeys = new Set<string>();
        const isRegistered = isProcessedResult("registered");
        const isSkipped = isProcessedResult("skipped");
        const entriesForPersist = () => registeredEntries.map((registered) => registered.entry);
        const persistApplying = (
          entries: ReadonlyArray<ParsedTeamEntry>,
          mappings: ReadonlyArray<TeamSubmissionRowMapping>,
          rollbackSnapshot: TeamSubmissionRollbackSnapshot | null,
        ) =>
          persistSubmission(
            payload,
            sheetId,
            confirmationMessageId,
            entries,
            mappings,
            rollbackSnapshot,
            "applying",
          );
        const withBlankAppendedRows = (
          snapshot: TeamSubmissionRollbackSnapshot,
          appendedRows: ReadonlyArray<ProcessedTeamSubmissionEntry>,
        ) => {
          const appendedKeys = new Set(appendedRows.map(({ mapping }) => mapping.stableKey));
          return [
            ...snapshot.filter(({ stableKey }) => !appendedKeys.has(stableKey)),
            ...blankRollbackSnapshotForAppendedRows(appendedRows),
          ];
        };
        const flushPartialSubmission = () => {
          const entries = entriesForPersist();
          return entries.length === 0 || pendingAppendKeys.size > 0
            ? Effect.void
            : Effect.gen(function* () {
                const updates = registeredEntries.flatMap((registered) => registered.updates);
                const stableKeyByRange = new Map(
                  registeredEntries.flatMap((registered) =>
                    registered.updates.map((update) => [
                      update.range,
                      registered.mapping.stableKey,
                    ]),
                  ),
                );
                recoveryRollbackSnapshot = withBlankAppendedRows(
                  yield* rollbackSnapshotForUpdates(sheetId, updates, stableKeyByRange),
                  registeredEntries,
                );
                yield* persistApplying(
                  entries,
                  [...interimMappings.values()],
                  recoveryRollbackSnapshot,
                );
              });
        };
        const persistPendingAppend = (
          entry: ParsedTeamEntry,
          mapping: TeamSubmissionRowMapping,
        ) => {
          interimMappings.set(mapping.stableKey, mapping);
          recoveryRollbackSnapshot = [
            ...(recoveryRollbackSnapshot ?? []).filter(
              (snapshot) => snapshot.stableKey !== mapping.stableKey,
            ),
            { stableKey: mapping.stableKey, range: pendingAppendRollbackRange, values: [] },
          ];
          return persistApplying(
            [...entriesForPersist(), entry],
            [...interimMappings.values()],
            recoveryRollbackSnapshot,
          ).pipe(Effect.tap(() => Effect.sync(() => pendingAppendKeys.add(mapping.stableKey))));
        };
        const persistFinalizedAppend = (entry: ProcessedTeamSubmissionEntry) => {
          interimMappings.set(entry.mapping.stableKey, entry.mapping);
          recoveryRollbackSnapshot = [
            ...(recoveryRollbackSnapshot ?? []).filter(
              (snapshot) => snapshot.stableKey !== entry.mapping.stableKey,
            ),
            ...blankRollbackSnapshotForAppendedRows([entry]),
          ];
          return persistApplying(
            [...entriesForPersist(), entry.entry],
            [...interimMappings.values()],
            recoveryRollbackSnapshot,
          ).pipe(
            Effect.tap(() => Effect.sync(() => pendingAppendKeys.delete(entry.mapping.stableKey))),
          );
        };

        yield* Effect.forEach(
          parsedEntries,
          (entry) =>
            Effect.gen(function* () {
              const processedEntry = yield* processParsedEntry({
                sheetId,
                appendIdentity: `${payload.workspaceId}:${payload.conversationId}:${payload.messageId}:${entry.stableKey}`,
                teamConfigs: teamConfigLookups,
                channel,
                entry,
                oshiCandidate: parsed.oshiCandidate,
                previousMapping: previousMappings.get(entry.stableKey),
                beforeAppend: persistPendingAppend,
                afterAppend: persistFinalizedAppend,
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
          Effect.tapCause(() =>
            flushPartialSubmission().pipe(
              Effect.timeout("10 seconds"),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterrupts(cause),
                (cause) =>
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
        for (const mapping of previousMappings.values()) {
          stableKeyByRange.set(mapping.playerNameRange, mapping.stableKey);
          stableKeyByRange.set(mapping.teamNameRange, mapping.stableKey);
          if (mapping.oshiRange !== null) {
            stableKeyByRange.set(mapping.oshiRange, mapping.stableKey);
          }
        }
        for (const entry of registered) {
          stableKeyByRange.set(entry.mapping.playerNameRange, entry.mapping.stableKey);
          stableKeyByRange.set(entry.mapping.teamNameRange, entry.mapping.stableKey);
          if (entry.mapping.oshiRange !== null) {
            stableKeyByRange.set(entry.mapping.oshiRange, entry.mapping.stableKey);
          }
        }
        const rollbackSnapshot = withBlankAppendedRows(
          yield* rollbackSnapshotForUpdates(sheetId, data, stableKeyByRange),
          registered,
        );
        recoveryRollbackSnapshot = rollbackSnapshot;

        const status = statusForEntries(entries, existing);
        if (data.length > 0) {
          yield* persistSubmission(
            payload,
            sheetId,
            confirmationMessageId,
            entries,
            rowMappings,
            recoveryRollbackSnapshot,
            "applying",
          );
          yield* googleSheets.update({
            spreadsheetId: sheetId,
            requestBody: {
              valueInputOption: "USER_ENTERED",
              data,
            },
          });
        }

        yield* persistSubmission(
          payload,
          sheetId,
          confirmationMessageId,
          entries,
          rowMappings,
          recoveryRollbackSnapshot,
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

  return upsertFromDiscord;
};
