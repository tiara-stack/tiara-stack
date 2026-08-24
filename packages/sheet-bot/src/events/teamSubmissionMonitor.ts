import { DiscordGateway } from "dfx/gateway";
import { Cache, Duration, Effect, Exit, Layer, Predicate, Schedule, Schema } from "effect";
import { config } from "../config";
import { discordGatewayLayer } from "../discord/gateway";
import {
  enqueueTeamSubmissionsProcessWorkflow,
  SheetWorkflowHttpClient,
  SheetZeroClient,
  type TeamSubmissionsProcessInput,
  type TeamSubmissionsProcessReference,
} from "../services";
import { makeDeterministicWorkflowInvocationId } from "../utils/workflowInvocationId";

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
  pinned: Schema.optional(Schema.Boolean),
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
  message.author.bot !== true &&
  message.pinned !== true &&
  isStandardSubmissionMessageType(message);

const teamShapePattern = /\b\d{2,3}\s*\/\s*\d{3}\b/;
const explicitTeamLabelPattern =
  /^(?:alt\s*\/\s*enc|enc\s*\/\s*alt|4(?:\*|☆|-star)\s+heal|birthday\s+heal|bday\s+heal|bd\s+heal|full\s+fill|fullfill|alternative|healer|encore|alts|main|fill|heal|ff|enc|alt|h)\s*:\s*\S/i;

export const looksLikeTeamSubmissionContent = (content: string) => {
  let inCodeFence = false;
  for (const sourceLine of content.split(/\r?\n/)) {
    const trimmedSourceLine = sourceLine.trim();
    if (trimmedSourceLine.startsWith("```")) {
      if (!(trimmedSourceLine.length > 3 && trimmedSourceLine.endsWith("```"))) {
        inCodeFence = !inCodeFence;
      }
      continue;
    }
    const line = sourceLine
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
      .replace(/^(?:\*\*|__)(.*?)(?:\*\*|__)/, "$1");
    if (
      !inCodeFence &&
      !line.startsWith(">") &&
      (teamShapePattern.test(line) || explicitTeamLabelPattern.test(line))
    ) {
      return true;
    }
  }
  return false;
};

const dispatchableGuildContent = (guildId: string | null, content: string | null) =>
  guildId === null || content === null ? null : { guildId, content };

const retryPolicy = {
  schedule: Schedule.exponential(Duration.millis(100)),
  times: 2,
} as const;

const dispatchableMessageParts = (message: DiscordMessageEvent) => {
  if (!hasDispatchableEnvelope(message)) {
    return null;
  }

  const content = messageContent(message);
  return content === null || !looksLikeTeamSubmissionContent(content)
    ? null
    : dispatchableGuildContent(messageGuildId(message), content);
};

export const makeTeamSubmissionWorkflowRequest = (
  message: DiscordMessageEvent,
  clientId = "discord-main",
) => {
  const parts = dispatchableMessageParts(message);
  if (parts === null) {
    return null;
  }

  const editedAt = Predicate.isString(message.edited_timestamp)
    ? new Date(message.edited_timestamp)
    : null;
  if (Predicate.isDate(editedAt) && !Number.isFinite(editedAt.getTime())) {
    return null;
  }
  const eventIdentity = Predicate.isDate(editedAt) ? editedAt.toISOString() : "create";
  return {
    input: {
      sourceMessage: {
        conversation: {
          workspace: {
            client: { platform: "discord", clientId },
            workspaceId: parts.guildId,
          },
          conversationId: message.channel_id,
        },
        messageId: message.id,
      },
      authorId: message.author.id,
      authorDisplayName: authorDisplayName(message),
      content: parts.content,
      editedAt,
    } satisfies TeamSubmissionsProcessInput,
    invocationId: makeDeterministicWorkflowInvocationId([
      "discord-team-submission",
      clientId,
      parts.guildId,
      message.channel_id,
      message.id,
      eventIdentity,
    ]),
  };
};

