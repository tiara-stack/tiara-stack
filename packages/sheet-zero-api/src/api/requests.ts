import { Schema } from "effect";

export const MessageKeyRequest = {
  clientPlatform: Schema.String,
  clientId: Schema.String,
  messageId: Schema.String,
} as const;

export const MessageConversationKeyRequest = {
  clientPlatform: Schema.String,
  clientId: Schema.String,
  workspaceId: Schema.String,
  conversationId: Schema.String,
} as const;
