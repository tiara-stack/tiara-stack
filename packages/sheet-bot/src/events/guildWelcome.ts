import { DiscordGateway } from "dfx/gateway";
import { Effect, Layer, Predicate } from "effect";
import type { WorkspaceWelcomeDispatchPayload } from "sheet-ingress-api/sheet-apis-rpc";
import { config } from "../config";
import { discordGatewayLayer } from "../discord/gateway";
import { SheetWorkflowsClient, SheetWorkflowsRequestContext } from "../services";

const guildJoinReplayWindowMs = 10 * 60 * 1000;

type GuildCreateEvent = {
  readonly id: string;
  readonly name: string;
  readonly joined_at: string;
  readonly unavailable?: boolean;
  readonly system_channel_id?: string | null;
};

export const makeGuildWelcomeDispatchPayload = (
  guild: GuildCreateEvent,
  startupEpochMs: number,
  clientId = "discord-main",
): WorkspaceWelcomeDispatchPayload | null => {
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

  return {
    client: { platform: "discord", clientId },
    dispatchRequestId: `discord-guild-create:${guild.id}:${guild.joined_at}`,
    workspaceId: guild.id,
    workspaceName: guild.name,
    joinedAt: guild.joined_at,
    ...(Predicate.isString(guild.system_channel_id)
      ? { systemConversationId: guild.system_channel_id }
      : {}),
  };
};

export const guildWelcomeEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;
    const clientId = yield* config.sheetBotClientId;
    const startupEpochMs = Date.now();

    yield* gateway
      .handleDispatch("GUILD_CREATE", (guild) => {
        const payload = makeGuildWelcomeDispatchPayload(guild, startupEpochMs, clientId);
        if (payload === null) {
          return Effect.void;
        }

        return SheetWorkflowsRequestContext.asService(() =>
          sheetWorkflowsClient.get().dispatch.workspaceWelcome({ payload }),
        )().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to dispatch guild welcome message").pipe(
              Effect.annotateLogs({
                workspaceId: payload.workspaceId,
                workspaceName: payload.workspaceName,
              }),
              Effect.andThen(Effect.logDebug(cause)),
            ),
          ),
        );
      })
      .pipe(Effect.forkScoped);
  }),
).pipe(Layer.provide(Layer.mergeAll(discordGatewayLayer, SheetWorkflowsClient.layer)));
