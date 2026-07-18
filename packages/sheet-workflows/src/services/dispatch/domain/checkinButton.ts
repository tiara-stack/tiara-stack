import { DateTime, Effect, Option, Random } from "effect";
import type {
  CheckinHandleButtonPayload,
  CheckinHandleButtonResult,
} from "sheet-ingress-api/sheet-apis-rpc";
import type { DispatchRequester } from "sheet-ingress-api/sheet-workflows-workflows";
import { makeArgumentError } from "typhoon-core/error";
import { markInteractionFailureHandled } from "@/handlers/shared/interactionFailure";
import { ClientDeliveryClient } from "../../clientDeliveryClient";
import { checkinActionRow } from "sheet-message-content/components";
import {
  checkinAnnouncementMessage,
  checkinButtonAcknowledgementMessage,
} from "sheet-message-content/checkinAnnouncement";
import { makeSheetApisServices } from "../clients/sheetApis";
import { logNonInterruptFailure } from "../clients/messageDelivery";
import { renderCheckedInContent } from "sheet-message-content/rendering";
import { requireSome } from "../pure/option";
import { shortRoleRetrySchedule } from "../pure/retry";

type MessageCheckinService = ReturnType<typeof makeSheetApisServices>["messageCheckinService"];

export const makeCheckinButtonOperations = ({
  botClient,
  messageCheckinService,
}: {
  readonly botClient: typeof ClientDeliveryClient.Service;
  readonly messageCheckinService: MessageCheckinService;
}) => ({
  checkinButton: Effect.fn("DispatchService.checkinButton")(function* (
    payload: CheckinHandleButtonPayload,
    requester: DispatchRequester,
  ) {
    yield* Effect.annotateCurrentSpan({
      messageId: payload.messageId,
      "requester.accountId": requester.accountId,
      "requester.userId": requester.userId,
    });
    const accountId = requester.accountId;
    const checkinAt = DateTime.toEpochMillis(yield* DateTime.now);
    const checkinClaimId = yield* Random.nextUUIDv4;

    const maybeMessageCheckinData = yield* messageCheckinService.getMessageCheckinData(
      payload.messageId,
    );
    const failCheckinInteraction = (content: string, errorMessage: string) =>
      botClient
        .updateOriginalInteractionResponse(payload.interactionResponseToken, {
          content,
        })
        .pipe(
          Effect.andThen(
            Effect.fail(markInteractionFailureHandled(makeArgumentError(errorMessage))),
          ),
        );
    const requireRegisteredField = <A>(
      value: Option.Option<A>,
      content: string,
      errorMessage: string,
    ) => requireSome(value, () => failCheckinInteraction(content, errorMessage));
    const messageCheckinData = yield* requireRegisteredField(
      maybeMessageCheckinData,
      "This check-in message is not registered.",
      "Cannot handle check-in button, message is not registered",
    );
    const messageConversationId = yield* requireRegisteredField(
      messageCheckinData.conversationId,
      "This check-in message conversation is not registered.",
      "Cannot handle check-in button, message conversation is not registered",
    );
    const workspaceId = yield* requireRegisteredField(
      messageCheckinData.workspaceId,
      "This check-in message workspace is not registered.",
      "Cannot handle check-in button, message workspace is not registered",
    );

    const checkedInMember = yield* messageCheckinService
      .setMessageCheckinMemberCheckinAtIfUnset(
        payload.messageId,
        accountId,
        checkinAt,
        checkinClaimId,
      )
      .pipe(
        Effect.catch((error) =>
          botClient
            .updateOriginalInteractionResponse(payload.interactionResponseToken, {
              content: "We could not check you in. Please try again.",
            })
            .pipe(Effect.andThen(Effect.fail(markInteractionFailureHandled(error)))),
        ),
      );
    const isFirstCheckin = Option.contains(checkedInMember.checkinClaimId, checkinClaimId);

    yield* botClient
      .updateOriginalInteractionResponse(
        payload.interactionResponseToken,
        checkinButtonAcknowledgementMessage(isFirstCheckin),
      )
      .pipe(
        logNonInterruptFailure(
          "Failed to acknowledge button check-in",
          { workspaceId, accountId, messageId: payload.messageId },
          Effect.void,
        ),
      );

    if (Option.isSome(messageCheckinData.roleId)) {
      const roleId = messageCheckinData.roleId.value;
      // Re-apply the role on repeat clicks to repair missed adapter side effects.
      yield* botClient.addWorkspaceMemberRole(workspaceId, accountId, roleId).pipe(
        Effect.retry(shortRoleRetrySchedule),
        logNonInterruptFailure(
          "Failed to add check-in role after button check-in",
          {
            workspaceId,
            accountId,
            roleId,
            messageId: payload.messageId,
          },
          Effect.void,
        ),
      );
    }

    const checkedInMembers = yield* messageCheckinService.getMessageCheckinMembers(
      payload.messageId,
    );
    const content = renderCheckedInContent(messageCheckinData.initialMessage, checkedInMembers);

    yield* botClient
      .updateMessage(messageConversationId, payload.messageId, {
        content,
        components: [checkinActionRow()],
      })
      .pipe(
        logNonInterruptFailure(
          "Failed to update check-in message after button check-in",
          {
            workspaceId,
            messageId: payload.messageId,
            messageConversationId,
            accountId,
          },
          Effect.void,
        ),
      );

    if (isFirstCheckin) {
      yield* botClient
        .sendMessage(
          messageCheckinData.runningConversationId,
          checkinAnnouncementMessage(accountId),
        )
        .pipe(
          logNonInterruptFailure(
            "Failed to announce button check-in",
            {
              workspaceId,
              accountId,
              conversationId: messageCheckinData.runningConversationId,
              messageId: payload.messageId,
            },
            Effect.void,
          ),
        );
    }

    return {
      messageId: payload.messageId,
      messageConversationId,
      checkedInMemberId: accountId,
    } satisfies CheckinHandleButtonResult;
  }),
});
