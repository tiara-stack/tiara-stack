import { Effect } from "effect";
import type { SheetOutboundMessage } from "sheet-ingress-api/schemas/client";
import { ClientDeliveryClient } from "./clientDeliveryClient";
import * as MessageText from "./messageText";

type DmRecipient = {
  readonly platform: string;
  readonly userId: string;
  readonly defaultClientId: string;
};

type MessageContext = {
  readonly workspaceId: string;
  readonly runningConversationId: string;
  readonly runningConversationName?: string | undefined;
  readonly checkinConversationId: string;
  readonly hour: number;
};

type UserConfigService = {
  readonly getCheckinDmRecipients: (
    platform: string,
    userIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<DmRecipient>, unknown>;
  readonly getMonitorDmRecipients: (
    platform: string,
    userIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<DmRecipient>, unknown>;
};

const openingLines = (params: MessageContext) => [
  [MessageText.text(`Check-in is open for hour ${params.hour}.`)],
  [MessageText.text(`Server: ${params.workspaceId}`)],
  [
    MessageText.text(
      `Running channel: ${params.runningConversationName ?? params.runningConversationId}`,
    ),
  ],
];

const reminderMessage = (params: MessageContext): SheetOutboundMessage => ({
  content: MessageText.lines(...openingLines(params), [
    MessageText.text("Open the check-in message in the server and tap Check in."),
  ]),
  allowedMentions: "none",
});

const monitorPingMessage = (params: MessageContext): SheetOutboundMessage => ({
  content: MessageText.lines(
    ...openingLines(params),
    [MessageText.text("You are assigned as monitor for this hour.")],
    [MessageText.text("Open the running channel for the monitor summary and next steps.")],
  ),
  allowedMentions: "none",
});

const sendDirectMessages = Effect.fn("sendDirectMessages")(function* (params: {
  readonly recipients: ReadonlyArray<DmRecipient>;
  readonly message: SheetOutboundMessage;
  readonly failureMessage: string;
  readonly context: MessageContext;
  readonly concurrency: number;
  readonly botClient: typeof ClientDeliveryClient.Service;
}) {
  yield* Effect.forEach(
    params.recipients,
    (recipient) =>
      params.botClient
        .forClient({ platform: recipient.platform, clientId: recipient.defaultClientId })
        .sendDirectMessage(recipient.userId, params.message)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logError(params.failureMessage).pipe(
              Effect.annotateLogs({
                platform: recipient.platform,
                defaultClientId: recipient.defaultClientId,
                userId: recipient.userId,
                workspaceId: params.context.workspaceId,
                checkinConversationId: params.context.checkinConversationId,
                hour: params.context.hour,
              }),
              Effect.andThen(Effect.logError(cause)),
              Effect.asVoid,
            ),
          ),
        ),
    { concurrency: params.concurrency },
  ).pipe(Effect.asVoid);
});

export const sendCheckinOpeningDmReminders = Effect.fn("sendCheckinOpeningDmReminders")(function* (
  params: MessageContext & {
    readonly platform: string;
    readonly fillIds: ReadonlyArray<string>;
    readonly concurrency: number;
    readonly userConfigService: UserConfigService;
    readonly botClient: typeof ClientDeliveryClient.Service;
  },
) {
  const fillIds = [...new Set(params.fillIds)];
  if (fillIds.length === 0) {
    return;
  }

  const recipients = yield* params.userConfigService.getCheckinDmRecipients(
    params.platform,
    fillIds,
  );
  yield* sendDirectMessages({
    recipients,
    message: reminderMessage(params),
    failureMessage: "Failed to send check-in opening DM reminder",
    context: params,
    concurrency: params.concurrency,
    botClient: params.botClient,
  });
});

export const sendMonitorCheckinOpeningDmPing = Effect.fn("sendMonitorCheckinOpeningDmPing")(
  function* (
    params: MessageContext & {
      readonly platform: string;
      readonly monitorUserId: string | null;
      readonly concurrency: number;
      readonly userConfigService: UserConfigService;
      readonly botClient: typeof ClientDeliveryClient.Service;
    },
  ) {
    if (params.monitorUserId === null) {
      return;
    }

    const recipients = yield* params.userConfigService.getMonitorDmRecipients(params.platform, [
      params.monitorUserId,
    ]);
    yield* sendDirectMessages({
      recipients,
      message: monitorPingMessage(params),
      failureMessage: "Failed to send monitor check-in opening DM ping",
      context: params,
      concurrency: params.concurrency,
      botClient: params.botClient,
    });
  },
);
