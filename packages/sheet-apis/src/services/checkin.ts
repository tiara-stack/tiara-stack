import {
  Array,
  DateTime,
  Duration,
  Effect,
  HashMap,
  HashSet,
  Match,
  Number,
  Option,
  Random,
  pipe,
} from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { Array as ArrayUtils } from "typhoon-core/utils";
import { CheckinGenerateResult } from "@/schemas/checkin";
import {
  PopulatedSchedule,
  PopulatedSchedulePlayer,
  type PopulatedScheduleResult,
  PartialNameMonitor,
  Monitor,
} from "@/schemas/sheet";
import { GuildConfigService } from "./guildConfig";
import { ScheduleService } from "./schedule";
import { SheetConfigService } from "./sheetConfig";

type Weighted<A> = { value: A; weight: number };
const SLOTS_PER_ROW = 5;

const checkinMessageTemplates: Array.NonEmptyReadonlyArray<Weighted<string>> = [
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{channelString}} {{hourString}} {{timeStampString}}",
    weight: 0.5,
  },
  {
    value:
      "{{mentionsString}} The goddess Miku is calling for you to fill. Press the button below to check in, and {{channelString}} {{hourString}} {{timeStampString}}",
    weight: 0.25,
  },
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{channelString}} {{hourString}} {{timeStampString}}. ... Beep Boop. Beep Boop. zzzt... zzzt... zzzt...",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{channelString}} {{hourString}} {{timeStampString}}\n~~or VBS Miku will recruit you for some taste testing of her cooking.~~",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Ebi jail AAAAAAAAAAAAAAAAAAAAAAA. Press the button below to check in, and {{channelString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Miku's voice echoes in the empty SEKAI. Press the button below to check in, then {{channelString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} The clock hits 25:00. Miku whispers from the empty SEKAI. Press the button below to check in, then {{channelString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
];

const pickWeighted = <A>(items: Array.NonEmptyReadonlyArray<Weighted<A>>) =>
  pipe(
    Effect.Do,
    Effect.bind("accumItems", () =>
      pipe(
        items,
        Array.scan({ value: Option.none<A>(), weight: 0 }, (s, { value, weight }) => ({
          value: Option.some(value),
          weight: s.weight + weight,
        })),
        Array.filterMap(({ value, weight }) =>
          pipe(
            value,
            Option.map((value) => ({ value, weight })),
          ),
        ),
        Array.match({
          onEmpty: () => Effect.die("pickWeighted: impossible"),
          onNonEmpty: (items) => Effect.succeed(items),
        }),
      ),
    ),
    Effect.bind("random", ({ accumItems }) =>
      Random.nextRange(
        0,
        pipe(accumItems, Array.lastNonEmpty, ({ weight }) => weight),
      ),
    ),
    Effect.flatMap(({ accumItems, random }) =>
      pipe(
        accumItems,
        Array.findFirst(({ weight }) => random < weight),
        Option.match({
          onSome: ({ value }) => Effect.succeed(value),
          onNone: () => Effect.die("pickWeighted: impossible"),
        }),
      ),
    ),
  );

const renderTemplate = (template: string, context: Record<string, string>) =>
  template.replace(/\{\{\{?(\w+)\}?\}\}/g, (match, key: string) => context[key] ?? match);

const formatRelativeDiscordTime = (dateTime: DateTime.DateTime) =>
  `<t:${Math.floor(DateTime.toEpochMillis(dateTime) / 1000)}:R>`;

const formatUserMention = (userId: string) => `<@${userId}>`;

const formatChannelMention = (channelId: string) => `<#${channelId}>`;

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
                  makeArgumentError("Cannot generate check-in, the guild has no sheet id"),
                ),
            }),
          ),
        onNone: () =>
          Effect.fail(
            makeArgumentError("Cannot generate check-in, the guild might not be registered"),
          ),
      }),
    ),
  );

const requireRunningChannel = Effect.fn("CheckinService.requireRunningChannel")(function* (
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
            makeArgumentError("Cannot generate check-in, channelId or channelName is required"),
          );

  return yield* pipe(
    maybeChannel,
    Option.match({
      onSome: Effect.succeed,
      onNone: () =>
        Effect.fail(
          makeArgumentError(
            "Cannot generate check-in, the running channel might not be registered",
          ),
        ),
    }),
  );
});

const deriveHour = Effect.fn("CheckinService.deriveHour")(function* (
  payload: { hour?: number | undefined },
  sheetConfigService: SheetConfigService,
  sheetId: string,
) {
  if (typeof payload.hour === "number") {
    return {
      hour: payload.hour,
      eventConfig:
        Option.none<Effect.Effect.Success<ReturnType<typeof sheetConfigService.getEventConfig>>>(),
    };
  }

  const dateTime = yield* pipe(
    DateTime.now,
    Effect.map(DateTime.addDuration(Duration.minutes(20))),
  );
  const eventConfig = yield* sheetConfigService.getEventConfig(sheetId);
  const distance = DateTime.distanceDurationEither(
    eventConfig.startTime,
    pipe(dateTime, DateTime.startOf("hour")),
  );

  return {
    hour: pipe(
      distance,
      Match.value,
      Match.when({ _tag: "Left" }, ({ left }) => pipe(left, Duration.toHours, Number.negate)),
      Match.when({ _tag: "Right" }, ({ right }) => Duration.toHours(right)),
      Match.exhaustive,
      Math.floor,
      Number.increment,
    ),
    eventConfig: Option.some(eventConfig),
  };
});

