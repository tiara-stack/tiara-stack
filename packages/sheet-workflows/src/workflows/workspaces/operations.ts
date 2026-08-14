import { Effect, Layer, Predicate } from "effect";
import {
  type BotCollectionCursor,
  type BotConversation,
  type BotConversationPage,
  type ConversationRef,
  type SheetBotHttpClient,
  conversationRefFrom,
  maximumBotCollectionPageSize,
} from "sheet-bot-api";
import { config } from "@/config";
import { SheetBotCacheClient } from "@/services/sheetBotCacheClient";
import { SheetBotDeliveryClient } from "@/services/sheetBotDeliveryClient";
import {
  interactiveDeliveryRejected,
  interactiveInvalidRequest,
  interactiveResourceNotFound,
  mapBotCacheFailure,
  mapDeliveryFailure,
} from "../shared/interactive";
import {
  WorkspaceWelcomeWorkflowOperations,
  WorkspaceWelcomeWorkflowOperationsError,
} from "./service";

const operationError = (operation: string, cause: unknown) =>
  new WorkspaceWelcomeWorkflowOperationsError({ operation, cause });

const selectOperation = "workspaces.deliverWelcome.select-welcome-conversation";
const deliverOperation = "workspaces.deliverWelcome.deliver-workspace-welcome";
const maximumDiscordGuildChannelCount = 500;
const maximumDiscordActiveThreadCount = 1_000;
const maximumDiscordWorkspaceConversationCount =
  maximumDiscordGuildChannelCount + maximumDiscordActiveThreadCount;
const maximumConversationPageCount = Math.ceil(
  maximumDiscordWorkspaceConversationCount / maximumBotCollectionPageSize,
);
const discordGuildTextConversationType = 0;
const discordGuildAnnouncementConversationType = 5;

const isSendableConversation = ({ type }: BotConversation): boolean =>
  type === discordGuildTextConversationType || type === discordGuildAnnouncementConversationType;

const conversationPosition = ({ position }: BotConversation): number =>
  Predicate.isNumber(position) ? position : Number.MAX_SAFE_INTEGER;

const byPositionThenId = (left: BotConversation, right: BotConversation): number => {
  const positionDifference = conversationPosition(left) - conversationPosition(right);
  if (positionDifference !== 0) return positionDifference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

export const selectWorkspaceWelcomeConversation = (
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

const sameConversationReference = (left: ConversationRef, right: ConversationRef): boolean =>
  left.workspace.client.platform === right.workspace.client.platform &&
  left.workspace.client.clientId === right.workspace.client.clientId &&
  left.workspace.workspaceId === right.workspace.workspaceId &&
  left.conversationId === right.conversationId;

type DiscordClient = { readonly platform: "discord"; readonly clientId: string };

const readConversationPage = (
  cache: SheetBotHttpClient["cache"],
  client: DiscordClient,
  workspaceId: string,
  cursor: BotCollectionCursor | undefined,
  policy: string,
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
        mapBotCacheFailure(policy, "workspace conversations", selectOperation, operationError),
      ),
    );

const appendConversation = (
  conversations: Array<BotConversation>,
  seenConversationIds: Set<string>,
  workspaceId: string,
  conversation: BotConversation,
) => {
  const inconsistent =
    (Predicate.isNotUndefined(conversation.workspaceId) &&
      conversation.workspaceId !== workspaceId) ||
    seenConversationIds.has(conversation.id);
  if (inconsistent) {
    return Effect.fail(
      operationError(selectOperation, "The bot cache returned an inconsistent conversation page"),
    );
  }
  seenConversationIds.add(conversation.id);
  conversations.push(conversation);
  return Effect.void;
};

const appendConversationPage = (
  conversations: Array<BotConversation>,
  seenConversationIds: Set<string>,
  workspaceId: string,
  page: BotConversationPage,
) =>
  page.items.length > maximumBotCollectionPageSize
    ? Effect.fail(
        operationError(selectOperation, "The bot cache returned an oversized conversation page"),
      )
    : Effect.forEach(
        page.items,
        (conversation) =>
          appendConversation(conversations, seenConversationIds, workspaceId, conversation),
        { concurrency: 1, discard: true },
      );

const loadWorkspaceConversations = (
  cache: SheetBotHttpClient["cache"],
  client: DiscordClient,
  workspaceId: string,
  policy: string,
) =>
  Effect.gen(function* () {
    const conversations: Array<BotConversation> = [];
    const seenConversationIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: BotCollectionCursor | undefined;
    while (true) {
      if (seenCursors.size >= maximumConversationPageCount) {
        return yield* Effect.fail(
          operationError(selectOperation, "The bot cache returned too many conversation pages"),
        );
      }
      const page = yield* readConversationPage(cache, client, workspaceId, cursor, policy);
      yield* appendConversationPage(conversations, seenConversationIds, workspaceId, page);
      if (Predicate.isUndefined(page.nextCursor)) return conversations;
      if (seenCursors.has(page.nextCursor)) {
        return yield* Effect.fail(
          operationError(selectOperation, "The bot cache returned a repeated conversation cursor"),
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  });

export const workspaceWelcomeWorkflowOperationsLayer = Layer.effect(
  WorkspaceWelcomeWorkflowOperations,
  Effect.gen(function* () {
    const cache = yield* SheetBotCacheClient;
    const delivery = yield* SheetBotDeliveryClient;
    const clientId = yield* config.sheetBotClientId;
    const client = { platform: "discord", clientId } as const;

    const selectConversation: WorkspaceWelcomeWorkflowOperations["Service"]["selectConversation"] =
      (input, policy) =>
        Effect.gen(function* () {
          const conversations = yield* loadWorkspaceConversations(
            cache.get().cache,
            client,
            input.workspaceId,
            policy,
          );
          const selected = selectWorkspaceWelcomeConversation(
            conversations,
            input.systemConversationId,
          );
          return Predicate.isUndefined(selected)
            ? yield* Effect.fail(interactiveResourceNotFound("sendable workspace conversation"))
            : conversationRefFrom(client, input.workspaceId, selected.id);
        });

    const deliverWelcome: WorkspaceWelcomeWorkflowOperations["Service"]["deliverWelcome"] = (
      input,
      conversation,
      message,
      deliveryKey,
      policy,
    ) => {
      const expected = conversationRefFrom(client, input.workspaceId, conversation.conversationId);
      if (!sameConversationReference(conversation, expected)) {
        return Effect.fail(
          interactiveInvalidRequest(
            "ConversationWorkspaceMismatch",
            "The selected conversation must belong to the configured client and workspace",
          ),
        );
      }
      const rejected = () =>
        interactiveDeliveryRejected(
          deliverOperation,
          "The workspace welcome message was rejected",
          false,
        );
      return delivery
        .get()
        .delivery.sendMessage({ payload: { conversation, deliveryKey, message } })
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((error) => {
            const mapped = mapDeliveryFailure(
              policy,
              deliverOperation,
              "conversation",
              false,
              "The workspace welcome message was rejected",
              operationError,
            )(error);
            return Predicate.isTagged("ResourceNotFound")(mapped) ? rejected() : mapped;
          }),
          Effect.filterOrFail(
            (receipt) =>
              receipt.deliveryKey === deliveryKey &&
              sameConversationReference(receipt.target.message.conversation, conversation),
            () =>
              operationError(
                deliverOperation,
                "The bot returned a delivery receipt for a different welcome target",
              ),
          ),
        );
    };

    return { selectConversation, deliverWelcome };
  }),
);
