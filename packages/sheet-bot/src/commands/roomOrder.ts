import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
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
        .setDescription("Manual room order commands")
        .addStringOption((option) =>
          option.setName("channel_name").setDescription("The name of the running channel"),
        )
        .addNumberOption((option) =>
          option.setName("hour").setDescription("The hour to order rooms for"),
        )
        .addNumberOption((option) => option.setName("heal").setDescription("The healer needed"))
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to order rooms for"),
        ),
    Effect.fn("room_order.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const serverId = command.optionValueOptional("server_id");
      const guildId =
        Option.getOrUndefined(serverId) ?? Option.getOrThrow(yield* getInteractionGuildId);

      const channelNameOption = command.optionValueOptional("channel_name");
      const interactionToken = yield* InteractionToken;
      const interaction = yield* Ix.Interaction;
      yield* sheetClusterClient.get().dispatch.roomOrder({
        payload: {
          dispatchRequestId: `discord-interaction:${interaction.id}`,
          guildId,
          interactionToken: interactionToken.token,
          interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
          ...(Option.isSome(channelNameOption)
            ? { channelName: channelNameOption.value }
            : {
                channelId: Option.getOrThrow(yield* getInteractionChannelId),
              }),
          ...pipe(
            command.optionValueOptional("hour"),
            Option.match({
              onSome: (hour) => ({ hour }),
              onNone: () => ({}),
            }),
          ),
          ...pipe(
            command.optionValueOptional("heal"),
            Option.match({
              onSome: (healNeeded) => ({ healNeeded }),
              onNone: () => ({}),
            }),
          ),
        },
      });
    }),
  );
});

const makeRoomOrderCommand = Effect.gen(function* () {
  const manualSubCommand = yield* makeManualSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("room_order")
        .setDescription("Room order commands")
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

const makeGlobalRoomOrderCommand = Effect.gen(function* () {
  const roomOrderCommand = yield* makeRoomOrderCommand;

  return CommandHelper.makeGlobalCommand(roomOrderCommand.data, roomOrderCommand.handler as never);
});

export const roomOrderCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalRoomOrderCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetClusterClient.layer),
  ),
);
