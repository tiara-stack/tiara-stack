import { userMention } from "@discordjs/formatters";
import { Ix } from "dfx";
import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Array, DateTime, Effect, Equal, Layer, Match, Option, Order, Number, pipe } from "effect";
import { DiscordGatewayLayer } from "dfx-discord-utils/discord";
import { CommandHelper } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import {
  ConverterService,
  EmbedService,
  GuildConfigService,
  PermissionService,
  ScheduleService,
  SheetApisRequestContext,
} from "../services";
import { MembersCache, RolesCache } from "dfx-discord-utils/discord";
import { GuildMemberUtils } from "dfx-discord-utils/utils";

const makeManualSubCommand = Effect.gen(function* () {
  const converterService = yield* ConverterService;
  const guildConfigService = yield* GuildConfigService;
  const guildMemberUtils = yield* GuildMemberUtils;
  const membersCache = yield* MembersCache;
  const permissionService = yield* PermissionService;
  const scheduleService = yield* ScheduleService;

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
      yield* command.deferReply();

      const serverId = command.optionValueOptional("server_id");
      const interactionGuildId = (yield* Interaction.guild()).pipe(Option.map((guild) => guild.id));
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrow,
      );

      const managerRoles = yield* guildConfigService.getGuildManagerRoles(guildId);

      yield* Effect.all({
        isOwnerOrInGuild: permissionService
          .checkInteractionUserApplicationOwner()
          .pipe(
            Effect.catchTag("PermissionError", () =>
              permissionService.checkInteractionInGuild(Option.getOrUndefined(serverId)),
            ),
          ),
        hasManagerRole: permissionService.checkInteractionUserGuildRoles(
          managerRoles.map((role) => role.roleId),
          guildId,
        ),
      });

      const date = yield* DateTime.now;
      const minute = DateTime.getPart(date, "minutes");
      if (minute >= 40) {
        yield* command.editReply({
          payload: {
            content: "Cannot kick out until next hour starts",
          },
        });
        return;
      }

      const hourOption = command.optionValueOptional("hour");
      const hour = yield* hourOption.pipe(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            converterService.convertDateTimeToHour(
              guildId,
              DateTime.addDuration(date, "20 minutes"),
            ),
        }),
      );

      const channelNameOption = command.optionValueOptional("channel_name");
      const runningChannel = yield* channelNameOption.pipe(
        Option.match({
          onSome: (channelName) =>
            guildConfigService.getGuildRunningChannelByName(guildId, channelName),
          onNone: () =>
            Interaction.channel().pipe(
              Effect.flatMap((channel) =>
                channel.pipe(
                  Option.map((c) => c.id),
                  Option.match({
                    onSome: (channelId) =>
                      guildConfigService.getGuildRunningChannelById(guildId, channelId),
                    onNone: () => Effect.fail(new Error("Channel not found in interaction")),
                  }),
                ),
              ),
            ),
        }),
      );

      const channelName = runningChannel.name.pipe(Option.getOrThrow);

      const scheduleItem = pipe(
        yield* scheduleService.channelPopulatedManagerSchedules(guildId, channelName),
        Array.findFirst((s) => Equal.equals(s.hour, Option.some(hour))),
      );

      const fillIds = pipe(
        scheduleItem,
        Option.map((schedule) =>
          pipe(
            Match.value(schedule),
            Match.tagsExhaustive({
              PopulatedBreakSchedule: () => [],
              PopulatedSchedule: (schedule) => schedule.fills,
            }),
          ),
        ),
        Option.getOrElse(() => []),
        Array.getSomes,
        Array.map((player) =>
          pipe(
            Match.value(player.player),
            Match.tagsExhaustive({
              Player: (player) => Option.some(player.id),
              PartialNamePlayer: () => Option.none(),
            }),
          ),
        ),
        Array.getSomes,
      );

      const roleId = runningChannel.roleId;

      if (Option.isNone(roleId)) {
        yield* command.editReply({
          payload: {
            content: "No role configured for this channel",
          },
        });
        return;
      }

      // Get all members with the role
      const allMembers = yield* membersCache.getForParent(guildId);
      const membersWithRole = [...allMembers.values()].filter((member) =>
        member.roles.includes(roleId.value),
      );

      // Filter out members who are in fills
      const removedMembers = membersWithRole.filter((member) => !fillIds.includes(member.user.id));

      // Remove the role from each member
      yield* pipe(
        removedMembers,
        Effect.forEach((member) =>
          guildMemberUtils.removeRoles(guildId, member.user.id, [roleId.value]),
        ),
      );

      // Reply with the list of kicked out members
      yield* command.editReply({
        payload: {
          content: pipe(removedMembers, Array.length, Order.greaterThan(Number.Order)(0))
            ? `Kicked out ${removedMembers.map((m) => userMention(m.user.id)).join(" ")}`
            : "No players to kick out",
          allowed_mentions: { parse: [] },
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
    SheetApisRequestContext.asInteractionUser((command) =>
      command.subCommands({
        manual: manualSubCommand.handler,
      }),
    ),
  );
});

const makeGlobalKickoutCommand = Effect.gen(function* () {
  const kickoutCommand = yield* makeKickoutCommand;

  return CommandHelper.makeGlobalCommand(kickoutCommand.data, kickoutCommand.handler);
});

export const KickoutCommandLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalKickoutCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      DiscordGatewayLayer,
      GuildMemberUtils.Default,
      MembersCache.Default,
      PermissionService.Default,
      RolesCache.Default,
      GuildConfigService.Default,
      ScheduleService.Default,
      ConverterService.Default,
      EmbedService.Default,
    ),
  ),
);
