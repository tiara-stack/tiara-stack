import { DiscordGateway } from "dfx/gateway";
import { Effect, Layer } from "effect";
import type { GuildWelcomeDispatchPayload } from "sheet-ingress-api/sheet-apis-rpc";
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
): GuildWelcomeDispatchPayload | null => {
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
    dispatchRequestId: `discord-guild-create:${guild.id}:${guild.joined_at}`,
    guildId: guild.id,
    guildName: guild.name,
    joinedAt: guild.joined_at,
    ...(typeof guild.system_channel_id === "string"
      ? { systemChannelId: guild.system_channel_id }
      : {}),
  };
};

export const guildWelcomeEventLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const sheetWorkflowsClient = yield* SheetWorkflowsClient;
    const startupEpochMs = Date.now();

    yield* gateway
      .handleDispatch("GUILD_CREATE", (guild) => {
        const payload = makeGuildWelcomeDispatchPayload(guild, startupEpochMs);
        if (payload === null) {
          return Effect.void;
        }

        return SheetWorkflowsRequestContext.asService(() =>
          sheetWorkflowsClient.get().dispatch.guildWelcome({ payload }),
        )().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to dispatch guild welcome message").pipe(
              Effect.annotateLogs({
                guildId: payload.guildId,
                guildName: payload.guildName,
              }),
              Effect.andThen(Effect.logDebug(cause)),
            ),
          ),
        );
      })
      .pipe(Effect.forkScoped);
  }),
).pipe(Layer.provide(Layer.mergeAll(discordGatewayLayer, SheetWorkflowsClient.layer)));
