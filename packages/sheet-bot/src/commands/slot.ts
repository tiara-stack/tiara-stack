import { InteractionsRegistry } from "dfx/gateway";
import { DiscordREST } from "dfx";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Chunk, Effect, Layer, Option, Schema, String, pipe } from "effect";
import {
  CommandHelper,
  Interaction,
  InteractionResponse,
  makeMessageActionRowData,
} from "dfx-discord-utils/utils";
import { discordGatewayLayer } from "../discord/gateway";
import { slotButtonData } from "../messageComponents/buttons/slot";
import {
  EmbedService,
  FormatService,
  MessageSlotService,
  PermissionService,
  ScheduleService,
  SheetApisRequestContext,
} from "../services";
import { discordApplicationLayer } from "../discord/application";

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

const getInteractionUserId = Effect.gen(function* () {
  return ((yield* Interaction.user()) as { id: string }).id;
});

const makeListSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const formatService = yield* FormatService;
  const permissionService = yield* PermissionService;
  const scheduleService = yield* ScheduleService;

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

      if (!isEphemeral) {
        yield* permissionService.checkInteractionUserMonitorGuild(guildId);
      }

      const daySchedule = yield* scheduleService.dayPopulatedFillerSchedules(guildId, day);
      const sortedSchedules: ReadonlyArray<(typeof daySchedule)[number]> = [...daySchedule]
        .filter((schedule) => Option.isSome(schedule.hour))
        .sort(
          (left: (typeof daySchedule)[number], right: (typeof daySchedule)[number]) =>
            Option.getOrThrow(left.hour) - Option.getOrThrow(right.hour),
        );

      const openSlots = yield* pipe(
        sortedSchedules,
        Effect.forEach((schedule) => formatService.formatOpenSlot(guildId, schedule)),
        Effect.map(Chunk.fromIterable),
        Effect.map(Chunk.dedupeAdjacent),
        Effect.map(Chunk.join("\n")),
        Effect.map((description) =>
          String.Equivalence(description, String.empty) ? "All Filled :3" : description,
        ),
      );

      const filledSlots = yield* pipe(
        sortedSchedules,
        Effect.forEach((schedule) => formatService.formatFilledSlot(guildId, schedule)),
        Effect.map(Chunk.fromIterable),
        Effect.map(Chunk.dedupeAdjacent),
        Effect.map(Chunk.join("\n")),
        Effect.map((description) =>
          String.Equivalence(description, String.empty) ? "All Open :3" : description,
        ),
      );

      yield* response.editReply({
        payload: {
          embeds: [
            (yield* embedService.makeBaseEmbedBuilder())
              .setTitle(`Day ${day} Open Slots~`)
              .setDescription(openSlots)
              .toJSON(),
            (yield* embedService.makeBaseEmbedBuilder())
              .setTitle(`Day ${day} Filled Slots~`)
              .setDescription(filledSlots)
              .toJSON(),
            (yield* embedService.makeWebScheduleEmbed()).toJSON(),
          ],
        },
      });
    }),
  );
});

const makeButtonSubCommand = Effect.gen(function* () {
  const messageSlotService = yield* MessageSlotService;
  const permissionService = yield* PermissionService;

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
      const rest = yield* DiscordREST;
      const interactionGuildId = yield* getInteractionGuildId;
      const guildId = pipe(
        command.optionValueOptional("server_id"),
        Option.orElse(() => interactionGuildId),
        Option.getOrThrowWith(() => new Error("Guild not found in interaction or command options")),
      );

      yield* permissionService.checkInteractionUserMonitorGuild(guildId);
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const day = command.optionValue("day");
      const channelId = Option.getOrThrowWith(
        yield* getInteractionChannelId,
        () => new Error("Channel not found in interaction"),
      );

      const messageResult = yield* rest.createMessage(channelId, {
        content: `Press the button below to get the current open slots for day ${day}`,
        components: [makeMessageActionRowData((b) => b.setComponents(slotButtonData)).toJSON()],
      });

      yield* messageSlotService.upsertMessageSlotData(messageResult.id, {
        day,
        guildId,
        messageChannelId: channelId,
        createdByUserId: yield* getInteractionUserId,
      });

      yield* response.editReply({
        payload: {
          content: "Slot button sent!",
          flags: MessageFlags.Ephemeral,
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
    SheetApisRequestContext.asInteractionUser((command) =>
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
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      PermissionService.layer,
      ScheduleService.layer,
      FormatService.layer,
      EmbedService.layer,
      MessageSlotService.layer,
    ),
  ),
);
