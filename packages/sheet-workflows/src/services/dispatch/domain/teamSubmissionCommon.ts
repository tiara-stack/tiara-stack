import { Cause, Effect } from "effect";
import { makeUnknownError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { recoverNonInterruptCause } from "../pure/failure";

export const teamSubmissionReaction = { id: "907705464215711834", name: "Miku_Happy" } as const;
export const teamSubmissionErrorColor = 0xed4245;

type TeamSubmissionButtonContext = {
  readonly interactionResponseToken: string;
  readonly conversationId: string;
  readonly messageId: string;
};

type TeamSubmissionReactionContext = Pick<
  TeamSubmissionButtonContext,
  "conversationId" | "messageId"
>;

type BoundDeliveryClient = ReturnType<(typeof ClientDeliveryClient.Service)["forClient"]>;

export const ignoreDiscordCleanupFailure = (message: string) =>
  Effect.catchCause((cause) =>
    recoverNonInterruptCause(cause, () =>
      Effect.logWarning(message).pipe(Effect.andThen(Effect.logDebug(Cause.pretty(cause)))),
    ),
  );

export const makeFinishTeamSubmissionInteractionBestEffort =
  (
    botClient: typeof ClientDeliveryClient.Service,
    payload: TeamSubmissionButtonContext,
    logMessage: string,
  ) =>
  (content: string) =>
    botClient
      .updateOriginalInteractionResponse(payload.interactionResponseToken, {
        content,
        allowedMentions: "none",
      })
      .pipe(ignoreDiscordCleanupFailure(logMessage));

export const removeTeamSubmissionReaction = (
  deliveryClient: BoundDeliveryClient,
  payload: TeamSubmissionReactionContext,
) =>
  deliveryClient
    .removeMessageReaction(payload.conversationId, payload.messageId, teamSubmissionReaction)
    .pipe(ignoreDiscordCleanupFailure("Failed to remove team submission reaction"));

export const runTeamSubmissionButtonAction = <A, E, R>(
  action: Effect.Effect<A, E, R>,
  failureMessage: string,
  finishInteractionBestEffort: (content: string) => Effect.Effect<unknown, unknown>,
) =>
  action.pipe(
    Effect.catchCause((cause) =>
      recoverNonInterruptCause(cause, () =>
        finishInteractionBestEffort(failureMessage).pipe(
          ignoreDiscordCleanupFailure(
            "Failed to finish team submission interaction after operation failure",
          ),
          Effect.andThen(
            Effect.fail(
              markInteractionFailureHandled(
                makeUnknownError("Team submission button action failed", cause),
              ),
            ),
          ),
        ),
      ),
    ),
  );
