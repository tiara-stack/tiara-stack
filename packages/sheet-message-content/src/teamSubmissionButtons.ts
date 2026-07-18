import type { SheetOutboundMessage } from "sheet-ingress-api/schemas/client";
import { teamSubmissionConfirmationActionRow } from "./components";
import { makeEmbed } from "./rendering";

export const teamSubmissionRollbackFailedMessage = (
  confirmationText: string,
  color: number,
): SheetOutboundMessage => ({
  embeds: [makeEmbed({ title: "Rollback failed", description: confirmationText, color })],
  components: [teamSubmissionConfirmationActionRow(true)],
  allowedMentions: "none",
});