const getSchedulePlayers = (
  schedule: Option.Option<PopulatedScheduleResult>,
  toValue: (player: PopulatedSchedulePlayer) => string,
) =>
  pipe(
    schedule,
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
    Array.map(toValue),
  );

const schedulePlayerToMentionOrName = (schedulePlayer: PopulatedSchedulePlayer) =>
  pipe(
    Match.value(schedulePlayer.player),
    Match.tagsExhaustive({
      Player: (player) => formatUserMention(player.id),
      PartialNamePlayer: (player) => player.name,
    }),
  );

const schedulePlayerToUserId = (schedulePlayer: PopulatedSchedulePlayer) =>
  pipe(
    Match.value(schedulePlayer.player),
    Match.tagsExhaustive({
      Player: (player) => Option.some(player.id),
      PartialNamePlayer: () => Option.none<string>(),
    }),
  );

const getFillIds = (schedule: Option.Option<PopulatedScheduleResult>) =>
  pipe(
    schedule,
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
    Array.map(schedulePlayerToUserId),
    Array.getSomes,
    HashSet.fromIterable,
    HashSet.toValues,
  );

const getLookupFailedMessage = (schedule: Option.Option<PopulatedScheduleResult>) =>
  pipe(
    schedule,
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
          Player: () => Option.none<string>(),
          PartialNamePlayer: (player) => Option.some(player.name),
        }),
      ),
    ),
    Array.getSomes,
    Option.liftPredicate(Array.isNonEmptyArray),
    Option.map(
      (partialPlayers) =>
        `Cannot look up Discord ID for ${Array.join(partialPlayers, ", ")}. They would need to check in manually.`,
    ),
  );

const getMonitorInfo = (schedule: Option.Option<PopulatedScheduleResult>) =>
  pipe(
    schedule,
    Option.match({
      onNone: () => ({
        monitorUserId: null as string | null,
        monitorFailureMessage: null as string | null,
      }),
      onSome: (schedule) =>
        pipe(
          Match.value(schedule),
          Match.tagsExhaustive({
            PopulatedBreakSchedule: () => ({
              monitorUserId: null as string | null,
              monitorFailureMessage: null as string | null,
            }),
            PopulatedSchedule: (schedule) =>
              pipe(
                schedule.monitor,
                Option.match({
                  onNone: () => ({
                    monitorUserId: null as string | null,
                    monitorFailureMessage:
                      "Cannot ping monitor: monitor not assigned for this hour.",
                  }),
                  onSome: (populatedMonitor) =>
                    pipe(
                      Match.value(populatedMonitor.monitor),
                      Match.tagsExhaustive({
                        Monitor: (monitorData: Monitor) => ({
                          monitorUserId: monitorData.id,
                          monitorFailureMessage: null as string | null,
                        }),
                        PartialNameMonitor: (monitorData: PartialNameMonitor) => ({
                          monitorUserId: null as string | null,
                          monitorFailureMessage: `Cannot ping monitor: monitor "${monitorData.name}" is missing a Discord ID in the sheet.`,
                        }),
                      }),
                    ),
                }),
              ),
          }),
        ),
    }),
  );

export const makeMonitorCheckinMessage = ({
  initialMessage,
  empty,
  emptySlotMessage,
  playersMessage,
  lookupFailedMessage,
}: {
  initialMessage: string | null;
  empty: number;
  emptySlotMessage: string;
  playersMessage: string;
  lookupFailedMessage: Option.Option<string>;
}) =>
  initialMessage
    ? pipe(
        [
          Option.some("Check-in message sent!"),
          Option.some(emptySlotMessage),
          Option.some(playersMessage),
          lookupFailedMessage,
        ],
        Array.getSomes,
        Array.join("\n"),
      )
    : pipe(
        [
          Option.some("No check-in message sent, no new players to check in"),
          empty > 0 && empty < SLOTS_PER_ROW
            ? Option.some(emptySlotMessage)
            : Option.none<string>(),
        ],
        Array.getSomes,
        Array.join("\n"),
      );

const formatChannelString = (
  roleId: Option.Option<string>,
  channelId: string,
  channelName: Option.Option<string>,
) =>
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
      onNone: () => `head to ${formatChannelMention(channelId)}`,
    }),
  );

