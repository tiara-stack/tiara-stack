import { Schema } from "effect";
import { ClientRef, type ClientRef as ClientRefType } from "sheet-bot-api/references";

export {
  ClientPlatform,
  ClientRef,
  ClientUserRef,
  ConversationRef,
  MessageRef,
  WorkspaceRef,
  conversationRefFrom,
  messageRefFrom,
  workspaceRefFrom,
} from "sheet-bot-api/references";

export const InteractionRef = Schema.Struct({
  client: ClientRef,
  token: Schema.String,
  deadlineEpochMs: Schema.Number,
});

export type InteractionRef = Schema.Schema.Type<typeof InteractionRef>;

export const interactionRefFrom = (
  client: ClientRefType,
  token: string,
  deadlineEpochMs: number,
): InteractionRef => ({
  client,
  token,
  deadlineEpochMs,
});
