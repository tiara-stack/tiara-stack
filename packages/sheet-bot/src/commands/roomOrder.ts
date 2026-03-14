import { bold, inlineCode, time, TimestampStyles } from "@discordjs/formatters";
import { Discord } from "dfx";
import { Ix } from "dfx";
import { InteractionsRegistry } from "dfx/gateway";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord-api-types/v10";
import {
  Array,
  Cause,
  DateTime,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  pipe,
} from "effect";
import { DiscordGatewayLayer } from "dfx-discord-utils/discord";
import { CommandHelper } from "dfx-discord-utils/utils";
import { Interaction } from "dfx-discord-utils/utils";
import {
  ConverterService,
  FormatService,
  GuildConfigService,
  MessageRoomOrderService,
  PermissionService,
  PlayerService,
  ScheduleService,
  SheetApisClient,
  SheetApisRequestContext,
} from "../services";
import { Sheet } from "sheet-apis/schema";
import { Array as ArrayUtils } from "typhoon-core/utils";
import { roomOrderActionRow } from "../messageComponents/buttons";

const formatEffectValue = (effectValue: number): string => {
  const rounded = Math.round(effectValue * 10) / 10;
  const formatted = rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(1);
  return `+${formatted}%`;
};

const makeManualSubCommand = Effect.gen(function* () {
  const converterService = yield* ConverterService;
  const formatService = yield* FormatService;
  const guildConfigService = yield* GuildConfigService;
  const messageRoomOrderService = yield* MessageRoomOrderService;
  const permissionService = yield* PermissionService;
  const playerService = yield* PlayerService;
  const scheduleService = yield* ScheduleService;
  const sheetApisClient = yield* SheetApisClient;

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
      const healOption = command.optionValueOptional("heal");

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

      const { start, end } = yield* pipe(
        converterService.convertHourToHourWindow(guildId, hour),
        Effect.flatMap(formatService.formatHourWindow),
      );

      const channelName = pipe(runningChannel.name, Option.getOrThrow);

      const schedules = yield* scheduleService.channelPopulatedManagerSchedules(
        guildId,
        channelName,
      );

      const schedulesByHour = pipe(
        schedules,
        Array.filterMap((s) =>
          pipe(
            s.hour,
            Option.map((h) => ({ hour: h, schedule: s })),
          ),
        ),
        ArrayUtils.Collect.toHashMapByKey("hour"),
        HashMap.map(({ schedule }) => schedule),
      );

      const prevScheduleEntry = HashMap.get(schedulesByHour, hour - 1);
      const currentScheduleEntry = HashMap.get(schedulesByHour, hour);

      const previousFills = pipe(
        prevScheduleEntry,
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
      );

      const fills = pipe(
        currentScheduleEntry,
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
      );

      const runnerNames = fills.map((fill) => fill.player.name);
      const previousFillNames = previousFills.map((fill) => fill.player.name);
      const fillNames = fills.map((fill) => fill.player.name);

      const monitorName = pipe(
        currentScheduleEntry,
        Option.flatMap((schedule) =>
          pipe(
            Match.value(schedule),
            Match.tagsExhaustive({
              PopulatedBreakSchedule: () => Option.none<Sheet.PopulatedScheduleMonitor>(),
              PopulatedSchedule: (schedule) => schedule.monitor,
            }),
          ),
        ),
        Option.map((monitor) => monitor.monitor.name),
      );

      const teams = yield* pipe(
        playerService.getTeamsByName(guildId, fillNames),
        Effect.map((teams) =>
          Array.map(Array.zip(fills, teams), ([fill, teams]) =>
            Array.map(
              teams,
              (team) =>
                new Sheet.Team({
                  ...team,
                  tags: pipe(
                    team.tags,
                    (tags) =>
                      tags.includes("tierer_hint") && runnerNames.includes(fill.player.name)
                        ? Array.append(tags, "tierer")
                        : tags,
                    (tags) => (fill.enc ? Array.append(tags, "encable") : tags),
                  ),
                }),
            ),
          ),
        ),
      );

      const healNeeded = Option.getOrElse(healOption, () => 0);

      const client = sheetApisClient.get();
      const roomOrders = yield* pipe(
        client.calc.calcBot({
          payload: {
            config: {
              healNeeded,
              considerEnc: true,
            },
            players: teams,
          },
        }),
        Effect.flatMap(
          Array.match({
            onEmpty: () =>
              Effect.fail(
                new Cause.NoSuchElementException("cannot calculate room orders with given teams"),
              ),
            onNonEmpty: Effect.succeed,
          }),
        ),
      );

      const firstRoom = Array.headNonEmpty(roomOrders).room;

      const roomOrderContent = [
        `${bold(`Hour ${hour}`)} ${time(start, TimestampStyles.LongDateShortTime)} - ${time(end, TimestampStyles.LongDateShortTime)}`,
        ...(Option.isSome(monitorName) ? [`${inlineCode("Monitor:")} ${monitorName.value}`] : []),
        "",
        ...firstRoom.map(({ team, tags, effectValue }, i) => {
          const hasTiererTag = tags.includes("tierer");
          const effectParts = hasTiererTag
            ? []
            : pipe(
                [
                  Option.some(formatEffectValue(effectValue)),
                  tags.includes("enc") ? Option.some("enc") : Option.none(),
                  tags.includes("avoid_enc") ? Option.some("avoid enc") : Option.none(),
                ],
                Array.getSomes,
              );

          const effectStr = effectParts.length > 0 ? ` (${effectParts.join(", ")})` : "";
          return `${inlineCode(`P${i + 1}:`)}  ${team}${effectStr}`;
        }),
        "",
        `${inlineCode("In:")} ${pipe(
          HashSet.fromIterable(fillNames),
          HashSet.difference(HashSet.fromIterable(previousFillNames)),
          HashSet.toValues,
          (arr) => (arr.length > 0 ? arr.join(", ") : "(none)"),
        )}`,
        `${inlineCode("Out:")} ${pipe(
          HashSet.fromIterable(previousFillNames),
          HashSet.difference(HashSet.fromIterable(fillNames)),
          HashSet.toValues,
          (arr) => (arr.length > 0 ? arr.join(", ") : "(none)"),
        )}`,
      ].join("\n");

      const messageResult = yield* command.editReply({
        payload: {
          content: roomOrderContent,
          components: [
            roomOrderActionRow({ minRank: 0, maxRank: roomOrders.length - 1 }, 0).toJSON(),
          ],
        },
      });

      const entries = roomOrders
        .map(({ room }, rank) =>
          room.map((entry, position) => ({
            rank,
            position,
            hour,
            team: entry.team,
            tags: Array.fromIterable(entry.tags),
            effectValue: entry.effectValue,
          })),
        )
        .flat();

      yield* messageRoomOrderService.upsertMessageRoomOrder(messageResult.id, {
        previousFills: previousFillNames,
        fills: fillNames,
        hour,
        rank: 0,
        monitor: Option.getOrNull(monitorName),
      });

      yield* messageRoomOrderService.upsertMessageRoomOrderEntry(messageResult.id, entries);
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
    SheetApisRequestContext.asInteractionUser((command) =>
      command.subCommands({
        manual: manualSubCommand.handler,
      }),
    ),
  );
});

const makeGlobalRoomOrderCommand = Effect.gen(function* () {
  const roomOrderCommand = yield* makeRoomOrderCommand;

  return CommandHelper.makeGlobalCommand(roomOrderCommand.data, roomOrderCommand.handler);
});

export const RoomOrderCommandLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const registry = yield* InteractionsRegistry;
    const command = yield* makeGlobalRoomOrderCommand;

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
      PlayerService.Default,
      SheetApisClient.Default,
      MessageRoomOrderService.Default,
    ),
  ),
);
