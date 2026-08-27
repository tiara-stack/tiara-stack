import type { BotOutboundMessage, BotTextPart } from "sheet-bot-api/message";
import { checkinActionRow } from "./components";
import { lines, subtle, text } from "./text";

export const generatingCheckinMessage = (
  content: ReadonlyArray<BotTextPart>,
): BotOutboundMessage => ({
  content: lines(content, [subtle([text("Controls are being prepared...")])]),
});

export const checkinPromptMessage = (
  content: ReadonlyArray<BotTextPart>,
  disabled = false,
): BotOutboundMessage => ({ content, components: [checkinActionRow(disabled)] });
