import {
  Array,
  Chunk,
  DateTime,
  Duration,
  Effect,
  Either,
  HashMap,
  HashSet,
  Match,
  Number,
  Option,
  pipe,
} from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { Array as ArrayUtils } from "typhoon-core/utils";
import { GuildConfigService } from "./guildConfig";
import { ScheduleService } from "./schedule";
import { CalcConfig, CalcService } from "./calc";
import { SheetService } from "./sheet";
import { GeneratedRoomOrderEntry, RoomOrderGenerateResult } from "@/schemas/roomOrder";
import { MessageRoomOrderRange } from "@/schemas/messageRoomOrder";
import { Player, PlayerTeam, Team } from "@/schemas/sheet";

const formatEffectValue = (effectValue: number): string => {
  const rounded = Math.round(effectValue * 10) / 10;
  const formatted = rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(1);
  return `+${formatted}%`;
};

const formatDiscordTimestamp = (dateTime: DateTime.DateTime): string =>
  `<t:${Math.floor(DateTime.toEpochMillis(dateTime) / 1000)}:f>`;

const getSheetIdFromGuildId = (guildId: string, guildConfigService: GuildConfigService) =>
  pipe(
    guildConfigService.getGuildConfig(guildId),
    Effect.flatMap(
      Option.match({
        onSome: (guildConfig) =>
          pipe(
            guildConfig.sheetId,
            Option.match({
              onSome: Effect.succeed,
              onNone: () =>
                Effect.fail(
                  makeArgumentError("Cannot generate room order, the guild has no sheet id"),
                ),
            }),
          ),
        onNone: () =>
          Effect.fail(
            makeArgumentError("Cannot generate room order, the guild might not be registered"),
          ),
      }),
    ),
  );

const requireRunningChannel = Effect.fn("RoomOrderService.requireRunningChannel")(function* (
  guildId: string,
  payload: {
    channelId?: string | undefined;
    channelName?: string | undefined;
  },
  guildConfigService: GuildConfigService,
) {
  const maybeChannel =
    typeof payload.channelId === "string"
      ? yield* guildConfigService.getGuildChannelById({
          guildId,
          channelId: payload.channelId,
          running: true,
        })
      : typeof payload.channelName === "string"
        ? yield* guildConfigService.getGuildChannelByName({
            guildId,
            channelName: payload.channelName,
            running: true,
          })
        : yield* Effect.fail(
            makeArgumentError("Cannot generate room order, channelId or channelName is required"),
          );

  return yield* pipe(
    maybeChannel,
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        Effect.fail(
          makeArgumentError(
            "Cannot generate room order, the running channel might not be registered",
          ),
        ),
    }),
  );
});

const deriveHour = Effect.fn("RoomOrderService.deriveHour")(function* (
  payload: { hour?: number | undefined },
  sheetService: SheetService,
  sheetId: string,
) {
  if (typeof payload.hour === "number") {
    return payload.hour;
  }

  const dateTime = yield* pipe(
    DateTime.now,
    Effect.map(DateTime.addDuration(Duration.minutes(20))),
  );
  const eventConfig = yield* sheetService.getEventConfig(sheetId);
  const distance = DateTime.distanceDurationEither(
    eventConfig.startTime,
    pipe(dateTime, DateTime.startOf("hour")),
  );

  return pipe(
    distance,
    Either.match({
      onRight: Duration.toHours,
      onLeft: (duration) => pipe(duration, Duration.toHours, Number.negate),
    }),
    Math.floor,
    Number.increment,
  );
});

const deriveHourWindow = (sheetService: SheetService, sheetId: string, hour: number) =>
  sheetService.getEventConfig(sheetId).pipe(
    Effect.map((eventConfig) => ({
      start: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour - 1))),
      end: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour))),
    })),
  );

const toTeamWithPlayer = (player: Player, team: Team) =>
  new Team({
    // eslint-disable-next-line @typescript-eslint/no-misused-spread
    ...team,
    playerId: Option.some(player.id),
  });

const buildContent = (
  hour: number,
  start: DateTime.DateTime,
  end: DateTime.DateTime,
  monitor: string | null,
  previousFills: ReadonlyArray<string>,
  fills: ReadonlyArray<string>,
  entries: ReadonlyArray<GeneratedRoomOrderEntry>,
) =>
  [
    `**Hour ${hour}** ${formatDiscordTimestamp(start)} - ${formatDiscordTimestamp(end)}`,
    ...(monitor === null ? [] : [`\`Monitor:\` ${monitor}`]),
    "",
    ...entries.map(({ position, team, tags, effectValue }) => {
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
      return `\`P${position + 1}:\`  ${team}${effectStr}`;
    }),
    "",
    `\`In:\` ${pipe(
      HashSet.fromIterable(fills),
      HashSet.difference(HashSet.fromIterable(previousFills)),
      HashSet.toValues,
      (arr) => (arr.length > 0 ? arr.join(", ") : "(none)"),
    )}`,
    `\`Out:\` ${pipe(
      HashSet.fromIterable(previousFills),
      HashSet.difference(HashSet.fromIterable(fills)),
      HashSet.toValues,
      (arr) => (arr.length > 0 ? arr.join(", ") : "(none)"),
    )}`,
  ].join("\n");

