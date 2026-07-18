import type { SheetOutboundMessage, SheetTextPart } from "sheet-ingress-api/schemas/client";
import { checkinActionRow } from "./components";

export const checkinPromptMessage = (
  content: ReadonlyArray<SheetTextPart>,
  disabled = false,
): SheetOutboundMessage => ({ content, components: [checkinActionRow(disabled)] });
