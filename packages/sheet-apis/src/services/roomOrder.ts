import { Chunk, DateTime, Duration, Effect, Layer, Option, Predicate, Context, pipe } from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { GuildConfigService } from "./guildConfig";
import { ScheduleService } from "./schedule";
import { CalcConfig, CalcService } from "./calc";
import { SheetService } from "./sheet";
import {
  type FillParticipant,
  diffFillParticipants,
  getScheduleFills,
  toFillParticipant,
} from "./fillMovement";
import {
  GeneratedRoomOrderEntry,
  RoomOrderGenerateResult,
} from "sheet-ingress-api/schemas/roomOrder";
import { MessageRoomOrderRange } from "sheet-ingress-api/schemas/messageRoomOrder";
import {
  Player,
  PlayerTeam,
  Team,
  type PopulatedSchedulePlayer,
  type PopulatedScheduleResult,
} from "sheet-ingress-api/schemas/sheet";

type GuildConfigServiceApi = Context.Service.Shape<typeof GuildConfigService>;
type SheetServiceApi = Context.Service.Shape<typeof SheetService>;

const isPlayer = (player: PopulatedSchedulePlayer["player"]): player is Player =>
  Predicate.isTagged("Player")(player);
const isPopulatedSchedule = Predicate.isTagged("PopulatedSchedule");

const formatEffectValue = (effectValue: number): string => {
  const rounded = Math.round(effectValue * 10) / 10;
  const formatted = rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(1);
  return `+${formatted}%`;
};

const formatDiscordTimestamp = (dateTime: DateTime.DateTime): string =>
  `<t:${Math.floor(DateTime.toEpochMillis(dateTime) / 1000)}:f>`;

const getSheetIdFromGuildId = (guildId: string, guildConfigService: GuildConfigServiceApi) =>
  guildConfigService.getGuildConfig(guildId).pipe(
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
  payload: { channelId?: string | undefined; channelName?: string | undefined },
  guildConfigService: GuildConfigServiceApi,
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
  sheetService: SheetServiceApi,
  sheetId: string,
) {
  if (typeof payload.hour === "number") {
    return payload.hour;
  }

  const dateTime = yield* DateTime.now.pipe(Effect.map(DateTime.addDuration(Duration.minutes(20))));
  const eventConfig = yield* sheetService.getEventConfig(sheetId);
  const distance = DateTime.distance(
    eventConfig.startTime,
    pipe(dateTime, DateTime.startOf("hour")),
  );
  return Math.floor(Duration.toHours(distance)) + 1;
});

const deriveHourWindow = (sheetService: SheetServiceApi, sheetId: string, hour: number) =>
  sheetService.getEventConfig(sheetId).pipe(
    Effect.map((eventConfig) => ({
      start: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour - 1))),
      end: pipe(eventConfig.startTime, DateTime.addDuration(Duration.hours(hour))),
    })),
  );

const toTeamWithPlayer = (player: Player, team: Team) =>
  new Team({
    ...team,
    playerId: Option.some(player.id),
  });

export type RoomOrderContentEntry = {
  readonly position: number;
  readonly team: string;
  readonly tags: ReadonlyArray<string>;
  readonly effectValue: number;
};

export const buildRoomOrderContent = (
  hour: number,
  start: DateTime.DateTime,
  end: DateTime.DateTime,
  monitor: string | null,
  previousParticipants: ReadonlyArray<FillParticipant>,
  participants: ReadonlyArray<FillParticipant>,
  entries: ReadonlyArray<RoomOrderContentEntry>,
) => {
  const fillMovement = diffFillParticipants(previousParticipants, participants);

  return [
    `**Hour ${hour}** ${formatDiscordTimestamp(start)} - ${formatDiscordTimestamp(end)}`,
    ...(monitor === null ? [] : [`\`Monitor:\` ${monitor}`]),
    "",
    ...entries.map(({ position, team, tags, effectValue }) => {
      const hasTiererTag = tags.includes("tierer");
      const effectParts = hasTiererTag
        ? []
        : [
            formatEffectValue(effectValue),
            ...(tags.includes("enc") ? ["enc"] : []),
            ...(tags.includes("not_enc") ? ["not enc"] : []),
          ];

      const effectStr = effectParts.length > 0 ? ` (${effectParts.join(", ")})` : "";
      return `\`P${position + 1}:\`  ${team}${effectStr}`;
    }),
    "",
    `\`In:\` ${fillMovement.in.length > 0 ? fillMovement.in.map(({ name }) => name).join(", ") : "(none)"}`,
    `\`Out:\` ${fillMovement.out.length > 0 ? fillMovement.out.map(({ name }) => name).join(", ") : "(none)"}`,
  ].join("\n");
};