export class RoomOrderService extends Effect.Service<RoomOrderService>()("RoomOrderService", {
  effect: Effect.gen(function* () {
    const calcService = yield* CalcService;
    const guildConfigService = yield* GuildConfigService;
    const scheduleService = yield* ScheduleService;
    const sheetService = yield* SheetService;

    return {
      generate: Effect.fn("RoomOrderService.generate")(function* (payload: {
        guildId: string;
        channelId?: string | undefined;
        channelName?: string | undefined;
        hour?: number | undefined;
        healNeeded?: number | undefined;
      }) {
        const runningChannel = yield* requireRunningChannel(
          payload.guildId,
          payload,
          guildConfigService,
        );
        const sheetId = yield* getSheetIdFromGuildId(payload.guildId, guildConfigService);
        const hour = yield* deriveHour(payload, sheetService, sheetId);
        const healNeeded = payload.healNeeded ?? 0;
        const channelName = pipe(
          runningChannel.name,
          Option.match({
            onSome: (value) => value,
            onNone: () => "",
          }),
        );

        const schedules = yield* scheduleService.getChannelPopulatedSchedules(sheetId, channelName);
        const schedulesByHour = pipe(
          schedules,
          Array.filterMap((schedule) =>
            pipe(
              schedule.hour,
              Option.map((resolvedHour) => ({ hour: resolvedHour, schedule })),
            ),
          ),
          ArrayUtils.Collect.toHashMapByKey("hour"),
          HashMap.map(({ schedule }) => schedule),
        );

        const previousScheduleEntry = HashMap.get(schedulesByHour, hour - 1);
        const currentScheduleEntry = HashMap.get(schedulesByHour, hour);

        const previousFills = pipe(
          previousScheduleEntry,
          Option.map((schedule) =>
            Match.value(schedule).pipe(
              Match.tagsExhaustive({
                PopulatedBreakSchedule: () => [],
                PopulatedSchedule: (populatedSchedule) => populatedSchedule.fills,
              }),
            ),
          ),
          Option.getOrElse(() => []),
          Array.getSomes,
        );

        const fills = pipe(
          currentScheduleEntry,
          Option.map((schedule) =>
            Match.value(schedule).pipe(
              Match.tagsExhaustive({
                PopulatedBreakSchedule: () => [],
                PopulatedSchedule: (populatedSchedule) => populatedSchedule.fills,
              }),
            ),
          ),
          Option.getOrElse(() => []),
          Array.getSomes,
        );

        const previousFillNames = previousFills.map((fill) => fill.player.name);
        const fillNames = fills.map((fill) => fill.player.name);
        const runnerNames = fillNames;
        const monitor = pipe(
          currentScheduleEntry,
          Option.flatMap((schedule) =>
            Match.value(schedule).pipe(
              Match.tagsExhaustive({
                PopulatedBreakSchedule: () => Option.none<string>(),
                PopulatedSchedule: (populatedSchedule) =>
                  pipe(
                    populatedSchedule.monitor,
                    Option.map((resolvedMonitor) => resolvedMonitor.monitor.name),
                  ),
              }),
            ),
          ),
          Option.getOrNull,
        );

        const allTeams = yield* sheetService.getTeams(sheetId);
        const playerTeams = fills.map((fill) =>
          Match.value(fill.player).pipe(
            Match.tagsExhaustive({
              Player: (player) =>
                allTeams
                  .filter((team) => Option.exists(team.playerName, (name) => name === player.name))
                  .map((team) => toTeamWithPlayer(player, team))
                  .map(
                    (team) =>
                      new Team({
                        // eslint-disable-next-line @typescript-eslint/no-misused-spread
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
                  )
                  .flatMap((team) => pipe(PlayerTeam.fromTeam(false, team), Option.toArray)),
              PartialNamePlayer: () => [] as PlayerTeam[],
            }),
          ),
        );

        const rooms = yield* calcService.calc(
          new CalcConfig({ healNeeded, considerEnc: true }),
          playerTeams,
        );
        const roomOrders = Chunk.toArray(rooms);

        if (roomOrders.length === 0) {
          return yield* Effect.fail(
            makeArgumentError("cannot calculate room orders with given teams"),
          );
        }

        const entries = roomOrders.flatMap((room, rank) =>
          Chunk.toArray(room.teams).map(
            (entry, position) =>
              new GeneratedRoomOrderEntry({
                rank,
                position,
                hour,
                team: entry.teamName,
                tags: Array.fromIterable(entry.tags),
                effectValue: PlayerTeam.getEffectValue(entry),
              }),
          ),
        );

        const firstRankEntries = entries.filter((entry) => entry.rank === 0);
        const { start, end } = yield* pipe(
          currentScheduleEntry,
          Option.flatMap((schedule) => schedule.hourWindow),
          Option.map((hourWindow) => Effect.succeed(hourWindow)),
          Option.getOrElse(() => deriveHourWindow(sheetService, sheetId, hour)),
        );

        return new RoomOrderGenerateResult({
          content: buildContent(
            hour,
            start,
            end,
            monitor,
            previousFillNames,
            fillNames,
            firstRankEntries,
          ),
          range: new MessageRoomOrderRange({
            minRank: 0,
            maxRank: roomOrders.length - 1,
          }),
          rank: 0,
          hour,
          monitor,
          previousFills: previousFillNames,
          fills: fillNames,
          entries,
        });
      }),
    };
  }),
  dependencies: [
    CalcService.Default,
    GuildConfigService.Default,
    ScheduleService.Default,
    SheetService.Default,
  ],
  accessors: true,
}) {}
