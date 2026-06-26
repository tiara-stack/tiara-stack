import { Effect } from "effect";
import type { SheetOutboundMessage } from "sheet-ingress-api/schemas/client";
import { ClientDeliveryClient } from "./clientDeliveryClient";
import * as MessageText from "./messageText";

type CheckinDmRecipient = {
  readonly platform: string;
  readonly userId: string;
  readonly defaultClientId: string;
};

type UserConfigService = {
  readonly getCheckinDmRecipients: (
    platform: string,
    userIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<CheckinDmRecipient>, unknown>;
};

const reminderMessage = (params: {
  readonly workspaceId: string;
  readonly runningConversationId: string;
  readonly runningConversationName?: string | undefined;
  readonly hour: number;
}): SheetOutboundMessage => ({
  content: MessageText.lines(
    [MessageText.text(`Check-in is open for hour ${params.hour}.`)],
    [MessageText.text(`Server: ${params.workspaceId}`)],
    [
      MessageText.text(
        `Running channel: ${params.runningConversationName ?? params.runningConversationId}`,
      ),
    ],
    [MessageText.text("Open the check-in message in the server and tap Check in.")],
  ),
  allowedMentions: "none",
});

export const sendCheckinOpeningDmReminders = Effect.fn("sendCheckinOpeningDmReminders")(
  function* (params: {
    readonly platform: string;
    readonly workspaceId: string;
    readonly runningConversationId: string;
    readonly runningConversationName?: string | undefined;
    readonly checkinConversationId: string;
    readonly hour: number;
    readonly fillIds: ReadonlyArray<string>;
    readonly concurrency: number;
    readonly userConfigService: UserConfigService;
    readonly botClient: typeof ClientDeliveryClient.Service;
  }) {
    const fillIds = [...new Set(params.fillIds)];
    if (fillIds.length === 0) {
      return;
    }

    const recipients = yield* params.userConfigService.getCheckinDmRecipients(
      params.platform,
      fillIds,
    );
    const message = reminderMessage(params);

    yield* Effect.forEach(
      recipients,
      (recipient) =>
        params.botClient
          .forClient({ platform: recipient.platform, clientId: recipient.defaultClientId })
          .sendDirectMessage(recipient.userId, message)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Failed to send check-in opening DM reminder").pipe(
                Effect.annotateLogs({
                  platform: recipient.platform,
                  defaultClientId: recipient.defaultClientId,
                  userId: recipient.userId,
                  workspaceId: params.workspaceId,
                  checkinConversationId: params.checkinConversationId,
                  hour: params.hour,
                }),
                Effect.andThen(Effect.logError(cause)),
                Effect.asVoid,
              ),
            ),
          ),
      { concurrency: params.concurrency },
    ).pipe(Effect.asVoid);
  },
);