export class RoomOrderService extends Context.Service<RoomOrderService>()("RoomOrderService", {
  make: Effect.gen(function* () {
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
        const channelName = Option.getOrElse(runningChannel.name, () => "");

        const schedules = yield* scheduleService.getChannelPopulatedSchedules(sheetId, channelName);
        const schedulesByHour = new Map<number, PopulatedScheduleResult>();
        for (const schedule of schedules) {
          if (Option.isSome(schedule.hour)) {
            schedulesByHour.set(schedule.hour.value, schedule);
          }
        }

        const previousSchedule = schedulesByHour.get(hour - 1);
        const currentSchedule = schedulesByHour.get(hour);

        const previousFills = getScheduleFills(previousSchedule);
        const fills = getScheduleFills(currentSchedule);

        const previousFillNames = previousFills.map((fill) => fill.player.name);
        const fillNames = fills.map((fill) => fill.player.name);
        const runnerNames = fillNames;
        const monitor =
          currentSchedule &&
          isPopulatedSchedule(currentSchedule) &&
          Option.isSome(currentSchedule.monitor)
            ? currentSchedule.monitor.value.monitor.name
            : null;

        const allTeams = yield* sheetService.getTeams(sheetId);
        const playerTeams = fills.map((fill) => {
          if (!isPlayer(fill.player)) {
            return [] as PlayerTeam[];
          }
          const player = fill.player;

          return allTeams
            .filter((team) => Option.exists(team.playerName, (name) => name === player.name))
            .map((team) => toTeamWithPlayer(player, team))
            .map(
              (team) =>
                new Team({
                  ...team,
                  tags: pipe(
                    team.tags,
                    (tags) =>
                      tags.includes("tierer_hint") && runnerNames.includes(player.name)
                        ? [...tags, "tierer"]
                        : [...tags],
                    (tags) => (fill.enc ? [...tags, "encable"] : tags),
                  ),
                }),
            )
            .flatMap((team) => Option.toArray(PlayerTeam.fromTeam(false, team)));
        });

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

        const entries = roomOrders.flatMap((room: any, rank) =>
          Chunk.toArray(room.teams).map(
            (entry: any, position) =>
              new GeneratedRoomOrderEntry({
                rank,
                position,
                hour,
                team: entry.teamName,
                tags: Array.from(entry.tags),
                effectValue: PlayerTeam.getEffectValue(entry),
              }),
          ),
        );

        const firstRankEntries = entries.filter((entry) => entry.rank === 0);
        const { start, end } =
          currentSchedule && Option.isSome(currentSchedule.hourWindow)
            ? currentSchedule.hourWindow.value
            : yield* deriveHourWindow(sheetService, sheetId, hour);

        return new RoomOrderGenerateResult({
          content: buildRoomOrderContent(
            hour,
            start,
            end,
            monitor,
            previousFills.map(toFillParticipant),
            fills.map(toFillParticipant),
            firstRankEntries,
          ),
          runningChannelId: runningChannel.channelId,
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
}) {
  static layer = Layer.effect(RoomOrderService, this.make).pipe(
    Layer.provide(CalcService.layer),
    Layer.provide(GuildConfigService.layer),
    Layer.provide(ScheduleService.layer),
    Layer.provide(SheetService.layer),
  );
}
