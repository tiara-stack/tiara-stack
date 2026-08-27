import { TENTATIVE_ROOM_ORDER_PREFIX } from "sheet-bot-api/actions";
import type { BotOutboundMessage, BotTextPart } from "sheet-bot-api/message";
import { roomOrderActionRow, tentativeRoomOrderActionRow } from "./components";
import { lines, subtle, text } from "./text";

export const generatingRoomOrderMessage = (
  content: ReadonlyArray<BotTextPart>,
): BotOutboundMessage => ({
  content: lines(content, [subtle([text("Controls are being prepared...")])]),
});

export const tentativeRoomOrderContent = (content: ReadonlyArray<BotTextPart>): BotTextPart[] =>
  lines([text(TENTATIVE_ROOM_ORDER_PREFIX)], content);

export const roomOrderDraftMessage = (
  content: ReadonlyArray<BotTextPart>,
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
  disabled = false,
): BotOutboundMessage => ({ content, components: [roomOrderActionRow(range, rank, disabled)] });

export const publishedRoomOrderMessage = (
  content: ReadonlyArray<BotTextPart>,
): BotOutboundMessage => ({ content });

export const roomOrderSendAcknowledgementMessage = (
  pinned: boolean,
): { readonly content: string } => ({
  content: pinned ? "sent room order and pinned it!" : "sent room order, but failed to pin it.",
});

export const tentativeRoomOrderMessage = (
  content: ReadonlyArray<BotTextPart>,
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
): BotOutboundMessage => ({
  content: tentativeRoomOrderContent(content),
  components: [tentativeRoomOrderActionRow(range, rank)],
});

export const tentativeRoomOrderPinAcknowledgementMessage = (
  cleanedUp: boolean,
): { readonly content: string } => ({
  content: cleanedUp
    ? "pinned tentative room order!"
    : "pinned tentative room order, but failed to clean up the message.",
});
