import { Discord, Ix } from "dfx";
import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Array, Chunk, Effect, Layer, Number, Option, Order, pipe, Schema, String } from "effect";
import { DiscordGatewayLayer } from "dfx-discord-utils/discord";
import { CommandHelper } from "dfx-discord-utils/utils";
import { Interaction, makeMessageActionRowData } from "dfx-discord-utils/utils";
import {
  EmbedService,
  FormatService,
  GuildConfigService,
  MessageSlotService,
  PermissionService,
  ScheduleService,
  SheetApisRequestContext,
} from "../services";
import { slotButtonData } from "../messageComponents/buttons/slot";

const makeListSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const formatService = yield* FormatService;
  const guildConfigService = yield* GuildConfigService;
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
      const serverId = command.optionValueOptional("server_id");
      const messageType = pipe(
        command.optionValueOptional("message_type"),
        Option.getOrElse(() => "ephemeral"),
        Schema.decodeUnknown(Schema.Literal("persistent", "ephemeral")),
      );

      const isEphemeral = yield* pipe(
        messageType,
        Effect.map((type) => type === "ephemeral"),
      );

      // Get guildId from interaction or provided serverId
      const interactionGuildId = (yield* Interaction.guild()).pipe(Option.map((guild) => guild.id));
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrow,
      );

      // Check if user is app owner or has ManageGuild permission
      yield* Effect.firstSuccessOf([
        permissionService.checkInteractionUserApplicationOwner(),
        permissionService.checkInteractionUserGuildPermissions(
          Discord.Permissions.ManageGuild,
          guildId,
        ),
      ]);

      const day = command.optionValue("day");

      yield* command.deferReply({ flags: isEphemeral ? MessageFlags.Ephemeral : undefined });

      const managerRoles = yield* guildConfigService.getGuildManagerRoles(guildId);

      yield* pipe(
        permissionService.checkInteractionUserGuildRoles(
          managerRoles.map((role) => role.roleId),
          guildId,
        ),
        Effect.unless(() => isEphemeral),
      );

      const daySchedule = yield* scheduleService.dayPopulatedFillerSchedules(guildId, day);

      const filteredSchedules = pipe(
        daySchedule,
        Array.filterMap((schedule) =>
          pipe(
            schedule.hour,
            Option.map(() => schedule),
          ),
        ),
      );

      const sortedSchedules = pipe(
        filteredSchedules,
        Array.sortBy(Order.mapInput(Option.getOrder(Number.Order), ({ hour }) => hour)),
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

      const embeds = [
        (yield* embedService.makeBaseEmbedBuilder())
          .setTitle(`Day ${day} Open Slots~`)
          .setDescription(openSlots)
          .toJSON(),
        (yield* embedService.makeBaseEmbedBuilder())
          .setTitle(`Day ${day} Filled Slots~`)
          .setDescription(filledSlots)
          .toJSON(),
        (yield* embedService.makeWebScheduleEmbed()).toJSON(),
      ];

      yield* command.editReply({
        payload: {
          embeds,
        },
      });
    }),
  );
});

const makeButtonSubCommand = Effect.gen(function* () {
  const guildConfigService = yield* GuildConfigService;
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
      const serverId = command.optionValueOptional("server_id");

      // Get guildId from interaction or provided serverId
      const interactionGuildId = (yield* Interaction.guild()).pipe(Option.map((guild) => guild.id));
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrow,
      );

      // Check if user is app owner or has ManageGuild permission
      yield* Effect.firstSuccessOf([
        permissionService.checkInteractionUserApplicationOwner(),
        permissionService.checkInteractionUserGuildPermissions(
          Discord.Permissions.ManageGuild,
          guildId,
        ),
      ]);

      const managerRoles = yield* guildConfigService.getGuildManagerRoles(guildId);

      yield* permissionService.checkInteractionUserGuildRoles(
        managerRoles.map((role) => role.roleId),
        guildId,
      );

      yield* command.deferReply({ flags: MessageFlags.Ephemeral });

      const day = command.optionValue("day");

      const channelId = yield* pipe(
        Interaction.channel(),
        Effect.flatMap((channel) =>
          channel.pipe(
            Option.map((c) => c.id),
            Option.match({
              onSome: Effect.succeed,
              onNone: () => Effect.fail(new Error("Channel not found in interaction")),
            }),
          ),
        ),
      );

      const messageResult = yield* command.rest.createMessage(channelId, {
        content: `Press the button below to get the current open slots for day ${day}`,
        components: [makeMessageActionRowData((b) => b.setComponents(slotButtonData)).toJSON()],
      });

      yield* messageSlotService.upsertMessageSlotData(messageResult.id, day);

      yield* command.editReply({
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

  return CommandHelper.makeGlobalCommand(slotCommand.data, slotCommand.handler);
});

export const SlotCommandLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalSlotCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      DiscordGatewayLayer,
      PermissionService.Default,
      ScheduleService.Default,
      FormatService.Default,
      EmbedService.Default,
      GuildConfigService.Default,
      MessageSlotService.Default,
    ),
  ),
);
