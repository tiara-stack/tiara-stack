import { Array, Effect, HashMap, Layer, Match, Option, Predicate, Context, pipe } from "effect";
import { SheetService } from "./sheet";
import { PlayerService } from "./player";
import { MonitorService } from "./monitor";
import { SheetConfigService } from "./sheetConfig";
import { withScheduleHourWindow } from "./hourWindow";
import {
  BreakSchedule,
  Schedule,
  PopulatedBreakSchedule,
  PopulatedSchedulePlayer,
  PopulatedScheduleMonitor,
  PopulatedSchedule,
  type PopulatedScheduleResult,
  Player,
  type PlayerDayScheduleSummary,
  PartialNamePlayer,
  Monitor,
  PartialNameMonitor,
} from "sheet-ingress-api/schemas/sheet";
import { upperFirst } from "scule";

type SheetConfigServiceApi = Context.Service.Shape<typeof SheetConfigService>;
type EventConfig = Effect.Success<ReturnType<SheetConfigServiceApi["getEventConfig"]>>;

const isPlayer = Predicate.isTagged("Player");
const isPopulatedSchedule = Predicate.isTagged("PopulatedSchedule");

const populateSchedule = (
  schedule: Schedule,
  playerMap: Map<string, [Player | PartialNamePlayer, ...(Player | PartialNamePlayer)[]]>,
  monitorMap: Map<string, [Monitor | PartialNameMonitor, ...(Monitor | PartialNameMonitor)[]]>,
): PopulatedSchedule => {
  const resolvePlayers = (name: string) =>
    playerMap.get(upperFirst(name)) ?? [new PartialNamePlayer({ name: upperFirst(name) })];

  const fills = Array.makeBy(5, (index) =>
    pipe(
      schedule.fills[index] ?? Option.none(),
      Option.flatMap((rawPlayer) =>
        Option.some(
          new PopulatedSchedulePlayer({
            player: resolvePlayers(rawPlayer.player)[0],
            enc: rawPlayer.enc,
          }),
        ),
      ),
    ),
  );

  const overfills = schedule.overfills.map(
    (rawPlayer) =>
      new PopulatedSchedulePlayer({
        player: resolvePlayers(rawPlayer.player)[0],
        enc: rawPlayer.enc,
      }),
  );

  const standbys = schedule.standbys.map(
    (rawPlayer) =>
      new PopulatedSchedulePlayer({
        player: resolvePlayers(rawPlayer.player)[0],
        enc: rawPlayer.enc,
      }),
  );

  const runners = schedule.runners.map(
    (rawPlayer) =>
      new PopulatedSchedulePlayer({
        player: resolvePlayers(rawPlayer.player)[0],
        enc: rawPlayer.enc,
      }),
  );

  const monitor = pipe(
    schedule.monitor,
    Option.map((name) => {
      const resolvedName = String(name);
      const monitors = monitorMap.get(upperFirst(resolvedName)) ?? [
        new PartialNameMonitor({ name: upperFirst(resolvedName) }),
      ];
      return new PopulatedScheduleMonitor({
        monitor: monitors[0],
      });
    }),
  );

  return new PopulatedSchedule({
    channel: schedule.channel,
    day: schedule.day,
    visible: schedule.visible,
    hour: schedule.hour,
    hourWindow: schedule.hourWindow,
    fills,
    overfills,
    standbys,
    runners,
    monitor,
  });
};

const buildResolutionMaps = (
  playerMaps: {
    nameToPlayer: HashMap.HashMap<string, { name: string; players: [Player, ...Player[]] }>;
  },
  monitorMaps: {
    nameToMonitor: HashMap.HashMap<string, { name: string; monitors: ReadonlyArray<Monitor> }>;
  },
) => {
  const playerMap = new Map<
    string,
    [Player | PartialNamePlayer, ...(Player | PartialNamePlayer)[]]
  >();
  for (const [name, entry] of HashMap.toEntries(playerMaps.nameToPlayer)) {
    playerMap.set(
      name,
      entry.players as [Player | PartialNamePlayer, ...(Player | PartialNamePlayer)[]],
    );
  }

  const monitorMap = new Map<
    string,
    [Monitor | PartialNameMonitor, ...(Monitor | PartialNameMonitor)[]]
  >();
  for (const [name, entry] of HashMap.toEntries(monitorMaps.nameToMonitor)) {
    if (entry.monitors.length > 0) {
      monitorMap.set(
        name,
        entry.monitors as [Monitor | PartialNameMonitor, ...(Monitor | PartialNameMonitor)[]],
      );
    }
  }

  return { playerMap, monitorMap };
};

const populateScheduleResult = (
  schedule: BreakSchedule | Schedule,
  playerMap: Map<string, [Player | PartialNamePlayer, ...(Player | PartialNamePlayer)[]]>,
  monitorMap: Map<string, [Monitor | PartialNameMonitor, ...(Monitor | PartialNameMonitor)[]]>,
): PopulatedScheduleResult =>
  Match.value(schedule).pipe(
    Match.tagsExhaustive({
      BreakSchedule: (schedule) =>
        new PopulatedBreakSchedule({
          channel: schedule.channel,
          day: schedule.day,
          visible: schedule.visible,
          hour: schedule.hour,
          hourWindow: schedule.hourWindow,
        }),
      Schedule: (schedule) => populateSchedule(schedule, playerMap, monitorMap),
    }),
  );

