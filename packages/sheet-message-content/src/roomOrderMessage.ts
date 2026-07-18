import { TENTATIVE_ROOM_ORDER_PREFIX } from "sheet-ingress-api/clientActions";
import type { SheetOutboundMessage, SheetTextPart } from "sheet-ingress-api/schemas/client";
import { roomOrderActionRow, tentativeRoomOrderActionRow } from "./components";
import { lines, text } from "./text";

export const tentativeRoomOrderContent = (content: ReadonlyArray<SheetTextPart>): SheetTextPart[] =>
  lines([text(TENTATIVE_ROOM_ORDER_PREFIX)], content);

export const roomOrderDraftMessage = (
  content: ReadonlyArray<SheetTextPart>,
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
  disabled = false,
): SheetOutboundMessage => ({ content, components: [roomOrderActionRow(range, rank, disabled)] });

export const publishedRoomOrderMessage = (
  content: ReadonlyArray<SheetTextPart>,
): SheetOutboundMessage => ({ content });

export const roomOrderSendAcknowledgementMessage = (
  pinned: boolean,
): { readonly content: string } => ({
  content: pinned ? "sent room order and pinned it!" : "sent room order, but failed to pin it.",
});

export const tentativeRoomOrderMessage = (
  content: ReadonlyArray<SheetTextPart>,
  range: { readonly minRank: number; readonly maxRank: number },
  rank: number,
): SheetOutboundMessage => ({
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
