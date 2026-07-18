import type { SheetOutboundMessage } from "sheet-ingress-api/schemas/client";
import { parts, text, userMention } from "./text";

export const checkinAnnouncementMessage = (accountId: string): SheetOutboundMessage => ({
  content: parts(userMention(accountId), text(" has checked in!")),
});

export const checkinButtonAcknowledgementMessage = (
  isFirstCheckin: boolean,
): { readonly content: string } => ({
  content: isFirstCheckin ? "You have been checked in!" : "You have already been checked in!",
});
