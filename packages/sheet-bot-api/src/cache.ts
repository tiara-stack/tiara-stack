import { Schema } from "effect";

export const BotApplication = Schema.Struct({ ownerId: Schema.String });
export type BotApplication = Schema.Schema.Type<typeof BotApplication>;

export const BotWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  ownerId: Schema.String,
});
export type BotWorkspace = Schema.Schema.Type<typeof BotWorkspace>;

export const BotConversation = Schema.Struct({
  id: Schema.String,
  type: Schema.Number,
  workspaceId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
});
export type BotConversation = Schema.Schema.Type<typeof BotConversation>;

export const BotRole = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  permissions: Schema.String.check(Schema.isPattern(/^\d+$/)),
  position: Schema.Number,
  managed: Schema.Boolean,
});
export type BotRole = Schema.Schema.Type<typeof BotRole>;

export const BotMember = Schema.Struct({
  userId: Schema.String,
  roleIds: Schema.Array(Schema.String),
  displayName: Schema.optional(Schema.String),
});
export type BotMember = Schema.Schema.Type<typeof BotMember>;

export const BotConversations = Schema.Array(BotConversation);
export type BotConversations = Schema.Schema.Type<typeof BotConversations>;
export const BotRoles = Schema.Array(BotRole);
export type BotRoles = Schema.Schema.Type<typeof BotRoles>;
export const BotMembers = Schema.Array(BotMember);
export type BotMembers = Schema.Schema.Type<typeof BotMembers>;
