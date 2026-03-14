import { escapeMarkdown } from "@discordjs/formatters";
import { Ix } from "dfx";
import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { Array, Effect, Layer, Match, Option, pipe, String } from "effect";
import { DiscordGatewayLayer } from "dfx-discord-utils/discord";
import { CommandHelper } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import {
  EmbedService,
  GuildConfigService,
  PermissionService,
  ScheduleService,
  SheetApisRequestContext,
} from "../services";

const formatHourRanges = (hours: readonly number[]): string => {
  if (Array.isEmptyReadonlyArray(hours)) return "None";
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
  const guildConfigService = yield* GuildConfigService;
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
      yield* command.deferReply({ flags: MessageFlags.Ephemeral });

      const serverId = command.optionValueOptional("server_id");
      const interactionGuildId = (yield* Interaction.guild()).pipe(Option.map((guild) => guild.id));
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrow,
      );

      const managerRoles = yield* guildConfigService.getGuildManagerRoles(guildId);

      const day = command.optionValue("day");
      const interactionUser = yield* Interaction.user();

      yield* Effect.firstSuccessOf([
        permissionService.checkInteractionUserApplicationOwner(),
        permissionService.checkInteractionInGuild(Option.getOrUndefined(serverId)),
      ]);

      const targetUser = command.optionUserValueOptional("user").pipe(
        Option.map(({ user }) => user),
        Option.getOrElse(() => interactionUser),
      );

      if (interactionUser.id !== targetUser.id) {
        const canView = yield* pipe(
          permissionService.checkInteractionUserGuildRoles(
            managerRoles.map((role) => role.roleId),
            guildId,
          ),
          Effect.catchTag("PermissionError", () => Effect.succeed(false)),
        );

        if (!canView) {
          yield* command.editReply({
            payload: {
              content: "You can only get your own schedule in the current server",
            },
          });
          return;
        }
      }

      const daySchedules = yield* scheduleService.dayPopulatedFillerSchedules(guildId, day);

      const filteredSchedules = pipe(
        daySchedules,
        Array.filterMap((scheduleItem) =>
          pipe(
            scheduleItem.hour,
            Option.map(() => scheduleItem),
            Option.flatMap((scheduleItem) =>
              pipe(
                Match.value(scheduleItem),
                Match.tagsExhaustive({
                  PopulatedBreakSchedule: () => Option.none(),
                  PopulatedSchedule: (s) => Option.some(s),
                }),
              ),
            ),
          ),
        ),
      );

      const invisible = pipe(
        filteredSchedules,
        Array.some(({ visible }) => !visible),
      );

      const fillHours = pipe(
        filteredSchedules,
        Array.filter((scheduleItem) =>
          pipe(
            scheduleItem.fills,
            Array.getSomes,
            Array.some((fill) =>
              pipe(
                Match.value(fill.player),
                Match.tagsExhaustive({
                  Player: (player) => String.Equivalence(player.id, targetUser.id),
                  PartialNamePlayer: () => false,
                }),
              ),
            ),
          ),
        ),
        Array.map((scheduleItem) => scheduleItem.hour),
        Array.getSomes,
      );

      const overfillHours = pipe(
        filteredSchedules,
        Array.filter((scheduleItem) =>
          pipe(
            scheduleItem.overfills,
            Array.some((overfill) =>
              pipe(
                Match.value(overfill.player),
                Match.tagsExhaustive({
                  Player: (player) => String.Equivalence(player.id, targetUser.id),
                  PartialNamePlayer: () => false,
                }),
              ),
            ),
          ),
        ),
        Array.map((scheduleItem) => scheduleItem.hour),
        Array.getSomes,
      );

      const standbyHours = pipe(
        filteredSchedules,
        Array.filter((scheduleItem) =>
          pipe(
            scheduleItem.standbys,
            Array.some((standby) =>
              pipe(
                Match.value(standby.player),
                Match.tagsExhaustive({
                  Player: (player) => String.Equivalence(player.id, targetUser.id),
                  PartialNamePlayer: () => false,
                }),
              ),
            ),
          ),
        ),
        Array.map((scheduleItem) => scheduleItem.hour),
        Array.getSomes,
      );

      yield* command.editReply({
        payload: {
          embeds: [
            (yield* embedService.makeBaseEmbedBuilder())
              .setTitle(`${escapeMarkdown(targetUser.username)}'s Schedule for Day ${day}`)
              .setDescription(
                invisible
                  ? "It is kinda foggy around here... This schedule is not visible to you yet."
                  : null,
              )
              .addFields(
                invisible
                  ? []
                  : [
                      { name: "Fill", value: formatHourRanges(fillHours) },
                      { name: "Overfill", value: formatHourRanges(overfillHours) },
                      { name: "Standby", value: formatHourRanges(standbyHours) },
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

  return CommandHelper.makeGlobalCommand(scheduleCommand.data, scheduleCommand.handler);
});

export const ScheduleCommandLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalScheduleCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      DiscordGatewayLayer,
      GuildConfigService.Default,
      PermissionService.Default,
      EmbedService.Default,
      ScheduleService.Default,
    ),
  ),
);