export const makeTeamSubmissionMessageHandler = ({
  clientId,
  isTeamSubmissionEnabled,
  enqueue,
}: {
  readonly clientId: string;
  readonly isTeamSubmissionEnabled: (
    workspaceId: string,
    conversationId: string,
  ) => Effect.Effect<boolean, unknown>;
  readonly enqueue: (
    input: TeamSubmissionsProcessInput,
    invocationId: TeamSubmissionsProcessReference["invocationId"],
  ) => Effect.Effect<unknown, unknown>;
}) =>
  Effect.fn("TeamSubmissionMonitor.handleMessage")(function* (event: unknown) {
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
    const request = makeTeamSubmissionWorkflowRequest(message, clientId);
    if (request === null) {
      const guildId = messageGuildId(message);
      const content = messageContent(message);
      if (
        guildId !== null &&
        content !== null &&
        hasDispatchableEnvelope(message) &&
        !looksLikeTeamSubmissionContent(content)
      ) {
        yield* Effect.logDebug("Ignored message without team submission shape").pipe(
          Effect.annotateLogs({
            workspaceId: guildId,
            conversationId: message.channel_id,
            disposition: "noShape",
          }),
        );
      }
      return;
    }
    const sourceMessage = request.input.sourceMessage;
    const workspaceId = sourceMessage.conversation.workspace.workspaceId;
    const conversationId = sourceMessage.conversation.conversationId;
    const featureEnabled = yield* isTeamSubmissionEnabled(workspaceId, conversationId).pipe(
      Effect.retry(retryPolicy),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to look up team submission availability").pipe(
          Effect.annotateLogs({
            workspaceId,
            conversationId,
            messageId: sourceMessage.messageId,
          }),
          Effect.andThen(Effect.logDebug(cause)),
          Effect.as(false),
        ),
      ),
    );
    if (!featureEnabled) {
      yield* Effect.logDebug("Ignored disabled team submission monitor event").pipe(
        Effect.annotateLogs({
          workspaceId,
          conversationId,
          disposition: "disabled",
        }),
      );
      return;
    }

    yield* enqueue(request.input, request.invocationId).pipe(
      Effect.retry(retryPolicy),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to dispatch team submission monitor event").pipe(
          Effect.annotateLogs({
            workspaceId,
            conversationId,
            messageId: sourceMessage.messageId,
            invocationId: request.invocationId,
          }),
          Effect.andThen(Effect.logDebug(cause)),
        ),
      ),
    );
  });

export const teamSubmissionMonitorEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const sheetZeroClient = yield* SheetZeroClient;
    const workflowClient = yield* SheetWorkflowHttpClient;
    const clientId = yield* config.sheetBotClientId;
    const availabilityCache = yield* Cache.makeWith<string, boolean, unknown>(
      Effect.fn("TeamSubmissionMonitor.availabilityLookup")(function* (key) {
        const [workspaceId, conversationId] = key.split(":");
        if (!workspaceId || !conversationId) {
          return false;
        }

        return yield* sheetZeroClient.isTeamSubmissionEnabled(workspaceId, conversationId);
      }),
      {
        capacity: 10_000,
        timeToLive: Exit.match({
          onFailure: () => Duration.zero,
          onSuccess: () => Duration.minutes(1),
        }),
      },
    );

    const handleMessage = makeTeamSubmissionMessageHandler({
      clientId,
      isTeamSubmissionEnabled: (workspaceId, conversationId) =>
        Cache.get(availabilityCache, `${workspaceId}:${conversationId}`),
      enqueue: (input, invocationId) =>
        enqueueTeamSubmissionsProcessWorkflow(workflowClient, input, { invocationId }),
    });

    yield* gateway.handleDispatch("MESSAGE_CREATE", handleMessage).pipe(Effect.forkScoped);
    yield* gateway.handleDispatch("MESSAGE_UPDATE", handleMessage).pipe(Effect.forkScoped);
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, SheetZeroClient.layer, SheetWorkflowHttpClient.layer),
  ),
);
