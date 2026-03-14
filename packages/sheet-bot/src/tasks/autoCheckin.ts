import { channelMention, subtext, userMention } from "@discordjs/formatters";
import {
  Array,
  DateTime,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Match,
  Option,
  Schedule,
  Cron,
  pipe,
} from "effect";
import { DiscordREST } from "dfx";
import { DiscordGatewayLayer } from "dfx-discord-utils/discord";
import { checkinButtonData } from "../messageComponents/buttons/checkin";
import { Array as ArrayUtils } from "typhoon-core/utils";
import {
  ConverterService,
  EmbedService,
  FormatService,
  GuildConfigService,
  MessageCheckinService,
  ScheduleService,
  SheetApisRequestContext,
  SheetService,
} from "../services";
import { ActionRowBuilder } from "dfx-discord-utils/utils";
import { Sheet } from "sheet-apis/schema";

const autoCheckinPreviewNotice = "Sent automatically via auto check-in (preview; may have bugs).";

// Formatter helpers for auto check-in formatting logic
const formatChannelString = (
  roleId: Option.Option<string>,
  channelId: string,
  channelName: Option.Option<string>,
): string =>
  pipe(
    roleId,
    Option.match({
      onSome: () =>
        pipe(
          channelName,
          Option.map((name) => `head to ${name}`),
          Option.getOrElse(
            () => "await further instructions from the monitor on where the running channel is",
          ),
        ),
      onNone: () => `head to ${channelMention(channelId)}`,
    }),
  );

const formatPreviewContent = (content: string): string =>
  [content, subtext(autoCheckinPreviewNotice)].join("\n");

const getFillIds = (
  schedule: Option.Option<Sheet.PopulatedSchedule | Sheet.PopulatedBreakSchedule>,
): Option.Option<string[]> =>
  pipe(
    schedule,
    Option.flatMap((s) =>
      pipe(
        Match.value(s),
        Match.tagsExhaustive({
          PopulatedBreakSchedule: () => Option.none<string[]>(),
          PopulatedSchedule: (schedule) =>
            pipe(
              schedule.fills,
              Array.filter(Option.isSome),
              Array.map((f) => f.value),
              Array.filterMap((p) =>
                pipe(
                  Match.value(p.player),
                  Match.tagsExhaustive({
                    Player: (player) => Option.some(player.id),
                    PartialNamePlayer: () => Option.none(),
                  }),
                ),
              ),
              HashSet.fromIterable,
              HashSet.toValues,
              Option.some,
            ),
        }),
      ),
    ),
  );

const getMonitorInfo = (
  schedule: Option.Option<Sheet.PopulatedSchedule | Sheet.PopulatedBreakSchedule>,
) =>
  pipe(
    schedule,
    Option.match({
      onNone: () => ({
        mention: Option.none() as Option.Option<string>,
        mentionUserId: Option.none() as Option.Option<string>,
        failure: Option.none() as Option.Option<string>,
      }),
      onSome: (s) =>
        pipe(
          Match.value(s),
          Match.tagsExhaustive({
            PopulatedBreakSchedule: () => ({
              mention: Option.none() as Option.Option<string>,
              mentionUserId: Option.none() as Option.Option<string>,
              failure: Option.none() as Option.Option<string>,
            }),
            PopulatedSchedule: (schedule) =>
              pipe(
                schedule.monitor,
                Option.match({
                  onNone: () => ({
                    mention: Option.none() as Option.Option<string>,
                    mentionUserId: Option.none() as Option.Option<string>,
                    failure: Option.some(
                      "Cannot ping monitor: monitor not assigned for this hour.",
                    ),
                  }),
                  onSome: (populatedMonitor) =>
                    pipe(
                      Match.value(populatedMonitor.monitor),
                      Match.tagsExhaustive({
                        Monitor: (monitorData) => ({
                          mention: Option.some(userMention(monitorData.id)),
                          mentionUserId: Option.some(monitorData.id),
                          failure: Option.none() as Option.Option<string>,
                        }),
                        PartialNameMonitor: (monitorData) => ({
                          mention: Option.none() as Option.Option<string>,
                          mentionUserId: Option.none() as Option.Option<string>,
                          failure: Option.some(
                            `Cannot ping monitor: monitor "${monitorData.name}" is missing a Discord ID in the sheet.`,
                          ),
                        }),
                      }),
                    ),
                }),
              ),
          }),
        ),
    }),
  );

