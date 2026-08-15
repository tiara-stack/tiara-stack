import { Effect, Predicate } from "effect";
import type {
  BotCollectionCursor,
  BotConversation,
  BotConversationPage,
  SheetBotHttpClient,
} from "sheet-bot-api";
import { maximumBotCollectionPageSize } from "sheet-bot-api";
import { mapBotCacheFailure } from "../shared/interactive";

const maximumDiscordGuildChannelCount = 500;
const maximumDiscordActiveThreadCount = 1_000;
const maximumDiscordWorkspaceConversationCount =
  maximumDiscordGuildChannelCount + maximumDiscordActiveThreadCount;
const maximumConversationPageCount = Math.ceil(
  maximumDiscordWorkspaceConversationCount / maximumBotCollectionPageSize,
);
const discordGuildTextConversationType = 0;
const discordGuildAnnouncementConversationType = 5;

type DiscordClient = { readonly platform: "discord"; readonly clientId: string };

const isSendableConversation = ({ type }: BotConversation): boolean =>
  type === discordGuildTextConversationType || type === discordGuildAnnouncementConversationType;

const conversationPosition = ({ position }: BotConversation): number =>
  Predicate.isNumber(position) ? position : Number.MAX_SAFE_INTEGER;

const byPositionThenId = (left: BotConversation, right: BotConversation): number => {
  const positionDifference = conversationPosition(left) - conversationPosition(right);
  if (positionDifference !== 0) return positionDifference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

export const selectWorkspaceConversation = (
  conversations: ReadonlyArray<BotConversation>,
  systemConversationId: string | undefined,
): BotConversation | undefined => {
  const sendable = conversations.filter(isSendableConversation).sort(byPositionThenId);
  if (Predicate.isNotUndefined(systemConversationId)) {
    const systemConversation = sendable.find(({ id }) => id === systemConversationId);
    if (Predicate.isNotUndefined(systemConversation)) return systemConversation;
  }
  const general = sendable.find(({ name }) => name?.toLowerCase() === "general");
  if (Predicate.isNotUndefined(general)) return general;
  return sendable[0];
};

const readConversationPage = <E>(
  cache: SheetBotHttpClient["cache"],
  client: DiscordClient,
  workspaceId: string,
  cursor: BotCollectionCursor | undefined,
  policy: string,
  operation: string,
  operationError: (operation: string, cause: unknown) => E,
) =>
  cache
    .listConversations({
      params: { ...client, workspaceId },
      query: {
        limit: maximumBotCollectionPageSize,
        ...(Predicate.isUndefined(cursor) ? {} : { cursor }),
      },
    })
    .pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(
        mapBotCacheFailure(policy, "workspace conversations", operation, operationError),
      ),
    );

const appendConversation = <E>(
  conversations: Array<BotConversation>,
  seenConversationIds: Set<string>,
  workspaceId: string,
  conversation: BotConversation,
  operation: string,
  operationError: (operation: string, cause: unknown) => E,
) => {
  const inconsistent =
    (Predicate.isNotUndefined(conversation.workspaceId) &&
      conversation.workspaceId !== workspaceId) ||
    seenConversationIds.has(conversation.id);
  if (inconsistent) {
    return Effect.fail(
      operationError(operation, "The bot cache returned an inconsistent conversation page"),
    );
  }
  seenConversationIds.add(conversation.id);
  conversations.push(conversation);
  return Effect.void;
};

const appendConversationPage = <E>(
  conversations: Array<BotConversation>,
  seenConversationIds: Set<string>,
  workspaceId: string,
  page: BotConversationPage,
  operation: string,
  operationError: (operation: string, cause: unknown) => E,
) =>
  page.items.length > maximumBotCollectionPageSize
    ? Effect.fail(
        operationError(operation, "The bot cache returned an oversized conversation page"),
      )
    : Effect.forEach(
        page.items,
        (conversation) =>
          appendConversation(
            conversations,
            seenConversationIds,
            workspaceId,
            conversation,
            operation,
            operationError,
          ),
        { concurrency: 1, discard: true },
      );

export const loadWorkspaceConversations = <E>(options: {
  readonly cache: SheetBotHttpClient["cache"];
  readonly client: DiscordClient;
  readonly workspaceId: string;
  readonly policy: string;
  readonly operation: string;
  readonly operationError: (operation: string, cause: unknown) => E;
}) =>
  Effect.gen(function* () {
    const conversations: Array<BotConversation> = [];
    const seenConversationIds = new Set<string>();
    const seenCursors = new Set<string>();
    let pageReadCount = 0;
    let cursor: BotCollectionCursor | undefined;
    while (true) {
      if (pageReadCount >= maximumConversationPageCount) {
        return yield* Effect.fail(
          options.operationError(
            options.operation,
            "The bot cache returned too many conversation pages",
          ),
        );
      }
      pageReadCount += 1;
      const page = yield* readConversationPage(
        options.cache,
        options.client,
        options.workspaceId,
        cursor,
        options.policy,
        options.operation,
        options.operationError,
      );
      yield* appendConversationPage(
        conversations,
        seenConversationIds,
        options.workspaceId,
        page,
        options.operation,
        options.operationError,
      );
      if (Predicate.isUndefined(page.nextCursor)) return conversations;
      if (seenCursors.has(page.nextCursor)) {
        return yield* Effect.fail(
          options.operationError(
            options.operation,
            "The bot cache returned a repeated conversation cursor",
          ),
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  });
