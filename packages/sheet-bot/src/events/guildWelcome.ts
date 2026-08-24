import { DiscordGateway } from "dfx/gateway";
import { Effect, Layer, Predicate } from "effect";
import { workflowWorkspaceIdFromString } from "sheet-workflow-http-client";
import { config } from "../config";
import { discordGatewayLayer } from "../discord/gateway";
import {
  enqueueWorkspacesDeliverWelcomeWorkflow,
  SheetWorkflowHttpClient,
  type WorkspacesDeliverWelcomeInput,
} from "../services";
import { makeDeterministicWorkflowInvocationId } from "../utils/workflowInvocationId";

const guildJoinReplayWindowMs = 10 * 60 * 1000;

type GuildCreateEvent = {
  readonly id: string;
  readonly name: string;
  readonly joined_at: string;
  readonly unavailable?: boolean;
  readonly system_channel_id?: string | null;
};

export const makeGuildWelcomeWorkflowRequest = (
  guild: GuildCreateEvent,
  startupEpochMs: number,
  clientId = "discord-main",
) => {
  if (guild.unavailable === true) {
    return null;
  }

  const joinedAtEpochMs = Date.parse(guild.joined_at);
  if (Number.isNaN(joinedAtEpochMs)) {
    return null;
  }

  if (joinedAtEpochMs < startupEpochMs - guildJoinReplayWindowMs) {
    return null;
  }

  const joinedAt = new Date(joinedAtEpochMs);
  return {
    input: {
      workspaceId: workflowWorkspaceIdFromString(guild.id),
      workspaceName: guild.name,
      joinedAt,
      ...(Predicate.isString(guild.system_channel_id)
        ? { systemConversationId: guild.system_channel_id }
        : {}),
    } satisfies WorkspacesDeliverWelcomeInput,
    invocationId: makeDeterministicWorkflowInvocationId([
      "discord-guild-create",
      clientId,
      guild.id,
      joinedAt.toISOString(),
    ]),
  };
};

const logGuildWelcomeFailure = (
  cause: unknown,
  annotations: {
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly invocationId?: string;
  },
) =>
  Effect.logWarning("Failed to enqueue guild welcome workflow").pipe(
    Effect.annotateLogs(annotations),
    Effect.andThen(Effect.logDebug(cause)),
  );

export const guildWelcomeEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const workflowClient = yield* SheetWorkflowHttpClient;
    const clientId = yield* config.sheetBotClientId;
    const startupEpochMs = Date.now();

    yield* gateway
      .handleDispatch("GUILD_CREATE", (guild) =>
        Effect.sync(() => makeGuildWelcomeWorkflowRequest(guild, startupEpochMs, clientId)).pipe(
          Effect.flatMap((request) =>
            request === null
              ? Effect.void
              : enqueueWorkspacesDeliverWelcomeWorkflow(workflowClient, request.input, {
                  invocationId: request.invocationId,
                }).pipe(
                  Effect.catchCause((cause) =>
                    logGuildWelcomeFailure(cause, {
                      workspaceId: request.input.workspaceId,
                      workspaceName: request.input.workspaceName,
                      invocationId: request.invocationId,
                    }),
                  ),
                ),
          ),
          Effect.catchCause((cause) =>
            logGuildWelcomeFailure(cause, {
              workspaceId: guild.id,
              workspaceName: guild.name,
            }),
          ),
        ),
      )
      .pipe(Effect.forkScoped);
  }),
).pipe(Layer.provide(Layer.mergeAll(discordGatewayLayer, SheetWorkflowHttpClient.layer)));
