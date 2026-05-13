import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Effect, Layer, Option, Schema, pipe } from "effect";
import { CommandHelper, Interaction, InteractionResponse } from "dfx-discord-utils/utils";
import { InteractionToken } from "dfx-discord-utils/utils";
import { discordGatewayLayer } from "../discord/gateway";
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

const makeListSubCommand = Effect.gen(function* () {
  const sheetClusterClient = yield* SheetClusterClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("Get the open slots for the day")
        .addNumberOption((option) =>
          option.setName("day").setDescription("The day to get the slots for").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to get the teams for"),
        )
        .addStringOption((option) =>
          option
            .setName("message_type")
            .setDescription("The type of message to send")
            .addChoices(
              { name: "persistent", value: "persistent" },
              { name: "ephemeral", value: "ephemeral" },
            ),
        ),
    Effect.fn("slot.list")(function* (command) {
      const response = yield* InteractionResponse;
      const interactionGuildId = yield* getInteractionGuildId;
      const guildId = pipe(
        command.optionValueOptional("server_id"),
        Option.orElse(() => interactionGuildId),
        Option.getOrThrowWith(() => new Error("Guild not found in interaction or command options")),
      );

      const messageType = yield* Schema.decodeUnknownEffect(
        Schema.Literals(["persistent", "ephemeral"]),
      )(Option.getOrElse(command.optionValueOptional("message_type"), () => "ephemeral"));

      const isEphemeral = messageType === "ephemeral";
      const day = command.optionValue("day");

      yield* response.deferReply({ flags: isEphemeral ? MessageFlags.Ephemeral : undefined });

      const interactionToken = yield* InteractionToken;
      const interaction = yield* Ix.Interaction;
      yield* sheetClusterClient.get().dispatch.slotList({
        payload: {
          dispatchRequestId: `discord-interaction:${interaction.id}`,
          guildId,
          day,
          messageType,
          interactionToken: interactionToken.token,
          interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
        },
      });
    }),
  );
});

const makeButtonSubCommand = Effect.gen(function* () {
  const sheetClusterClient = yield* SheetClusterClient;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("button")
        .setDescription("Show the button to get the open slots")
        .addNumberOption((option) =>
          option.setName("day").setDescription("The day to get the slots for").setRequired(true),
        )
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to get the teams for"),
        ),
    Effect.fn("slot.button")(function* (command) {
      const response = yield* InteractionResponse;
      const interactionGuildId = yield* getInteractionGuildId;
      const guildId = pipe(
        command.optionValueOptional("server_id"),
        Option.orElse(() => interactionGuildId),
        Option.getOrThrowWith(() => new Error("Guild not found in interaction or command options")),
      );

      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const day = command.optionValue("day");
      const channelId = Option.getOrThrowWith(
        yield* getInteractionChannelId,
        () => new Error("Channel not found in interaction"),
      );
      const interactionToken = yield* InteractionToken;
      const interaction = yield* Ix.Interaction;
      yield* sheetClusterClient.get().dispatch.slotButton({
        payload: {
          dispatchRequestId: `discord-interaction:${interaction.id}`,
          guildId,
          channelId,
          day,
          interactionToken: interactionToken.token,
          interactionDeadlineEpochMs: interactionDeadlineEpochMs(interaction.id),
        },
      });
    }),
  );
});

const makeSlotCommand = Effect.gen(function* () {
  const listSubCommand = yield* makeListSubCommand;
  const buttonSubCommand = yield* makeButtonSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("slot")
        .setDescription("Day slots commands")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => listSubCommand.data)
        .addSubcommand(() => buttonSubCommand.data),
    SheetClusterRequestContext.asInteractionUser((command) =>
      command.subCommands({
        list: listSubCommand.handler,
        button: buttonSubCommand.handler,
      }),
    ),
  );
});

const makeGlobalSlotCommand = Effect.gen(function* () {
  const slotCommand = yield* makeSlotCommand;

  return CommandHelper.makeGlobalCommand(slotCommand.data, slotCommand.handler as never);
});

export const slotCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalSlotCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(discordGatewayLayer, discordApplicationLayer, SheetClusterClient.layer),
  ),
);
