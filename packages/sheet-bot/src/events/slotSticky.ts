import { DiscordGateway } from "dfx/gateway";
import { Duration, Effect, Layer, Option, Predicate, Schedule, Schema } from "effect";
import { config } from "../config";
import { discordGatewayLayer } from "../discord/gateway";
import {
  enqueueSlotsRefreshButtonWorkflow,
  SheetWorkflowHttpClient,
  SheetZeroClient,
  type SlotsRefreshButtonInput,
  type SlotsRefreshButtonReference,
} from "../services";
import { decodeWorkflowWorkspaceId } from "../utils/commandHelpers";
import { makeDeterministicWorkflowInvocationId } from "../utils/workflowInvocationId";

const DiscordSlotMessageEvent = Schema.Struct({
  id: Schema.String,
  type: Schema.optional(Schema.Number),
  channel_id: Schema.String,
  guild_id: Schema.optional(Schema.NullOr(Schema.String)),
  author: Schema.Struct({
    bot: Schema.optional(Schema.Boolean),
  }),
});

type DiscordSlotMessageEvent = typeof DiscordSlotMessageEvent.Type;

const retryPolicy = {
  schedule: Schedule.exponential(Duration.millis(100)),
  times: 2,
} as const;

const messageGuildId = (message: DiscordSlotMessageEvent) =>
  Predicate.isString(message.guild_id) && message.guild_id.length > 0 ? message.guild_id : null;

const humanMessageTypes = new Set([0, 19]);

const isHumanMessage = (message: DiscordSlotMessageEvent) =>
  message.author.bot !== true &&
  (message.type === undefined || humanMessageTypes.has(message.type)) &&
  messageGuildId(message) !== null;

export const makeSlotsRefreshButtonWorkflowRequest = (
  message: DiscordSlotMessageEvent,
  clientId = "discord-main",
) => {
  const guildId = messageGuildId(message);
  if (!isHumanMessage(message) || guildId === null) {
    return null;
  }

  return {
    input: {
      workspaceId: guildId,
      conversationId: message.channel_id,
      triggerMessageId: message.id,
    },
    invocationId: makeDeterministicWorkflowInvocationId([
      "discord-slot-refresh",
      clientId,
      guildId,
      message.channel_id,
      message.id,
    ]),
  };
};

export const makeSlotsRefreshButtonMessageHandler = ({
  clientId,
  hasSlotButton,
  enqueue,
}: {
  readonly clientId: string;
  readonly hasSlotButton: (
    workspaceId: string,
    conversationId: string,
  ) => Effect.Effect<boolean, unknown>;
  readonly enqueue: (
    input: SlotsRefreshButtonInput,
    invocationId: SlotsRefreshButtonReference["invocationId"],
  ) => Effect.Effect<unknown, unknown>;
}) =>
  Effect.fn("SlotsRefreshButton.handleMessage")(function* (event: unknown) {
    const message = yield* Schema.decodeUnknownEffect(DiscordSlotMessageEvent)(event).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Skipping invalid slot sticky message payload").pipe(
          Effect.andThen(Effect.logDebug(cause)),
          Effect.as(null),
        ),
      ),
    );
    if (message === null) {
      return;
    }

    const request = makeSlotsRefreshButtonWorkflowRequest(message, clientId);
    if (request === null) {
      return;
    }

    const workspaceId = yield* decodeWorkflowWorkspaceId(request.input.workspaceId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Skipping slot sticky event with an invalid workspace ID").pipe(
          Effect.annotateLogs({ workspaceId: request.input.workspaceId, messageId: message.id }),
          Effect.andThen(Effect.logDebug(cause)),
          Effect.as(null),
        ),
      ),
    );
    if (workspaceId === null) {
      return;
    }
    const input = {
      ...request.input,
      workspaceId,
    } satisfies SlotsRefreshButtonInput;
    const hasButton = yield* hasSlotButton(workspaceId, message.channel_id).pipe(
      Effect.retry(retryPolicy),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to look up slot sticky state").pipe(
          Effect.annotateLogs({
            workspaceId,
            conversationId: message.channel_id,
            messageId: message.id,
          }),
          Effect.andThen(Effect.logDebug(cause)),
          Effect.as(false),
        ),
      ),
    );
    if (!hasButton) {
      return;
    }

    yield* enqueue(input, request.invocationId).pipe(
      Effect.retry(retryPolicy),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to dispatch slot sticky refresh").pipe(
          Effect.annotateLogs({
            workspaceId,
            conversationId: message.channel_id,
            messageId: message.id,
            invocationId: request.invocationId,
          }),
          Effect.andThen(Effect.logDebug(cause)),
        ),
      ),
    );
  });

export const slotStickyEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const sheetZeroClient = yield* SheetZeroClient;
    const workflowClient = yield* SheetWorkflowHttpClient;
    const clientId = yield* config.sheetBotClientId;

    const handleMessage = makeSlotsRefreshButtonMessageHandler({
      clientId,
      hasSlotButton: (workspaceId, conversationId) =>
        sheetZeroClient
          .getSlotButtonByConversation(workspaceId, conversationId)
          .pipe(Effect.map(Option.isSome)),
      enqueue: (input, invocationId) =>
        enqueueSlotsRefreshButtonWorkflow(workflowClient, input, { invocationId }),
    });

    yield* gateway.handleDispatch("MESSAGE_CREATE", handleMessage).pipe(Effect.forkScoped);
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, SheetZeroClient.layer, SheetWorkflowHttpClient.layer),
  ),
);
