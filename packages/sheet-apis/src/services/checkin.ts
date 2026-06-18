import {
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Random,
  Context,
  pipe,
} from "effect";
import { makeArgumentError } from "typhoon-core/error";
import { CheckinGenerateResult } from "sheet-ingress-api/schemas/checkin";
import {
  PopulatedScheduleMonitor,
  PopulatedSchedule,
  PopulatedSchedulePlayer,
  type PopulatedScheduleResult,
} from "sheet-ingress-api/schemas/sheet";
import type { ScheduleConfig } from "sheet-ingress-api/schemas/sheetConfig";
import { GuildConfigService } from "./guildConfig";
import { ScheduleService } from "./schedule";
import { SheetConfigService } from "./sheetConfig";
import { diffFillParticipants, getScheduleFills, toFillParticipant } from "./fillMovement";

type GuildConfigServiceApi = Context.Service.Shape<typeof GuildConfigService>;
type SheetConfigServiceApi = Context.Service.Shape<typeof SheetConfigService>;
type EventConfig = Effect.Success<ReturnType<SheetConfigServiceApi["getEventConfig"]>>;

type Weighted<A> = { value: A; weight: number };
const SLOTS_PER_ROW = 5;

const isPopulatedSchedule = Predicate.isTagged("PopulatedSchedule");

const isPlayer = Predicate.isTagged("Player");

const isMonitor = Predicate.isTagged("Monitor");

