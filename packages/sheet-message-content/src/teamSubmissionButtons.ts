import type { SheetOutboundMessage } from "sheet-bot-api/message";
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
