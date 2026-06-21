import { Schema } from "effect";

export const ClientPlatform = Schema.String.check(
  Schema.makeFilter<string>((value) => value.trim().length > 0, {
    expected: "a non-empty client platform",
  }),
);

export type ClientPlatform = Schema.Schema.Type<typeof ClientPlatform>;

export const ClientRef = Schema.Struct({
  platform: ClientPlatform,
  clientId: Schema.String,
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

export const InteractionRef = Schema.Struct({
  client: ClientRef,
  token: Schema.String,
  deadlineEpochMs: Schema.Number,
});

export type InteractionRef = Schema.Schema.Type<typeof InteractionRef>;

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

export const interactionRefFrom = (
  client: ClientRef,
  token: string,
  deadlineEpochMs: number,
): InteractionRef => ({
  client,
  token,
  deadlineEpochMs,
});
