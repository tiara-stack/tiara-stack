import type { SheetOutboundMessage, SheetTextPart } from "sheet-bot-api/message";
import { checkinActionRow } from "./components";
import { lines, subtle, text } from "./text";

export const generatingCheckinMessage = (
  content: ReadonlyArray<SheetTextPart>,
): SheetOutboundMessage => ({
  content: lines(content, [subtle([text("Controls are being prepared...")])]),
});

export const checkinPromptMessage = (
  content: ReadonlyArray<SheetTextPart>,
  disabled = false,
): SheetOutboundMessage => ({ content, components: [checkinActionRow(disabled)] });
