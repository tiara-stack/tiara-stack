import { Effect, Match } from "effect";
import type {
  TeamSubmissionConfirmButtonDispatchPayload,
  TeamSubmissionConfirmButtonDispatchResult,
  TeamSubmissionRejectButtonDispatchPayload,
  TeamSubmissionRejectButtonDispatchResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchRequester } from "sheet-ingress-api/sheet-workflows-workflows";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { teamSubmissionRollbackFailedMessage } from "sheet-message-content/teamSubmissionButtons";
import { SheetApisClient } from "../../sheetApisClient";
import { logNonInterruptFailure } from "../clients/messageDelivery";
import {
  ignoreDiscordCleanupFailure,
  makeFinishTeamSubmissionInteractionBestEffort,
  removeTeamSubmissionReaction,
  runTeamSubmissionButtonAction,
  teamSubmissionErrorColor,
} from "./teamSubmissionCommon";

export const makeTeamSubmissionButtonOperations = ({
  botClient,
  sheetApisClient,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly sheetApisClient: typeof SheetApisClient.Service;
}) => ({
  teamSubmissionConfirmButton: Effect.fn("DispatchService.teamSubmissionConfirmButton")(function* (
    payload: TeamSubmissionConfirmButtonDispatchPayload,
    requester: DispatchRequester,
  ) {
    const deliveryClient = botClient.forClient(payload.client);
    const finishInteractionBestEffort = makeFinishTeamSubmissionInteractionBestEffort(
      botClient,
      payload,
      "Failed to update team submission confirm interaction response",
    );

    yield* runTeamSubmissionButtonAction(
      sheetApisClient.get().teamSubmission.confirmFromDiscord({
        payload: {
          client: payload.client,
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          confirmationMessageId: payload.confirmationMessageId,
          requesterUserId: requester.accountId,
        },
      }),
      "Could not confirm this team submission. Please try again.",
      finishInteractionBestEffort,
    );
    yield* finishInteractionBestEffort("Team submission confirmed.");
    yield* deliveryClient
      .deleteMessage(payload.conversationId, payload.confirmationMessageId)
      .pipe(ignoreDiscordCleanupFailure("Failed to delete team submission confirmation"));
    yield* removeTeamSubmissionReaction(deliveryClient, payload);

    return { status: "confirmed" } satisfies TeamSubmissionConfirmButtonDispatchResult;
  }),
  teamSubmissionRejectButton: Effect.fn("DispatchService.teamSubmissionRejectButton")(function* (
    payload: TeamSubmissionRejectButtonDispatchPayload,
    requester: DispatchRequester,
  ) {
    const deliveryClient = botClient.forClient(payload.client);
    const editRollbackFailedReply = (confirmationText: string) =>
      deliveryClient.updateMessage(
        payload.conversationId,
        payload.confirmationMessageId,
        teamSubmissionRollbackFailedMessage(confirmationText, teamSubmissionErrorColor),
      );
    const finishInteractionBestEffort = makeFinishTeamSubmissionInteractionBestEffort(
      botClient,
      payload,
      "Failed to update team submission interaction response",
    );
    const result = yield* runTeamSubmissionButtonAction(
      sheetApisClient.get().teamSubmission.revertFromDiscord({
        payload: {
          client: payload.client,
          workspaceId: payload.workspaceId,
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          confirmationMessageId: payload.confirmationMessageId,
          requesterUserId: requester.accountId,
        },
      }),
      "Could not reject this team submission. Please try again.",
      finishInteractionBestEffort,
    );
    return yield* Match.value(result.status).pipe(
      Match.when("rejected", () =>
        Effect.gen(function* () {
          yield* finishInteractionBestEffort("Team submission rejected and rolled back.");
          yield* removeTeamSubmissionReaction(deliveryClient, payload);
          yield* deliveryClient
            .deleteMessage(payload.conversationId, payload.confirmationMessageId)
            .pipe(ignoreDiscordCleanupFailure("Failed to delete team submission confirmation"));
          return { status: "rejected" } satisfies TeamSubmissionRejectButtonDispatchResult;
        }),
      ),
      Match.when("rollbackFailed", () =>
        Effect.gen(function* () {
          const replyUpdated = yield* editRollbackFailedReply(result.confirmationText).pipe(
            Effect.as(true),
            logNonInterruptFailure(
              "Failed to update the team submission rollback failure reply",
              {},
              Effect.succeed(false),
            ),
          );
          yield* finishInteractionBestEffort(
            replyUpdated
              ? "Rollback failed. Please check the updated reply."
              : `Rollback failed: ${result.confirmationText}`,
          );
          yield* removeTeamSubmissionReaction(deliveryClient, payload);
          return {
            status: "rollbackFailed",
          } satisfies TeamSubmissionRejectButtonDispatchResult;
        }),
      ),
      Match.exhaustive,
    );
  }),
});
