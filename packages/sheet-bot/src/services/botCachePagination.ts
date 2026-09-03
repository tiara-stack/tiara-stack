import { Buffer } from "node:buffer";
import type { ParentCachePage } from "dfx-discord-utils/cache";
import { Effect, Equal, Predicate, Schema } from "effect";
import {
  BotCollectionCursor,
  BotRequestRejected,
  type BotConversation,
  type BotConversationPage,
  type BotMember,
  type BotMemberPage,
} from "sheet-bot-api";
import { getNumberField, getObjectField, getStringField } from "./unknownObjectFields";

const BotCacheCollection = Schema.Literals(["conversations", "members"]);
type BotCacheCollection = Schema.Schema.Type<typeof BotCacheCollection>;

export interface BotCollectionCursorContext {
  readonly collection: BotCacheCollection;
  readonly platform: string;
  readonly clientId: string;
  readonly workspaceId: string;
}

const BotCollectionCursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  collection: BotCacheCollection,
  platform: Schema.String,
  clientId: Schema.String,
  workspaceId: Schema.String,
  after: Schema.String,
});

const invalidCursor = () =>
  new BotRequestRejected({ message: "Collection cursor is invalid for this cache read" });

export const encodeBotCollectionCursor = (
  context: BotCollectionCursorContext,
  after: string,
): BotCollectionCursor =>
  Schema.decodeUnknownSync(BotCollectionCursor)(
    Buffer.from(JSON.stringify({ version: 1, ...context, after }), "utf8").toString("base64url"),
  );

export const decodeBotCollectionCursor = (
  cursor: BotCollectionCursor | undefined,
  context: BotCollectionCursorContext,
): Effect.Effect<string | undefined, BotRequestRejected> => {
  if (Predicate.isUndefined(cursor)) return Effect.succeed(undefined);
  return Effect.try({
    try: () => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    catch: invalidCursor,
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(BotCollectionCursorPayload)),
    Effect.filterOrFail(
      (payload) =>
        Equal.equals(payload.collection, context.collection) &&
        Equal.equals(payload.platform, context.platform) &&
        Equal.equals(payload.clientId, context.clientId) &&
        Equal.equals(payload.workspaceId, context.workspaceId),
      invalidCursor,
    ),
    Effect.map((payload) => payload.after),
    Effect.tapError((error) => Effect.logDebug("Bot collection cursor decoding failed", error)),
    Effect.mapError(invalidCursor),
  );
};

export const botConversationView = (
  id: string,
  conversation: { readonly type: number },
  canSendMessages: boolean,
): BotConversation => {
  const workspaceId = getStringField(conversation, "guild_id");
  const name = getStringField(conversation, "name");
  const position = getNumberField(conversation, "position");
  return {
    id,
    type: conversation.type,
    canSendMessages,
    ...(Predicate.isUndefined(workspaceId) ? {} : { workspaceId }),
    ...(Predicate.isUndefined(name) ? {} : { name }),
    ...(Predicate.isUndefined(position) ? {} : { position }),
  };
};

export const botMemberView = (
  userId: string,
  member: { readonly roles: ReadonlyArray<string> },
): BotMember => {
  const nickname = getStringField(member, "nick");
  const user = getObjectField(member, "user");
  const displayName =
    nickname ?? getStringField(user, "global_name") ?? getStringField(user, "username");
  return {
    userId,
    roleIds: [...member.roles],
    ...(Predicate.isUndefined(displayName) ? {} : { displayName }),
  };
};

export const botConversationPage = <Conversation extends { readonly type: number }>(
  context: BotCollectionCursorContext,
  page: ParentCachePage<Conversation>,
  canSendMessages: (conversation: Conversation) => boolean,
): BotConversationPage => ({
  items: Array.from(page.entries, ([id, conversation]) =>
    botConversationView(id, conversation, canSendMessages(conversation)),
  ),
  ...(Predicate.isUndefined(page.nextCursor)
    ? {}
    : { nextCursor: encodeBotCollectionCursor(context, page.nextCursor) }),
});

export const botMemberPage = (
  context: BotCollectionCursorContext,
  page: ParentCachePage<{ readonly roles: ReadonlyArray<string> }>,
): BotMemberPage => ({
  items: Array.from(page.entries, ([userId, member]) => botMemberView(userId, member)),
  ...(Predicate.isUndefined(page.nextCursor)
    ? {}
    : { nextCursor: encodeBotCollectionCursor(context, page.nextCursor) }),
});
