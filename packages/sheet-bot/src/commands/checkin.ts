import { channelMention } from "@discordjs/formatters";
import { Array, DateTime, Effect, HashMap, HashSet, Layer, Match, Option, pipe } from "effect";
import { Discord, Ix } from "dfx";
import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import { DiscordGatewayLayer } from "dfx-discord-utils/discord";
import { CommandHelper } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import {
  ConverterService,
  FormatService,
  GuildConfigService,
  MessageCheckinService,
  PermissionService,
  ScheduleService,
  SheetApisRequestContext,
} from "../services";
import { checkinButtonData } from "../messageComponents/buttons/checkin";
import { makeMessageActionRowData } from "dfx-discord-utils/utils";
import { Array as ArrayUtils } from "typhoon-core/utils";

const makeManualSubCommand = Effect.gen(function* () {
  const converterService = yield* ConverterService;
  const formatService = yield* FormatService;
  const guildConfigService = yield* GuildConfigService;
  const messageCheckinService = yield* MessageCheckinService;
  const permissionService = yield* PermissionService;
  const scheduleService = yield* ScheduleService;

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
      yield* command.deferReply({ flags: MessageFlags.Ephemeral });

      const serverId = command.optionValueOptional("server_id");
      const { guildId } = yield* permissionService.checkInteractionUserGuildPermissions(
        Discord.Permissions.ManageGuild,
        Option.getOrUndefined(serverId),
      );

      const managerRoles = yield* guildConfigService.getGuildManagerRoles(guildId);

      yield* Effect.firstSuccessOf([
        permissionService.checkInteractionUserApplicationOwner(),
        permissionService.checkInteractionUserGuildRoles(
          managerRoles.map((role) => role.roleId),
          guildId,
        ),
      ]);

      const hourOption = command.optionValueOptional("hour");
      const templateOption = command.optionValueOptional("template");

      const hour = yield* hourOption.pipe(
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            pipe(
              DateTime.now,
              Effect.map(DateTime.addDuration("20 minutes")),
              Effect.flatMap((dt) => converterService.convertDateTimeToHour(guildId, dt)),
            ),
        }),
      );

      const channelNameOption = command.optionValueOptional("channel_name");
      const runningChannel = yield* channelNameOption.pipe(
        Option.match({
          onSome: (channelName) =>
            guildConfigService.getGuildRunningChannelByName(guildId, channelName),
          onNone: () =>
            pipe(
              Interaction.channel(),
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

      const channelName = pipe(runningChannel.name, Option.getOrThrow);

      const schedules = yield* scheduleService.channelPopulatedManagerSchedules(
        guildId,
        channelName,
      );

      const schedulesByHour = pipe(
        schedules,
        Array.filterMap((schedule) =>
          pipe(
            schedule.hour,
            Option.map((h) => ({ hour: h, schedule })),
          ),
        ),
        ArrayUtils.Collect.toHashMapByKey("hour"),
        HashMap.map(({ schedule }) => schedule),
      );

      const prevSchedule = HashMap.get(schedulesByHour, hour - 1);
      const schedule = HashMap.get(schedulesByHour, hour);

      const channelString = pipe(
        runningChannel.roleId,
        Option.match({
          onSome: () =>
            pipe(
              runningChannel.name,
              Option.map((name) => `head to ${name}`),
              Option.getOrElse(
                () => "await further instructions from the monitor on where the running channel is",
              ),
            ),
          onNone: () => `head to ${channelMention(runningChannel.channelId)}`,
        }),
      );

      const { checkinMessage, managerCheckinMessage } = yield* formatService.formatCheckIn(
        guildId,
        {
          prevSchedule,
          schedule,
          channelString,
          template: Option.getOrUndefined(templateOption),
        },
      );

      const fillIds = pipe(
        schedule,
        Option.map((s) =>
          pipe(
            Match.value(s),
            Match.tagsExhaustive({
              PopulatedBreakSchedule: () => [],
              PopulatedSchedule: (s) => s.fills,
            }),
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
            HashSet.fromIterable,
            HashSet.toValues,
          ),
        ),
        Option.getOrElse(() => [] as string[]),
      );

      const checkinChannelId = yield* pipe(
        runningChannel.checkinChannelId,
        Option.match({
          onSome: Effect.succeed,
          onNone: () =>
            pipe(
              Interaction.channel(),
              Effect.flatMap((channel) =>
                channel.pipe(
                  Option.map((c) => c.id),
                  Option.match({
                    onSome: Effect.succeed,
                    onNone: () => Effect.fail(new Error("Channel ID is required")),
                  }),
                ),
              ),
            ),
        }),
      );

      if (Option.isSome(checkinMessage)) {
        const messageResult = yield* command.rest.createMessage(checkinChannelId, {
          content: checkinMessage.value,
          components: [
            makeMessageActionRowData((b) => b.setComponents(checkinButtonData)).toJSON(),
          ],
        });

        yield* Effect.all(
          [
            messageCheckinService.upsertMessageCheckinData(messageResult.id, {
              initialMessage: checkinMessage.value,
              hour,
              channelId: runningChannel.channelId,
              roleId: Option.getOrNull(runningChannel.roleId),
            }),
            pipe(
              messageCheckinService.addMessageCheckinMembers(messageResult.id, fillIds),
              Effect.unless(() => fillIds.length === 0),
            ),
          ],
          { concurrency: "unbounded" },
        );
      }

      yield* command.editReply({
        payload: {
          content: managerCheckinMessage,
          flags: MessageFlags.Ephemeral,
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
    SheetApisRequestContext.asInteractionUser((command) =>
      command.subCommands({
        manual: manualSubCommand.handler,
      }),
    ),
  );
});

const makeGlobalCheckinCommand = Effect.gen(function* () {
  const checkinCommand = yield* makeCheckinCommand;

  return CommandHelper.makeGlobalCommand(checkinCommand.data, checkinCommand.handler);
});

export const CheckinCommandLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalCheckinCommand;

    yield* registry.register(Ix.builder.add(command).catchAllCause(Effect.log));
  }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      DiscordGatewayLayer,
      PermissionService.Default,
      GuildConfigService.Default,
      ScheduleService.Default,
      ConverterService.Default,
      FormatService.Default,
      MessageCheckinService.Default,
    ),
  ),
);
