import { Schema } from "effect";

export const WorkspaceConversationLockdownResult = Schema.Struct({
  workspaceId: Schema.String,
  conversationId: Schema.String,
});

export type WorkspaceConversationLockdownResult = typeof WorkspaceConversationLockdownResult.Type;
