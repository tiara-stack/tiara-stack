import { Cause, Effect, Exit, Option } from "effect";
import {
  type TeamSubmissionConfirmFromDiscordPayload,
  type TeamSubmissionConfirmResult,
  type TeamSubmissionRevertFromDiscordPayload,
  type TeamSubmissionRevertResult,
} from "sheet-ingress-api/schemas/teamSubmission";
import { makeArgumentError } from "typhoon-core/error";
import type { TeamSubmissionDependencies } from "./dependencies";
import type { SubmissionLocks } from "./locks";
import type { TeamSubmissionPersistence } from "./persistence";
import {
  pendingAppendRollbackRange,
  requireActionableSubmission,
  rollbackValuesForRange,
} from "./pure";

export const makeReviewOperations = (
  { googleSheets, zero }: Pick<TeamSubmissionDependencies, "googleSheets" | "zero">,
  { withSubmissionLock }: SubmissionLocks,
  { persistExistingSubmissionStatus }: TeamSubmissionPersistence,
) => {
  const getOwnedActionableSubmission = Effect.fn(function* (
    payload: TeamSubmissionConfirmFromDiscordPayload | TeamSubmissionRevertFromDiscordPayload,
    action: "confirm" | "reject",
  ) {
    const existing = yield* zero.messageTeamSubmission.getMessageTeamSubmission({
      workspaceId: payload.workspaceId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
    });
    if (Option.isNone(existing)) {
      return yield* Effect.fail(makeArgumentError("Team submission record was not found"));
    }

    const submission = existing.value;
    if (submission.discordAuthorId !== payload.requesterUserId) {
      return yield* Effect.fail(
        makeArgumentError(`Only the original submitter can ${action} this team submission`),
      );
    }
    if (!(action === "reject" && submission.status === "reverting")) {
      yield* requireActionableSubmission(submission);
    }
    if (!Option.contains(submission.confirmationMessageId, payload.confirmationMessageId)) {
      return yield* Effect.fail(
        makeArgumentError("Team submission confirmation message does not match"),
      );
    }
    return submission;
  });

  const revertFromDiscord = Effect.fn("TeamSubmissionService.revertFromDiscord")(function* (
    payload: TeamSubmissionRevertFromDiscordPayload,
  ) {
    return yield* withSubmissionLock(
      payload,
      Effect.gen(function* () {
        const submission = yield* getOwnedActionableSubmission(payload, "reject");

        const snapshot = Option.getOrNull(submission.rollbackSnapshot);
        const resolvedSnapshot =
          snapshot?.filter((entry) => entry.range !== pendingAppendRollbackRange) ?? null;
        if (resolvedSnapshot === null || resolvedSnapshot.length === 0) {
          yield* persistExistingSubmissionStatus(submission, "rollbackFailed");
          return {
            status: "rollbackFailed",
            rowMappings: submission.rowMappings,
            rollbackSnapshot: snapshot,
            confirmationText: "Rollback failed: no rollback snapshot is available.",
          } satisfies TeamSubmissionRevertResult;
        }

        yield* persistExistingSubmissionStatus(submission, "reverting");
        const rollbackExit = yield* Effect.exit(
          googleSheets.update({
            spreadsheetId: submission.sheetId,
            requestBody: {
              valueInputOption: "USER_ENTERED",
              data: resolvedSnapshot.map((entry) => ({
                range: entry.range,
                values: rollbackValuesForRange(entry.range, entry.values),
              })),
            },
          }),
        );
        if (Exit.isFailure(rollbackExit)) {
          if (Cause.hasInterrupts(rollbackExit.cause)) {
            return yield* Effect.failCause(rollbackExit.cause);
          }
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
        const submission = yield* getOwnedActionableSubmission(payload, "confirm");

        yield* persistExistingSubmissionStatus(submission, "confirmed");
        return { status: "confirmed" } satisfies TeamSubmissionConfirmResult;
      }),
    );
  });

  return { confirmFromDiscord, revertFromDiscord };
};
