import type { SheetOutboundMessage } from "sheet-ingress-api/schemas/client";
import * as MessageText from "./text";

export type CheckinDmMessageContext = {
  readonly workspaceId: string;
  readonly runningConversationId: string;
  readonly runningConversationName?: string | undefined;
  readonly checkinConversationId: string;
  readonly hour: number;
};

const openingLines = (params: CheckinDmMessageContext) => [
  [MessageText.text(`Check-in is open for hour ${params.hour}.`)],
  [MessageText.text(`Server: ${params.workspaceId}`)],
  [
    MessageText.text(
      `Running channel: ${params.runningConversationName ?? params.runningConversationId}`,
    ),
  ],
];

export const reminderMessage = (params: CheckinDmMessageContext): SheetOutboundMessage => ({
  content: MessageText.lines(...openingLines(params), [
    MessageText.text("Open the check-in message in the server and tap Check in."),
  ]),
  allowedMentions: "none",
});

export const monitorPingMessage = (params: CheckinDmMessageContext): SheetOutboundMessage => ({
  content: MessageText.lines(
    ...openingLines(params),
    [MessageText.text("You are assigned as monitor for this hour.")],
    [MessageText.text("Open the running channel for the monitor summary and next steps.")],
  ),
  allowedMentions: "none",
});
