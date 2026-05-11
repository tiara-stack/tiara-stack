import { escapeMarkdown } from "@discordjs/formatters";
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
import {
  EmbedService,
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

const getInteractionUser = Effect.gen(function* () {
  return (yield* Interaction.user()) as { id: string; username: string };
});

const formatHourRanges = (hours: readonly number[]): string => {
  if (hours.length === 0) return "None";
  const sorted = [...hours].sort((a, b) => a - b);
  const ranges: { start: number; end: number }[] = [];
  for (const h of sorted) {
    const last = ranges[ranges.length - 1];
    if (!last) {
      ranges.push({ start: h, end: h });
    } else if (h === last.end + 1) {
      last.end = h;
    } else if (h !== last.end) {
      ranges.push({ start: h, end: h });
    }
  }
  return ranges
    .map(({ start, end }) => (start === end ? `${start}` : `${start}-${end}`))
    .join(", ");
};

const makeListSubCommand = Effect.gen(function* () {
  const embedService = yield* EmbedService;
  const permissionService = yield* PermissionService;
  const scheduleService = yield* ScheduleService;

  return yield* CommandHelper.makeSubCommand(
    (builder) =>
      builder
        .setName("list")
        .setDescription("Get your schedule (fill/overfill/standby) for a day")
        .addNumberOption((option) =>
          option.setName("day").setDescription("The day to get the schedule for").setRequired(true),
        )
        .addUserOption((option) =>
          option.setName("user").setDescription("The user to get the schedule for"),
        )
        .addStringOption((option) =>
          option.setName("server_id").setDescription("The server to get the schedule for"),
        ),
    Effect.fn("schedule.list")(function* (command) {
      const response = yield* InteractionResponse;
      yield* response.deferReply({ flags: MessageFlags.Ephemeral });

      const serverId = command.optionValueOptional("server_id");
      const interactionGuildId = yield* getInteractionGuildId;
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrow,
      );

      const day = command.optionValue("day");
      const interactionUser = yield* getInteractionUser;

      yield* permissionService
        .checkInteractionUserApplicationOwner()
        .pipe(
          Effect.catch(() =>
            permissionService.checkInteractionInGuild(Option.getOrUndefined(serverId)),
          ),
        );

      const targetUser = command.optionUserValueOptional("user").pipe(
        Option.map(({ user }) => user as { id: string; username: string }),
        Option.getOrElse(() => interactionUser),
      );

      const { schedule } = yield* scheduleService.dayPlayerSchedule(guildId, day, targetUser.id);

      yield* response.editReply({
        payload: {
          embeds: [
            (yield* embedService.makeBaseEmbedBuilder())
              .setTitle(`${escapeMarkdown(targetUser.username)}'s Schedule for Day ${day}`)
              .setDescription(
                schedule.invisible
                  ? "It is kinda foggy around here... This schedule is not visible to you yet."
                  : null,
              )
              .addFields(
                schedule.invisible
                  ? []
                  : [
                      { name: "Fill", value: formatHourRanges(schedule.fillHours) },
                      { name: "Overfill", value: formatHourRanges(schedule.overfillHours) },
                      { name: "Standby", value: formatHourRanges(schedule.standbyHours) },
                    ],
              )
              .toJSON(),
            (yield* embedService.makeWebScheduleEmbed()).toJSON(),
          ],
        },
      });
    }),
  );
});

const makeScheduleCommand = Effect.gen(function* () {
  const listSubCommand = yield* makeListSubCommand;

  return yield* CommandHelper.makeCommand(
    (builder) =>
      builder
        .setName("schedule")
        .setDescription("Schedule commands")
        .setIntegrationTypes(
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        )
        .setContexts(
          InteractionContextType.BotDM,
          InteractionContextType.Guild,
          InteractionContextType.PrivateChannel,
        )
        .addSubcommand(() => listSubCommand.data),
    SheetApisRequestContext.asInteractionUser((command) =>
      command.subCommands({
        list: listSubCommand.handler,
      }),
    ),
  );
});

const makeGlobalScheduleCommand = Effect.gen(function* () {
  const scheduleCommand = yield* makeScheduleCommand;

  return CommandHelper.makeGlobalCommand(scheduleCommand.data, scheduleCommand.handler as never);
});

export const scheduleCommandLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalScheduleCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      PermissionService.layer,
      EmbedService.layer,
      ScheduleService.layer,
    ),
  ),
);