const toPopulatedSchedules = (
  schedules: ReadonlyArray<BreakSchedule | Schedule>,
  startTime: EventConfig["startTime"],
  playerMaps: {
    nameToPlayer: HashMap.HashMap<string, { name: string; players: [Player, ...Player[]] }>;
  },
  monitorMaps: {
    nameToMonitor: HashMap.HashMap<string, { name: string; monitors: ReadonlyArray<Monitor> }>;
  },
): ReadonlyArray<PopulatedScheduleResult> => {
  const { playerMap, monitorMap } = buildResolutionMaps(playerMaps, monitorMaps);
  return schedules.map((schedule) =>
    populateScheduleResult(withScheduleHourWindow(startTime, schedule), playerMap, monitorMap),
  );
};

const schedulePlayerMatchesUser = (
  schedulePlayer: PopulatedSchedulePlayer,
  accountId: string,
): boolean => (isPlayer(schedulePlayer.player) ? schedulePlayer.player.id === accountId : false);

const sortHours = (hours: ReadonlyArray<number>): number[] =>
  [...hours]
    .sort((a, b) => a - b)
    .filter((hour, index, sorted) => index === 0 || hour !== sorted[index - 1]);

export const summarizeDayPlayerSchedule = (
  schedules: ReadonlyArray<PopulatedScheduleResult>,
  accountId: string,
): PlayerDayScheduleSummary => {
  let invisible = false;
  const fillHours: number[] = [];
  const overfillHours: number[] = [];
  const standbyHours: number[] = [];

  for (const schedule of schedules) {
    if (!isPopulatedSchedule(schedule)) {
      continue;
    }

    if (!schedule.visible) {
      invisible = true;
    }

    if (Option.isNone(schedule.hour)) {
      continue;
    }

    const hour = schedule.hour.value;
    if (
      schedule.fills.some(
        (fill) => Option.isSome(fill) && schedulePlayerMatchesUser(fill.value, accountId),
      )
    ) {
      fillHours.push(hour);
    }
    if (schedule.overfills.some((overfill) => schedulePlayerMatchesUser(overfill, accountId))) {
      overfillHours.push(hour);
    }
    if (schedule.standbys.some((standby) => schedulePlayerMatchesUser(standby, accountId))) {
      standbyHours.push(hour);
    }
  }

  return {
    fillHours: sortHours(fillHours),
    overfillHours: sortHours(overfillHours),
    standbyHours: sortHours(standbyHours),
    invisible,
  };
};

export class ScheduleService extends Context.Service<ScheduleService>()("ScheduleService", {
  make: Effect.gen(function* () {
    const sheetService = yield* SheetService;
    const playerService = yield* PlayerService;
    const monitorService = yield* MonitorService;
    const sheetConfigService = yield* SheetConfigService;

    const toPopulated = Effect.fn("ScheduleService.toPopulated")(function* (
      schedules: ReadonlyArray<BreakSchedule | Schedule>,
      sheetId: string,
    ) {
      const playerMaps = yield* playerService.getPlayerMaps(sheetId);
      const monitorMaps = yield* monitorService.getMonitorMaps(sheetId);
      const eventConfig = yield* sheetConfigService.getEventConfig(sheetId);
      return toPopulatedSchedules(schedules, eventConfig.startTime, playerMaps, monitorMaps);
    });

    return {
      getAllPopulatedSchedules: Effect.fn("ScheduleService.getAllPopulatedSchedules")(function* (
        sheetId: string,
      ) {
        const schedules = yield* sheetService.getAllSchedules(sheetId);
        return yield* toPopulated(schedules, sheetId).pipe(
          Effect.withSpan("ScheduleService.getAllPopulatedSchedules"),
        );
      }),
      getDayPopulatedSchedules: Effect.fn("ScheduleService.getDayPopulatedSchedules")(function* (
        sheetId: string,
        day: number,
      ) {
        const schedules = yield* sheetService.getDaySchedules(sheetId, day);
        return yield* toPopulated(schedules, sheetId).pipe(
          Effect.withSpan("ScheduleService.getDayPopulatedSchedules"),
        );
      }),
      getChannelPopulatedSchedules: Effect.fn("ScheduleService.getChannelPopulatedSchedules")(
        function* (sheetId: string, channel: string) {
          const schedules = yield* sheetService.getChannelSchedules(sheetId, channel);
          return yield* toPopulated(schedules, sheetId).pipe(
            Effect.withSpan("ScheduleService.getChannelPopulatedSchedules"),
          );
        },
      ),
      getAllPopulatedFillerSchedules: Effect.fn("ScheduleService.getAllPopulatedFillerSchedules")(
        function* (sheetId: string) {
          const schedules = yield* sheetService.getAllFillerSchedules(sheetId);
          return yield* toPopulated(schedules, sheetId).pipe(
            Effect.withSpan("ScheduleService.getAllPopulatedFillerSchedules"),
          );
        },
      ),
      getDayPopulatedFillerSchedules: Effect.fn("ScheduleService.getDayPopulatedFillerSchedules")(
        function* (sheetId: string, day: number) {
          const schedules = yield* sheetService.getDayFillerSchedules(sheetId, day);
          return yield* toPopulated(schedules, sheetId).pipe(
            Effect.withSpan("ScheduleService.getDayPopulatedFillerSchedules"),
          );
        },
      ),
      getChannelPopulatedFillerSchedules: Effect.fn(
        "ScheduleService.getChannelPopulatedFillerSchedules",
      )(function* (sheetId: string, channel: string) {
        const schedules = yield* sheetService.getChannelFillerSchedules(sheetId, channel);
        return yield* toPopulated(schedules, sheetId).pipe(
          Effect.withSpan("ScheduleService.getChannelPopulatedFillerSchedules"),
        );
      }),
    };
  }),
}) {
  static layer = Layer.effect(ScheduleService, this.make).pipe(
    Layer.provide(SheetService.layer),
    Layer.provide(PlayerService.layer),
    Layer.provide(MonitorService.layer),
    Layer.provide(SheetConfigService.layer),
  );
}
