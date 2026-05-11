import { userMention } from "@discordjs/formatters";
import { InteractionsRegistry } from "dfx/gateway";
import { ApplicationIntegrationType, InteractionContextType } from "discord-api-types/v10";
import { Ix } from "dfx/index";
import { Array, DateTime, Effect, Equal, Layer, Match, Option, Order, Number, pipe } from "effect";
import { discordGatewayLayer } from "../discord/gateway";
import { MembersCache } from "dfx-discord-utils/discord/cache";
import { CommandHelper, InteractionResponse } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import { GuildMember } from "dfx-discord-utils/utils";
import {
  ConverterService,
  EmbedService,
  GuildConfigService,
  PermissionService,
  ScheduleService,
  SheetApisRequestContext,
} from "../services";
import { cachesLayer } from "../discord/cache";
import { discordApplicationLayer } from "../discord/application";
import { discordConfigLayer } from "../discord/config";

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
  const converterService = yield* ConverterService;
  const guildConfigService = yield* GuildConfigService;
  const guildMemberUtils = yield* GuildMember.GuildMemberUtils;
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
      const response = yield* InteractionResponse;
      yield* response.deferReply();

      const serverId = command.optionValueOptional("server_id");
      const interactionGuildId = yield* getInteractionGuildId;
      const guildId = pipe(
        serverId,
        Option.orElse(() => interactionGuildId),
        Option.getOrThrow,
      );

      // Keep this check in the bot because the command still removes Discord roles directly.
      yield* permissionService.checkInteractionUserMonitorGuild(guildId);

      const date = yield* DateTime.now;
      const minute = DateTime.getPart(date, "minute");
      if (minute >= 40) {
        yield* response.editReply({
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
            guildConfigService.getGuildChannelByName(guildId, channelName, true),
          onNone: () =>
            getInteractionChannelId.pipe(
              Effect.map(
                Option.getOrThrowWith(() => new Error("Channel not found in interaction")),
              ),
              Effect.flatMap((channelId) =>
                guildConfigService.getGuildChannelById(guildId, channelId, true),
              ),
            ),
        }),
      );

      const channelName = runningChannel.name.pipe(Option.getOrThrow);

      const scheduleItem = pipe(
        yield* scheduleService.channelPopulatedMonitorSchedules(guildId, channelName),
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
        yield* response.editReply({
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
      yield* response.editReply({
        payload: {
          content: pipe(removedMembers, Array.length, Order.isGreaterThan(Number.Order)(0))
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
    Layer.mergeAll(
      discordGatewayLayer,
      discordApplicationLayer,
      Layer.provide(GuildMember.GuildMemberUtils.layer, discordConfigLayer),
      cachesLayer,
      PermissionService.layer,
      GuildConfigService.layer,
      ScheduleService.layer,
      ConverterService.layer,
      EmbedService.layer,
    ),
  ),
);
