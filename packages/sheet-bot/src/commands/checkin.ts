import { Effect, Layer, Option, pipe } from "effect";
import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Ix } from "dfx/index";
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
        .setDescription("Manually check in users")
        .addStringOption((option) =>
          option.setName("channel_name").setDescription("The name of the running channel"),
        )
        .addNumberOption((option) =>
          option.setName("hour").setDescription("The hour to check in users for"),
        )
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to check in users for"),
        )
        .addStringOption((option) =>
          option
            .setName("template")
            .setDescription("Optional Handlebars template for the check-in message"),
        ),
    Effect.fn("checkin.manual")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const serverId = command.optionValueOptional("server_id");
      const interactionGuildId = yield* getInteractionGuildId;
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrowWith(() => new Error("This command must be run inside a server.")),
      );
      const templateOption = command.optionValueOptional("template");

      const channelNameOption = command.optionValueOptional("channel_name");
      const interactionChannelId = Option.getOrThrow(yield* getInteractionChannelId);
      const interactionToken = yield* InteractionToken;
      const interaction = yield* Ix.Interaction;

      yield* sheetClusterClient.get().dispatch.checkin({
        payload: {
          dispatchRequestId: `discord-interaction:${interaction.id}`,
          guildId,
          interactionToken: interactionToken.token,
          interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
          ...(Option.isSome(channelNameOption)
            ? { channelName: channelNameOption.value }
            : {
                channelId: interactionChannelId,
              }),
          ...pipe(
            command.optionValueOptional("hour"),
            Option.match({
              onSome: (hour) => ({ hour }),
              onNone: () => ({}),
            }),
          ),
          ...pipe(
            templateOption,
            Option.match({
              onSome: (template) => ({ template }),
              onNone: () => ({}),
            }),
          ),
        },
      });
    }),
  );
});

const makeCheckinCommand = Effect.gen(function* () {
  const manualSubCommand = yield* makeManualSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("checkin")
        .setDescription("Checkin commands")
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

const makeGlobalCheckinCommand = Effect.gen(function* () {
  const checkinCommand = yield* makeCheckinCommand;

  return CommandHelper.makeGlobalCommand(checkinCommand.data, checkinCommand.handler as never);
});

export const checkinCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalCheckinCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetClusterClient.layer),
  ),
);
