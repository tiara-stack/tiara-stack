import { Schema } from "effect";

export const ClientPlatform = Schema.Trimmed.check(Schema.isNonEmpty());
export type ClientPlatform = Schema.Schema.Type<typeof ClientPlatform>;

export const ClientRef = Schema.Struct({
  platform: ClientPlatform,
  clientId: Schema.Trimmed.check(Schema.isNonEmpty()),
});
export type ClientRef = Schema.Schema.Type<typeof ClientRef>;

export const WorkspaceRef = Schema.Struct({
  client: ClientRef,
  workspaceId: Schema.String,
});
export type WorkspaceRef = Schema.Schema.Type<typeof WorkspaceRef>;

export const ConversationRef = Schema.Struct({
  workspace: WorkspaceRef,
  conversationId: Schema.String,
});
export type ConversationRef = Schema.Schema.Type<typeof ConversationRef>;

export const MessageRef = Schema.Struct({
  conversation: ConversationRef,
  messageId: Schema.String,
});
export type MessageRef = Schema.Schema.Type<typeof MessageRef>;

export const ClientUserRef = Schema.Struct({
  client: ClientRef,
  userId: Schema.String,
});
export type ClientUserRef = Schema.Schema.Type<typeof ClientUserRef>;

const OpaqueReference = Schema.Trimmed.check(Schema.isNonEmpty());

export const ResponseReference = OpaqueReference.pipe(
  Schema.brand("sheet-bot-api/ResponseReference"),
);
export type ResponseReference = Schema.Schema.Type<typeof ResponseReference>;

export const DeliveryKey = OpaqueReference.pipe(Schema.brand("sheet-bot-api/DeliveryKey"));
export type DeliveryKey = Schema.Schema.Type<typeof DeliveryKey>;

export const workspaceRefFrom = (client: ClientRef, workspaceId: string): WorkspaceRef => ({
  client,
  workspaceId,
});

export const conversationRefFrom = (
  client: ClientRef,
  workspaceId: string,
  conversationId: string,
): ConversationRef => ({
  workspace: workspaceRefFrom(client, workspaceId),
  conversationId,
});

export const messageRefFrom = (
  client: ClientRef,
  workspaceId: string,
  conversationId: string,
  messageId: string,
): MessageRef => ({
  conversation: conversationRefFrom(client, workspaceId, conversationId),
  messageId,
});