const checkinMessageTemplates: [Weighted<string>, ...Weighted<string>[]] = [
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

const pickWeighted = Effect.fn("CheckinService.pickWeighted")(function* <A>(
  items: readonly Weighted<A>[],
) {
  const totalWeight = items.reduce((total, item) => total + item.weight, 0);
  const random = yield* Random.nextBetween(0, totalWeight);
  let accumulatedWeight = 0;

  for (const item of items) {
    accumulatedWeight += item.weight;
    if (random < accumulatedWeight) {
      return item.value;
    }
  }

  return items[items.length - 1]!.value;
});

const renderTemplate = (template: string, context: Record<string, string>) =>
  template.replace(/\{\{\{?(\w+)\}?\}\}/g, (match, key: string) => context[key] ?? match);

const formatRelativeDiscordTime = (dateTime: DateTime.DateTime) =>
  `<t:${Math.floor(DateTime.toEpochMillis(dateTime) / 1000)}:R>`;

const formatChannelMention = (channelId: string) => `<#${channelId}>`;

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

const isCompleteScheduleConfig = (config: ScheduleConfig): boolean => {
  const requiredValues: ReadonlyArray<Option.Option<unknown>> = [
    config.channel,
    config.day,
    config.sheet,
    config.hourRange,
    config.breakRange,
    config.encType,
    config.fillRange,
    config.overfillRange,
    config.standbyRange,
    config.visibleCell,
  ];

  return requiredValues.every((value) => Option.isSome(value));
};

export const hasCompleteScheduleConfigForChannel = (
  scheduleConfigs: ReadonlyArray<ScheduleConfig>,
  channelName: string,
): boolean => {
  const normalizedChannelName = channelName.trim();

  return scheduleConfigs.some(
    (config) =>
      Option.exists(
        config.channel,
        (configuredChannel) => configuredChannel === normalizedChannelName,
      ) && isCompleteScheduleConfig(config),
  );
};

const requireScheduleConfigForChannel = Effect.fn("CheckinService.requireScheduleConfigForChannel")(
  function* (sheetId: string, channelName: string, sheetConfigService: SheetConfigServiceApi) {
    const scheduleConfigs = yield* sheetConfigService.getScheduleConfig(sheetId);
    const matchingConfigs = scheduleConfigs.filter((config) =>
      Option.exists(config.channel, (configuredChannel) => configuredChannel === channelName),
    );

    if (matchingConfigs.length === 0) {
      return yield* Effect.fail(
        makeArgumentError(
          `Cannot generate check-in for channel "${channelName}", no schedule config is defined for that channel in the sheet.`,
        ),
      );
    }

    if (!hasCompleteScheduleConfigForChannel(matchingConfigs, channelName)) {
      return yield* Effect.fail(
        makeArgumentError(
          `Cannot generate check-in for channel "${channelName}", the sheet schedule config for that channel is incomplete.`,
        ),
      );
    }
  },
);

const deriveHour = Effect.fn("CheckinService.deriveHour")(function* (
  payload: { hour?: number | undefined },
  sheetConfigService: SheetConfigServiceApi,
  sheetId: string,
) {
  if (typeof payload.hour === "number") {
    return {
      hour: payload.hour,
      eventConfig: Option.none<EventConfig>(),
    };
  }

  const dateTime = yield* DateTime.now.pipe(Effect.map(DateTime.addDuration(Duration.minutes(20))));
  const eventConfig = yield* sheetConfigService.getEventConfig(sheetId);
  const distance = DateTime.distance(
    eventConfig.startTime,
    pipe(dateTime, DateTime.startOf("hour")),
  );

  return {
    hour: Math.floor(Duration.toHours(distance)) + 1,
    eventConfig: Option.some(eventConfig),
  };
});

const schedulePlayerToUserId = (schedulePlayer: PopulatedSchedulePlayer) =>
  isPlayer(schedulePlayer.player) ? Option.some(schedulePlayer.player.id) : Option.none<string>();

const getFillIds = (schedule: Option.Option<PopulatedScheduleResult>) => [
  ...new Set(
    getScheduleFills(Option.getOrNull(schedule))
      .map((player) => Option.getOrElse(schedulePlayerToUserId(player), () => ""))
      .filter(Boolean),
  ),
];

export const getScheduleFillCount = (schedule: Option.Option<PopulatedScheduleResult>): number =>
  getScheduleFills(Option.getOrNull(schedule)).length;

const getLookupFailedMessage = (schedule: Option.Option<PopulatedScheduleResult>) => {
  if (Option.isNone(schedule) || !isPopulatedSchedule(schedule.value)) {
    return Option.none<string>();
  }

  const partialPlayers = schedule.value.fills.flatMap((fill) => {
    if (Option.isNone(fill)) return [];
    return isPlayer(fill.value.player) ? [] : [fill.value.player.name];
  });

  return partialPlayers.length > 0
    ? Option.some(
        `Cannot look up Discord ID for ${partialPlayers.join(", ")}. They would need to check in manually.`,
      )
    : Option.none();
};

const getMonitorInfo = (schedule: Option.Option<PopulatedScheduleResult>) => {
  if (Option.isNone(schedule) || schedule.value._tag === "PopulatedBreakSchedule") {
    return {
      monitorUserId: null as string | null,
      monitorFailureMessage: null as string | null,
    };
  }

  const populatedSchedule = schedule.value;
  if (Option.isNone(populatedSchedule.monitor)) {
    return {
      monitorUserId: null as string | null,
      monitorFailureMessage: "Cannot ping monitor: monitor not assigned for this hour.",
    };
  }

  const populatedMonitor: PopulatedScheduleMonitor = populatedSchedule.monitor.value;
  return isMonitor(populatedMonitor.monitor)
    ? {
        monitorUserId: populatedMonitor.monitor.id,
        monitorFailureMessage: null as string | null,
      }
    : {
        monitorUserId: null as string | null,
        monitorFailureMessage: `Cannot ping monitor: monitor "${populatedMonitor.monitor.name}" is missing a Discord ID in the sheet.`,
      };
};

export const makeMonitorCheckinMessage = ({
  initialMessage,
  empty,
  emptySlotMessage,
  playerChangesMessage,
  lookupFailedMessage,
}: {
  initialMessage: string | null;
  empty: number;
  emptySlotMessage: string;
  playerChangesMessage: string;
  lookupFailedMessage: Option.Option<string>;
}) =>
  initialMessage
    ? [
        "Check-in message sent!",
        emptySlotMessage,
        playerChangesMessage,
        ...Option.toArray(lookupFailedMessage),
      ].join("\n")
    : [
        "No check-in message sent, no new players to check in",
        ...(empty > 0 && empty < SLOTS_PER_ROW ? [emptySlotMessage] : []),
      ].join("\n");

const formatChannelString = (
  roleId: Option.Option<string>,
  channelId: string,
  channelName: Option.Option<string>,
) =>
  Option.isSome(roleId)
    ? pipe(
        channelName,
        Option.map((name) => `head to ${name}`),
        Option.getOrElse(
          () => "await further instructions from the monitor on where the running channel is",
        ),
      )
    : `head to ${formatChannelMention(channelId)}`;

const renderParticipantGroup = (
  label: "Out" | "Stay" | "In",
  participants: ReadonlyArray<{ label: string }>,
) =>
  `${label}: ${participants.length > 0 ? participants.map(({ label }) => label).join(" ") : "None"}`;

export class CheckinService extends Context.Service<CheckinService>()("CheckinService", {
  make: Effect.gen(function* () {
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
        const channelName = Option.getOrElse(runningChannel.name, () => "").trim();
        if (channelName.length === 0) {
          return yield* Effect.fail(
            makeArgumentError(
              "Cannot generate check-in, the running channel has no sheet channel name configured",
            ),
          );
        }
        yield* requireScheduleConfigForChannel(sheetId, channelName, sheetConfigService);
        const schedules = yield* scheduleService.getChannelPopulatedSchedules(sheetId, channelName);

        const schedulesByHour = new Map<number, PopulatedScheduleResult>();
        for (const schedule of schedules) {
          if (Option.isSome(schedule.hour)) {
            schedulesByHour.set(schedule.hour.value, schedule);
          }
        }

        const prevSchedule = schedulesByHour.has(hour - 1)
          ? Option.some(schedulesByHour.get(hour - 1)!)
          : Option.none<PopulatedScheduleResult>();
        const schedule = schedulesByHour.has(hour)
          ? Option.some(schedulesByHour.get(hour)!)
          : Option.none<PopulatedScheduleResult>();

        const prevParticipants = getScheduleFills(Option.getOrNull(prevSchedule)).map(
          toFillParticipant,
        );
        const participants = getScheduleFills(Option.getOrNull(schedule)).map(toFillParticipant);
        const fillCount = getScheduleFillCount(schedule);
        const fillMovement = diffFillParticipants(prevParticipants, participants);
        const fillIds = getFillIds(schedule) as readonly string[];
        const mentions = fillMovement.in.map(({ label }) => label);
        const mentionsString =
          mentions.length > 0 ? Option.some(mentions.join(" ")) : Option.none<string>();

        const hourString = `for **hour ${hour}**`;
        const scheduleHourWindow = pipe(
          schedule,
          Option.flatMap((currentSchedule) => currentSchedule.hourWindow as Option.Option<any>),
        );
        const timeStampString = Option.isSome(scheduleHourWindow)
          ? formatRelativeDiscordTime(scheduleHourWindow.value.start)
          : yield* pipe(
              eventConfig,
              Option.match({
                onSome: Effect.succeed,
                onNone: () => sheetConfigService.getEventConfig(sheetId),
              }),
              Effect.map((resolvedEventConfig) =>
                formatRelativeDiscordTime(
                  pipe(
                    resolvedEventConfig.startTime,
                    DateTime.addDuration(Duration.hours(hour - 1)),
                  ),
                ),
              ),
              Effect.catch(() => Effect.succeed("")),
            );

        const channelString = formatChannelString(
          runningChannel.roleId,
          runningChannel.channelId,
          runningChannel.name,
        );

        const template = yield* pipe(
          payload.template,
          Option.fromNullishOr,
          Option.match({
            onSome: Effect.succeed,
            onNone: () => pickWeighted(checkinMessageTemplates),
          }),
        );

        const initialMessage = pipe(
          mentionsString,
          Option.map((resolvedMentionsString) =>
            renderTemplate(template, {
              mentionsString: resolvedMentionsString,
              channelString,
              hourString,
              timeStampString,
            }),
          ),
          Option.getOrNull,
        );

        const empty =
          Option.isSome(schedule) && isPopulatedSchedule(schedule.value)
            ? PopulatedSchedule.empty(schedule.value)
            : SLOTS_PER_ROW;
        const emptySlotMessage = `${empty > 0 ? `+${empty}` : "No"} empty slot${empty > 1 ? "s" : ""}`;
        const playerChangesMessage = [
          renderParticipantGroup("Out", fillMovement.out),
          renderParticipantGroup("Stay", fillMovement.stay),
          renderParticipantGroup("In", fillMovement.in),
        ].join("\n");
        const lookupFailedMessage = getLookupFailedMessage(schedule);
        const monitorInfo = getMonitorInfo(schedule);

        return new CheckinGenerateResult({
          hour,
          runningChannelId: runningChannel.channelId,
          checkinChannelId: Option.getOrElse(
            runningChannel.checkinChannelId,
            () => runningChannel.channelId,
          ),
          fillCount,
          roleId: Option.getOrNull(runningChannel.roleId),
          initialMessage,
          monitorCheckinMessage: makeMonitorCheckinMessage({
            initialMessage,
            empty,
            emptySlotMessage,
            playerChangesMessage,
            lookupFailedMessage,
          }),
          monitorUserId: monitorInfo.monitorUserId,
          monitorFailureMessage: monitorInfo.monitorFailureMessage,
          fillIds,
        });
      }),
    };
  }),
}) {
  static layer = Layer.effect(CheckinService, this.make).pipe(
    Layer.provide(GuildConfigService.layer),
    Layer.provide(ScheduleService.layer),
    Layer.provide(SheetConfigService.layer),
  );
}
