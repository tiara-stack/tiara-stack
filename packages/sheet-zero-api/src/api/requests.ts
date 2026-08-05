import { Schema } from "effect";

export const MessageKeyRequest = {
  clientPlatform: Schema.String,
  clientId: Schema.String,
  messageId: Schema.String,
} as const;
