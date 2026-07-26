import type { SheetOutboundMessage, SheetTextPart } from "sheet-ingress-api/schemas/client";
import { checkinActionRow } from "./components";
import { text } from "./text";

export const generatingCheckinMessage = (): SheetOutboundMessage => ({
  content: [text("Generating check-in message...")],
});

export const checkinPromptMessage = (
  content: ReadonlyArray<SheetTextPart>,
  disabled = false,
): SheetOutboundMessage => ({ content, components: [checkinActionRow(disabled)] });
