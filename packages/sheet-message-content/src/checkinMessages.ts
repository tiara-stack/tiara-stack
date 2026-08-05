import { Predicate } from "effect";
import type { SheetOutboundMessage } from "sheet-bot-api/message";
import type { ClientRef } from "sheet-bot-api/references";
import { escapeMarkdown, makeEmbed } from "./rendering";
import * as MessageText from "./text";

export type CheckinDmMessageContext = {
  readonly client: ClientRef;
  readonly workspaceId: string;
  readonly workspaceName?: string | undefined;
  readonly runningConversationId: string;
  readonly checkinConversationId: string;
  readonly monitorConversationId?: string | undefined;
  readonly hour: number;
};

const channelMention = (params: CheckinDmMessageContext, conversationId: string) =>
  MessageText.conversationMention(
    MessageText.conversationRef(params.client, params.workspaceId, conversationId),
  );

const workspaceNameLine = (workspaceName: string | undefined) =>
  Predicate.isString(workspaceName)
    ? [[MessageText.text(`Server: ${escapeMarkdown(workspaceName)}`)]]
    : [];

export const reminderMessage = (params: CheckinDmMessageContext): SheetOutboundMessage => ({
  content: null,
  embeds: [
    makeEmbed({
      title: `Check-in is open for hour ${params.hour}`,
      description: MessageText.lines(
        ...workspaceNameLine(params.workspaceName),
        [
          MessageText.text("Check-in channel: "),
          channelMention(params, params.checkinConversationId),
        ],
        [MessageText.text("Open the check-in message and tap Check in.")],
      ),
    }),
  ],
  allowedMentions: "none",
});

export const monitorPingMessage = (params: CheckinDmMessageContext): SheetOutboundMessage => {
  const hasMonitorConversation = Predicate.isString(params.monitorConversationId);
  const destinationConversationId = hasMonitorConversation
    ? params.monitorConversationId
    : params.runningConversationId;

  return {
    content: null,
    embeds: [
      makeEmbed({
        title: `Check-in is open for hour ${params.hour}`,
        description: MessageText.lines(
          ...workspaceNameLine(params.workspaceName),
          [
            MessageText.text(`${hasMonitorConversation ? "Monitor" : "Running"} channel: `),
            channelMention(params, destinationConversationId),
          ],
          [MessageText.text("You are assigned as monitor for this hour.")],
          [
            MessageText.text(
              hasMonitorConversation
                ? "Open the monitor channel to review the summary and check in."
                : "Open the running channel for the monitor summary and next steps.",
            ),
          ],
        ),
      }),
    ],
    allowedMentions: "none",
  };
};
