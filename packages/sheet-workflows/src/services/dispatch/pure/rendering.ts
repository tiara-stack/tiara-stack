import { Option, Predicate } from "effect";
import type { ClientConversationCacheEntry } from "sheet-message-content/rendering";

export * from "sheet-message-content/rendering";

export const isAutoCheckinEnabled = (autoCheckin: Option.Option<boolean>) =>
  Option.getOrElse(autoCheckin, () => false);

const sendableWorkspaceConversationTypes = new Set([0, 5]);
const isSendableWorkspaceConversation = (conversation: ClientConversationCacheEntry) =>
  sendableWorkspaceConversationTypes.has(conversation.value.type);
const conversationPosition = (conversation: ClientConversationCacheEntry) =>
  Predicate.isNumber(conversation.value.position)
    ? conversation.value.position
    : Number.MAX_SAFE_INTEGER;

export const workspaceWelcomeConversationCandidates = (
  conversations: ReadonlyArray<ClientConversationCacheEntry>,
  systemConversationId: string | undefined,
) => {
  const sendableConversations = conversations.filter(isSendableWorkspaceConversation);
  const byId = new Map(
    sendableConversations.map((conversation) => [conversation.resourceId, conversation]),
  );
  const candidates: Array<ClientConversationCacheEntry> = [];
  const seen = new Set<string>();
  const addCandidate = (conversation: ClientConversationCacheEntry | undefined) => {
    if (conversation !== undefined && !seen.has(conversation.resourceId)) {
      seen.add(conversation.resourceId);
      candidates.push(conversation);
    }
  };
  if (systemConversationId !== undefined) addCandidate(byId.get(systemConversationId));
  addCandidate(
    sendableConversations.find(
      (conversation) => conversation.value.name?.toLowerCase() === "general",
    ),
  );
  for (const conversation of [...sendableConversations].sort((left, right) => {
    const positionDifference = conversationPosition(left) - conversationPosition(right);
    return positionDifference === 0
      ? left.resourceId.localeCompare(right.resourceId)
      : positionDifference;
  })) {
    addCandidate(conversation);
  }
  return candidates;
};
