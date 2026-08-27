import type { BotOutboundMessage } from "sheet-bot-api/message";
import { parts, text, userMention } from "./text";

export const checkinAnnouncementMessage = (accountId: string): BotOutboundMessage => ({
  content: parts(userMention(accountId), text(" has checked in!")),
});

export const checkinButtonAcknowledgementMessage = (
  isFirstCheckin: boolean,
): { readonly content: string } => ({
  content: isFirstCheckin ? "You have been checked in!" : "You have already been checked in!",
});
