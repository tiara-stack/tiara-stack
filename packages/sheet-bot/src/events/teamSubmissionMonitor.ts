import { DiscordGateway } from "dfx/gateway";
import { Cache, Duration, Effect, Exit, Layer, Predicate, Schema } from "effect";
import type { TeamSubmissionDispatchPayload } from "sheet-ingress-api/sheet-apis-rpc";
import { config } from "../config";
import { discordGatewayLayer } from "../discord/gateway";
import { SheetApisClient, SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";

const DiscordMessageAuthor = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  global_name: Schema.optional(Schema.NullOr(Schema.String)),
  bot: Schema.optional(Schema.Boolean),
});

const DiscordMessageMember = Schema.Struct({
  nick: Schema.optional(Schema.NullOr(Schema.String)),
});

const DiscordMessageEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.optional(Schema.Number),
  channel_id: Schema.String,
  guild_id: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.String),
  author: DiscordMessageAuthor,
  member: Schema.optional(DiscordMessageMember),
  edited_timestamp: Schema.optional(Schema.NullOr(Schema.String)),
});

type DiscordMessageEvent = typeof DiscordMessageEvent.Type;

const authorDisplayName = (message: DiscordMessageEvent) =>
  message.member?.nick ?? message.author.global_name ?? message.author.username;

const messageGuildId = (message: DiscordMessageEvent) =>
  Predicate.isString(message.guild_id) ? message.guild_id : null;

const messageContent = (message: DiscordMessageEvent) => {
  const content = message.content?.trim() ?? "";
  return content.length === 0 ? null : content;
};

const isStandardSubmissionMessageType = (message: DiscordMessageEvent) =>
  message.type === undefined || message.type === 0 || message.type === 19;

const hasDispatchableEnvelope = (message: DiscordMessageEvent) =>
  message.author.bot !== true && isStandardSubmissionMessageType(message);

const dispatchableGuildContent = (guildId: string | null, content: string | null) =>
  guildId === null || content === null ? null : { guildId, content };

const dispatchableMessageParts = (message: DiscordMessageEvent) => {
  if (!hasDispatchableEnvelope(message)) {
    return null;
  }

  return dispatchableGuildContent(messageGuildId(message), messageContent(message));
};

const makeTeamSubmissionDispatchPayload = (
  message: DiscordMessageEvent,
  clientId = "discord-main",
): TeamSubmissionDispatchPayload | null => {
  const parts = dispatchableMessageParts(message);
  if (parts === null) {
    return null;
  }

  return {
    client: { platform: "discord", clientId },
    dispatchRequestId: `discord-team-submission:${parts.guildId}:${message.channel_id}:${message.id}:${message.edited_timestamp ?? "create"}`,
    workspaceId: parts.guildId,
    conversationId: message.channel_id,
    messageId: message.id,
    authorId: message.author.id,
    authorDisplayName: authorDisplayName(message),
    content: parts.content,
    editedAt: message.edited_timestamp,
  };
};

export const teamSubmissionMonitorEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const sheetApisClient = yield* SheetApisClient;
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;
    const clientId = yield* config.sheetBotClientId;
    const configuredChannelCache = yield* Cache.makeWith<string, boolean, unknown>(
      Effect.fn("TeamSubmissionMonitor.configuredChannelLookup")(function* (key) {
        const [workspaceId, conversationId] = key.split(":");
        if (!workspaceId || !conversationId) {
          return false;
        }

        return yield* sheetApisClient.isTeamSubmissionChannelConfigured(
          workspaceId,
          conversationId,
        );
      }),
      {
        capacity: 10_000,
        timeToLive: Exit.match({
          onFailure: () => Duration.seconds(15),
          onSuccess: () => Duration.minutes(1),
        }),
      },
    );

    const handleMessage = (event: unknown) =>
      Effect.gen(function* () {
        const message = yield* Schema.decodeUnknownEffect(DiscordMessageEvent)(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Skipping invalid team submission message payload").pipe(
              Effect.andThen(Effect.logDebug(cause)),
              Effect.as(null),
            ),
          ),
        );
        if (message === null) {
          return;
        }
        const payload = makeTeamSubmissionDispatchPayload(message, clientId);
        if (payload === null) {
          return;
        }
        const channelConfigured = yield* Cache.get(
          configuredChannelCache,
          `${payload.workspaceId}:${payload.conversationId}`,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to look up team submission channel configuration").pipe(
              Effect.annotateLogs({
                workspaceId: payload.workspaceId,
                conversationId: payload.conversationId,
                messageId: payload.messageId,
              }),
              Effect.andThen(Effect.logDebug(cause)),
              Effect.as(false),
            ),
          ),
        );
        if (!channelConfigured) {
          return;
        }

        yield* SheetWorkflowsRequestContext.asService(() =>
          sheetWorkflowsClient.get().dispatch.teamSubmission({ payload }),
        )().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to dispatch team submission monitor event").pipe(
              Effect.annotateLogs({
                workspaceId: payload.workspaceId,
                conversationId: payload.conversationId,
                messageId: payload.messageId,
              }),
              Effect.andThen(Effect.logDebug(cause)),
            ),
          ),
        );
      });

    yield* gateway.handleDispatch("MESSAGE_CREATE", handleMessage).pipe(Effect.forkScoped);
    yield* gateway.handleDispatch("MESSAGE_UPDATE", handleMessage).pipe(Effect.forkScoped);
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, SheetApisClient.layer, SheetWorkflowsClient.layer),
  ),
);