const processChannel = Effect.fn("processChannel")(function* (
  guildId: string,
  hour: number,
  channelName: string,
) {
  const runningChannel = yield* GuildConfigService.getGuildRunningChannelByName(
    guildId,
    channelName,
  );

  const checkinChannelId = Option.getOrElse(
    runningChannel.checkinChannelId,
    () => runningChannel.channelId,
  );

  const channelSchedules = yield* ScheduleService.channelPopulatedManagerSchedules(
    guildId,
    channelName,
  );

  const schedulesByHour = pipe(
    channelSchedules,
    Array.filterMap((schedule) =>
      pipe(
        schedule.hour,
        Option.map((h) => ({ hour: h, schedule })),
      ),
    ),
    ArrayUtils.Collect.toHashMapByKey("hour"),
    HashMap.map(({ schedule }) => schedule),
  );

  const prevScheduleOption = HashMap.get(schedulesByHour, hour - 1);
  const currentScheduleOption = HashMap.get(schedulesByHour, hour);

  const formatResult = yield* pipe(
    FormatService.formatCheckIn(guildId, {
      prevSchedule: prevScheduleOption,
      schedule: currentScheduleOption,
      channelString: formatChannelString(
        runningChannel.roleId,
        runningChannel.channelId,
        runningChannel.name,
      ),
      template: undefined,
    }),
  );

  const discordRest = yield* DiscordREST;

  yield* pipe(
    formatResult.checkinMessage,
    Option.match({
      onNone: () => Effect.succeed(undefined),
      onSome: (checkinMessage) =>
        pipe(
          discordRest.createMessage(checkinChannelId, {
            content: formatPreviewContent(checkinMessage),
            components: [new ActionRowBuilder().addComponent(checkinButtonData).toJSON()],
          }),
          Effect.flatMap((messageResult) =>
            pipe(
              getFillIds(currentScheduleOption),
              Option.match({
                onNone: () =>
                  Effect.all([
                    MessageCheckinService.upsertMessageCheckinData(messageResult.id, {
                      initialMessage: formatPreviewContent(checkinMessage),
                      hour,
                      channelId: runningChannel.channelId,
                      roleId: Option.getOrNull(runningChannel.roleId),
                    }),
                    Effect.succeed(undefined),
                  ]),
                onSome: (fillIds) =>
                  Effect.all([
                    MessageCheckinService.upsertMessageCheckinData(messageResult.id, {
                      initialMessage: formatPreviewContent(checkinMessage),
                      hour,
                      channelId: runningChannel.channelId,
                      roleId: Option.getOrNull(runningChannel.roleId),
                    }),
                    fillIds.length > 0
                      ? MessageCheckinService.addMessageCheckinMembers(messageResult.id, fillIds)
                      : Effect.succeed(undefined),
                  ]),
              }),
            ),
          ),
        ),
    }),
  );

  const monitorInfo = getMonitorInfo(currentScheduleOption);

  const embedDescriptionParts = [
    formatResult.managerCheckinMessage,
    ...pipe(
      monitorInfo.failure,
      Option.match({
        onSome: (failure) => [subtext(failure)],
        onNone: () => [],
      }),
    ),
    subtext(autoCheckinPreviewNotice),
  ];

  const embed = yield* EmbedService.makeBaseEmbedBuilder().pipe(
    Effect.map((builder) =>
      builder
        .setTitle("Auto check-in summary for monitors")
        .setDescription(embedDescriptionParts.join("\n"))
        .toJSON(),
    ),
  );

  yield* discordRest.createMessage(runningChannel.channelId, {
    content: pipe(monitorInfo.mention, Option.getOrUndefined),
    embeds: [embed],
    allowed_mentions: Option.match(monitorInfo.mentionUserId, {
      onSome: (uid) => ({ users: [uid] as const }),
      onNone: () => ({ parse: [] as const }),
    }),
  });

  return Option.isSome(formatResult.checkinMessage) ? 1 : 0;
});

const processGuild = (guildId: string) =>
  Effect.gen(function* () {
    const hour = yield* pipe(
      DateTime.now,
      Effect.map(DateTime.addDuration("20 minutes")),
      Effect.flatMap((dt) => ConverterService.convertDateTimeToHour(guildId, dt)),
    );

    const allSchedules = yield* SheetService.getAllManagerSchedules(guildId);

    const channelNames: string[] = pipe(
      allSchedules,
      Array.map((s) => s.channel),
      (names) => HashSet.fromIterable(names),
      HashSet.toValues,
    );

    const sentCount = yield* pipe(
      channelNames,
      Effect.forEach(
        (channelName) =>
          pipe(
            processChannel(guildId, hour, channelName),
            Effect.catchAll((err) => pipe(Effect.logError(err), Effect.as(0))),
          ),
        { concurrency: "unbounded" },
      ),
      Effect.map((counts) => counts.reduce((acc: number, n: number) => acc + n, 0)),
    );

    return sentCount;
  });

export const AutoCheckinTaskLive = Layer.scopedDiscard(
  pipe(
    SheetApisRequestContext.asBot(
      Effect.fn("autoCheckinTask", { attributes: { task: "autoCheckin" } })(
        function* () {
          yield* Effect.log("running auto check-in task...");

          const guildConfigs = yield* GuildConfigService.getAutoCheckinGuilds();

          const totalSent = yield* pipe(
            guildConfigs,
            Effect.forEach(
              (guildConfig) =>
                pipe(
                  processGuild(guildConfig.guildId),
                  Effect.provide(
                    Layer.mergeAll(
                      DiscordGatewayLayer,
                      ConverterService.Default,
                      EmbedService.Default,
                      FormatService.Default,
                      MessageCheckinService.Default,
                      ScheduleService.Default,
                      SheetService.Default,
                    ),
                  ),
                  Effect.catchAll((err) => pipe(Effect.logError(err), Effect.as(0))),
                ),
              { concurrency: "unbounded" },
            ),
            Effect.map((counts) => counts.reduce((acc: number, n: number) => acc + n, 0)),
          );

          yield* Effect.log(
            `sent ${totalSent} check-in message(s) across all ${guildConfigs.length} guilds`,
          );
        },
        Effect.annotateLogs({ task: "autoCheckin" }),
      ),
    )(),
    Effect.schedule(
      Schedule.cron(
        Cron.make({
          seconds: [0],
          minutes: [45],
          hours: [],
          days: [],
          months: [],
          weekdays: [],
        }),
      ),
    ),
    Effect.forkDaemon,
  ),
).pipe(Layer.provide(Layer.mergeAll(GuildConfigService.Default, SheetService.Default)));
