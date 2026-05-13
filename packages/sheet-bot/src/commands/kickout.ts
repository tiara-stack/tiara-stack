import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, pipe } from "effect";
import { discordGatewayLayer } from "../discord/gateway";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import { InteractionToken } from "dfx-discord-utils/utils";
import { SheetClusterClient, SheetClusterRequestContext } from "../services";
import { discordApplicationLayer } from "../discord/application";
import { interactionDeadlineEpochMs } from "../utils/interactionDeadline";

const getInteractionGuildId = Effect.gen(function* () {
  const interactionGuild = yield* Interaction.guild();
  return pipe(
    interactionGuild,
    Option.map((guild) => (guild as { id: string }).id),
  );
});

const getInteractionChannelId = Effect.gen(function* () {
  const interactionChannel = yield* Interaction.channel();
  return pipe(
    interactionChannel,
    Option.map((channel) => (channel as { id: string }).id),
  );
});

const makeManualSubCommand = Effect.gen(function* () {
  const sheetClusterClient = yield* SheetClusterClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("manual")
        .setDescription("Manually kick out users")
        .addNumberOption((builder) =>
          builder.setName("hour").setDescription("The hour to kick out users for"),
        )
        .addStringOption((builder) =>
          builder.setName("channel_name").setDescription("The name of the running channel"),
        )
        .addStringOption((builder) =>
          builder.setName("server_id").setDescription("The server to kick out users for"),
        ),
    Effect.fn("kickout.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const serverId = command.optionValueOptional("server_id");
      const interactionGuildId = yield* getInteractionGuildId;
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrow,
      );

      const channelNameOption = command.optionValueOptional("channel_name");
      const interactionToken = yield* InteractionToken;
      const interaction = yield* Ix.Interaction;
      yield* sheetClusterClient.get().dispatch.kickout({
        payload: {
          dispatchRequestId: `discord-interaction:${interaction.id}`,
          guildId,
          interactionToken: interactionToken.token,
          interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
          ...(Option.isSome(channelNameOption)
            ? { channelName: channelNameOption.value }
            : { channelId: Option.getOrThrow(yield* getInteractionChannelId) }),
          ...pipe(
            command.optionValueOptional("hour"),
            Option.match({
              onSome: (hour) => ({ hour }),
              onNone: () => ({}),
            }),
          ),
        },
      });
    }),
  );
});

const makeKickoutCommand = Effect.gen(function* () {
  const manualSubCommand = yield* makeManualSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("kickout")
        .setDescription("Kick out commands")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => manualSubCommand.data),
    SheetClusterRequestContext.asInteractionUser((command) =>
      command.subCommands({
        manual: manualSubCommand.handler,
      }),
    ),
  );
});

const makeGlobalKickoutCommand = Effect.gen(function* () {
  const kickoutCommand = yield* makeKickoutCommand;

  return CommandHelper.makeGlobalCommand(kickoutCommand.data, kickoutCommand.handler as never);
});

export const kickoutCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalKickoutCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetClusterClient.layer),
  ),
);
