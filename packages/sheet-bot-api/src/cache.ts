import { Effect, Schema } from "effect";

export const BotApplication = Schema.Struct({ ownerId: Schema.String });
export type BotApplication = Schema.Schema.Type<typeof BotApplication>;

export const BotWorkspace = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.NullOr(Schema.String),
  ownerId: Schema.String,
});
export type BotWorkspace = Schema.Schema.Type<typeof BotWorkspace>;

export const BotConversation = Schema.Struct({
  id: Schema.String,
  type: Schema.Number,
  canSendMessages: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  workspaceId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  position: Schema.optional(Schema.Number),
});
export type BotConversation = Schema.Schema.Type<typeof BotConversation>;

export const BotRole = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.Int,
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

export const BotUserProfile = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    username: Schema.String,
    displayName: Schema.NullOr(Schema.String),
    avatar: Schema.NullOr(Schema.String),
  }),
  workspaces: Schema.Array(BotWorkspace),
});
export type BotUserProfile = Schema.Schema.Type<typeof BotUserProfile>;

export const maximumBotCollectionPageSize = 100;

export const BotCollectionPageSize = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: maximumBotCollectionPageSize }),
);
export type BotCollectionPageSize = Schema.Schema.Type<typeof BotCollectionPageSize>;

export const BotCollectionCursor = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.brand("sheet-bot-api/BotCollectionCursor"),
);
export type BotCollectionCursor = Schema.Schema.Type<typeof BotCollectionCursor>;

export const BotCollectionPageRequest = Schema.Struct({
  limit: BotCollectionPageSize,
  cursor: Schema.optional(BotCollectionCursor),
});
export type BotCollectionPageRequest = Schema.Schema.Type<typeof BotCollectionPageRequest>;

export const BotConversationPage = Schema.Struct({
  items: Schema.Array(BotConversation),
  nextCursor: Schema.optional(BotCollectionCursor),
});
export type BotConversationPage = Schema.Schema.Type<typeof BotConversationPage>;

export const BotMemberPage = Schema.Struct({
  items: Schema.Array(BotMember),
  nextCursor: Schema.optional(BotCollectionCursor),
});
export type BotMemberPage = Schema.Schema.Type<typeof BotMemberPage>;

/** @deprecated Use BotConversationPage for bounded collection reads. */
export const BotConversations = Schema.Array(BotConversation);
export type BotConversations = Schema.Schema.Type<typeof BotConversations>;
export const BotRoles = Schema.Array(BotRole);
export type BotRoles = Schema.Schema.Type<typeof BotRoles>;
/** @deprecated Use BotMemberPage for bounded collection reads. */
export const BotMembers = Schema.Array(BotMember);
export type BotMembers = Schema.Schema.Type<typeof BotMembers>;