export class CheckinService extends Effect.Service<CheckinService>()("CheckinService", {
  effect: Effect.gen(function* () {
    const guildConfigService = yield* GuildConfigService;
    const scheduleService = yield* ScheduleService;
    const sheetConfigService = yield* SheetConfigService;

    return {
      generate: Effect.fn("CheckinService.generate")(function* (payload: {
        guildId: string;
        channelId?: string | undefined;
        channelName?: string | undefined;
        hour?: number | undefined;
        template?: string | undefined;
      }) {
        const runningChannel = yield* requireRunningChannel(
          payload.guildId,
          payload,
          guildConfigService,
        );
        const sheetId = yield* getSheetIdFromGuildId(payload.guildId, guildConfigService);
        const { hour, eventConfig } = yield* deriveHour(payload, sheetConfigService, sheetId);
        const channelName = pipe(
          runningChannel.name,
          Option.getOrElse(() => ""),
        );

        const schedules = yield* scheduleService.getChannelPopulatedSchedules(sheetId, channelName);

        const schedulesByHour = pipe(
          schedules,
          Array.filterMap((schedule) =>
            pipe(
              schedule.hour,
              Option.map((hour) => ({ hour, schedule })),
            ),
          ),
          ArrayUtils.Collect.toHashMapByKey("hour"),
          HashMap.map(({ schedule }) => schedule),
        );

        const prevSchedule = HashMap.get(schedulesByHour, hour - 1);
        const schedule = HashMap.get(schedulesByHour, hour);
        const prevFills = getSchedulePlayers(prevSchedule, schedulePlayerToMentionOrName);
        const fills = getSchedulePlayers(schedule, schedulePlayerToMentionOrName);
        const fillIds = getFillIds(schedule);
        const mentionsString = pipe(
          HashSet.fromIterable(fills),
          HashSet.difference(HashSet.fromIterable(prevFills)),
          HashSet.toValues,
          Option.some,
          Option.filter(Array.isNonEmptyArray),
          Option.map(Array.join(" ")),
        );

        const hourString = `for **hour ${hour}**`;
        const scheduleHourWindow = pipe(
          schedule,
          Option.flatMap((currentSchedule) => currentSchedule.hourWindow),
        );
        const timeStampString = Option.isSome(scheduleHourWindow)
          ? formatRelativeDiscordTime(scheduleHourWindow.value.start)
          : yield* pipe(
              eventConfig,
              Option.match({
                onSome: Effect.succeed,
                onNone: () => sheetConfigService.getEventConfig(sheetId),
              }),
              Effect.map((eventConfig) =>
                pipe(
                  eventConfig.startTime,
                  DateTime.addDuration(Duration.hours(hour - 1)),
                  formatRelativeDiscordTime,
                ),
              ),
              Effect.catchAll(() => Effect.succeed("")),
            );

        const channelString = formatChannelString(
          runningChannel.roleId,
          runningChannel.channelId,
          runningChannel.name,
        );

        const template = yield* pipe(
          payload.template,
          Option.fromNullable,
          Option.match({
            onSome: Effect.succeed,
            onNone: () => pickWeighted(checkinMessageTemplates),
          }),
        );

        const initialMessage = pipe(
          mentionsString,
          Option.map((mentionsString) =>
            renderTemplate(template, {
              mentionsString,
              channelString,
              hourString,
              timeStampString,
            }),
          ),
          Option.getOrNull,
        );

        const empty = pipe(
          schedule,
          Option.map((schedule) =>
            pipe(
              Match.value(schedule),
              Match.tagsExhaustive({
                PopulatedBreakSchedule: () => SLOTS_PER_ROW,
                PopulatedSchedule: (schedule) => PopulatedSchedule.empty(schedule),
              }),
            ),
          ),
          Option.getOrElse(() => SLOTS_PER_ROW),
        );

        const emptySlotMessage = `${empty > 0 ? `+${empty}` : "No"} empty slot${empty > 1 ? "s" : ""}`;
        const playersMessage = `Players: ${Array.join(fills, " ")}`;
        const lookupFailedMessage = getLookupFailedMessage(schedule);
        const monitorInfo = getMonitorInfo(schedule);

        const monitorCheckinMessage = makeMonitorCheckinMessage({
          initialMessage,
          empty,
          emptySlotMessage,
          playersMessage,
          lookupFailedMessage,
        });

        return new CheckinGenerateResult({
          hour,
          runningChannelId: runningChannel.channelId,
          checkinChannelId: Option.getOrElse(
            runningChannel.checkinChannelId,
            () => runningChannel.channelId,
          ),
          roleId: Option.getOrNull(runningChannel.roleId),
          initialMessage,
          monitorCheckinMessage,
          monitorUserId: monitorInfo.monitorUserId,
          monitorFailureMessage: monitorInfo.monitorFailureMessage,
          fillIds,
        });
      }),
    };
  }),
  dependencies: [GuildConfigService.Default, ScheduleService.Default, SheetConfigService.Default],
  accessors: true,
}) {}
