import { Effect, Option, pipe } from "effect";
import {
  type MessageTeamSubmission,
  type ParsedTeamEntry,
  type TeamSubmissionRollbackSnapshot,
  type TeamSubmissionRollbackSnapshotEntry,
  type TeamSubmissionRowMapping,
  type TeamSubmissionSetConfirmationPayload,
  type TeamSubmissionUpsertFromDiscordPayload,
  type TeamSubmissionUpsertResult,
} from "sheet-ingress-api/schemas/teamSubmission";
import { makeArgumentError } from "typhoon-core/error";
import type { TeamSubmissionDependencies } from "./dependencies";
import type { SubmissionLocks } from "./locks";
import { type SheetValueUpdate, renderConfirmation, sourceMessageRef } from "./pure";

export const makeTeamSubmissionPersistence = (
  { googleSheets, zero }: Pick<TeamSubmissionDependencies, "googleSheets" | "zero">,
  { withSubmissionLock }: SubmissionLocks,
) => {
  const getExisting = (payload: TeamSubmissionUpsertFromDiscordPayload) =>
    zero.messageTeamSubmission.getMessageTeamSubmission({
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
    });

  const resultFromRecord = (
    payload: Pick<
      TeamSubmissionUpsertFromDiscordPayload,
      "client" | "workspaceId" | "conversationId" | "messageId"
    >,
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
    (payload: TeamSubmissionSetConfirmationPayload) =>
      withSubmissionLock(
        payload,
        Effect.gen(function* () {
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
              workspaceId: payload.workspaceId,
              conversationId: payload.conversationId,
              messageId: payload.messageId,
            },
            record.value,
          );
        }),
      ),
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
            valueRenderOption: "FORMULA",
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

  return {
    getExisting,
    persistExistingSubmissionStatus,
    persistSubmission,
    resultFromRecord,
    rollbackSnapshotForUpdates,
    setConfirmationMessage,
  };
};

export type TeamSubmissionPersistence = ReturnType<typeof makeTeamSubmissionPersistence>;
