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
import { WorkspaceConfigService } from "./workspaceConfig";
import { ScheduleService } from "./schedule";
import { SheetConfigService } from "./sheetConfig";
import { getSheetIdFromWorkspaceId, requireRunningConversation } from "./workspaceSheet";
import { diffFillParticipants, getScheduleFills, toFillParticipant } from "./fillMovement";
import type { FillParticipant } from "./fillMovement";
import type { GeneratedSheetText } from "sheet-ingress-api/schemas/client";
import { makeMonitorCheckinMessage } from "sheet-message-content/checkinSummary";
import {
  clientTerm,
  conversationMention,
  parts,
  strikethrough,
  strong,
  text,
  timestamp,
  userMention,
} from "./generatedText";

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
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.5,
  },
  {
    value:
      "{{mentionsString}} The goddess Miku is calling for you to fill. Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.25,
  },
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}. ... Beep Boop. Beep Boop. zzzt... zzzt... zzzt...",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}\n~~or VBS Miku will recruit you for some taste testing of her cooking.~~",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Ebi jail AAAAAAAAAAAAAAAAAAAAAAA. Press the button below to check in, and {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} Miku's voice echoes in the empty SEKAI. Press the button below to check in, then {{conversationString}} {{hourString}} {{timeStampString}}",
    weight: 0.05,
  },
  {
    value:
      "{{mentionsString}} The clock hits 25:00. Miku whispers from the empty SEKAI. Press the button below to check in, then {{conversationString}} {{hourString}} {{timeStampString}}",
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

const renderStaticTemplateSegment = (value: string): GeneratedSheetText => {
  const segments = value.split("~~");
  return segments.flatMap((segment, index) => {
    if (segment.length === 0) {
      return [];
    }
    return index % 2 === 0 ? [text(segment)] : [strikethrough([text(segment)])];
  });
};

const renderTemplate = (
  template: string,
  context: Record<string, GeneratedSheetText>,
): GeneratedSheetText => {
  const rendered: GeneratedSheetText[] = [];
  const pattern = /\{\{\{?(\w+)\}?\}\}/g;
  let lastIndex = 0;
  for (const match of template.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      rendered.push(renderStaticTemplateSegment(template.slice(lastIndex, index)));
    }
    rendered.push(context[match[1] ?? ""] ?? renderStaticTemplateSegment(match[0]));
    lastIndex = index + match[0].length;
  }
  if (lastIndex < template.length) {
    rendered.push(renderStaticTemplateSegment(template.slice(lastIndex)));
  }
  return rendered.flat();
};

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
  conversationName: string,
): boolean => {
  const normalizedChannelName = conversationName.trim();

  return scheduleConfigs.some(
    (config) =>
      Option.exists(
        config.channel,
        (configuredChannel) => configuredChannel === normalizedChannelName,
      ) && isCompleteScheduleConfig(config),
  );
};

const requireScheduleConfigForChannel = Effect.fn("CheckinService.requireScheduleConfigForChannel")(
  function* (sheetId: string, conversationName: string, sheetConfigService: SheetConfigServiceApi) {
    const scheduleConfigs = yield* sheetConfigService.getScheduleConfig(sheetId);
    const matchingConfigs = scheduleConfigs.filter((config) =>
      Option.exists(config.channel, (configuredChannel) => configuredChannel === conversationName),
    );

    if (matchingConfigs.length === 0) {
      return yield* Effect.fail(
        makeArgumentError(
          `Cannot generate check-in for conversation "${conversationName}", no schedule config is defined for that conversation in the sheet.`,
        ),
      );
    }

    if (!hasCompleteScheduleConfigForChannel(matchingConfigs, conversationName)) {
      return yield* Effect.fail(
        makeArgumentError(
          `Cannot generate check-in for conversation "${conversationName}", the sheet schedule config for that conversation is incomplete.`,
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
  if (Predicate.isNumber(payload.hour)) {
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
        `Cannot look up ID for ${partialPlayers.join(", ")}. They would need to check in manually.`,
      )
    : Option.none();
};

const getMonitorInfo = (schedule: Option.Option<PopulatedScheduleResult>) => {
  if (Option.isNone(schedule) || schedule.value._tag === "PopulatedBreakSchedule") {
    return {
      monitorUserId: null as string | null,
      monitorFailureMessage: null as GeneratedSheetText | null,
    };
  }

  const populatedSchedule = schedule.value;
  if (Option.isNone(populatedSchedule.monitor)) {
    return {
      monitorUserId: null as string | null,
      monitorFailureMessage: [text("Cannot ping monitor: monitor not assigned for this hour.")],
    };
  }

  const populatedMonitor: PopulatedScheduleMonitor = populatedSchedule.monitor.value;
  return isMonitor(populatedMonitor.monitor)
    ? {
        monitorUserId: populatedMonitor.monitor.id,
        monitorFailureMessage: null as GeneratedSheetText | null,
      }
    : {
        monitorUserId: null as string | null,
        monitorFailureMessage: [
          text(
            `Cannot ping monitor: monitor "${populatedMonitor.monitor.name}" is missing an ID in the sheet.`,
          ),
        ],
      };
};

const formatConversationString = (
  roleId: Option.Option<string>,
  conversationId: string,
  conversationName: Option.Option<string>,
): GeneratedSheetText =>
  Option.isSome(roleId)
    ? pipe(
        conversationName,
        Option.map((name) => [text(`head to ${name}`)]),
        Option.getOrElse(() =>
          parts(
            text("await further instructions from the monitor on where the "),
            clientTerm("runDestination"),
            text(" is"),
          ),
        ),
      )
    : parts(text("head to "), conversationMention(conversationId));

const renderParticipantMentions = (
  participants: ReadonlyArray<FillParticipant>,
): Option.Option<GeneratedSheetText> => {
  if (participants.length === 0) {
    return Option.none();
  }
  return Option.some(
    participants.flatMap((participant, index) =>
      parts(
        index === 0 ? undefined : text(" "),
        Predicate.isString(participant.userId)
          ? userMention(participant.userId)
          : text(participant.name),
      ),
    ),
  );
};

export class CheckinService extends Context.Service<CheckinService>()("CheckinService", {
  make: Effect.gen(function* () {
    const workspaceConfigService = yield* WorkspaceConfigService;
    const scheduleService = yield* ScheduleService;
    const sheetConfigService = yield* SheetConfigService;

    return {
      // fallow-ignore-next-line complexity
      generate: Effect.fn("CheckinService.generate")(function* (payload: {
        workspaceId: string;
        conversationId?: string | undefined;
        conversationName?: string | undefined;
        hour?: number | undefined;
        template?: string | undefined;
      }) {
        const runningConversation = yield* requireRunningConversation(
          payload.workspaceId,
          payload,
          workspaceConfigService,
          "generate check-in",
        );
        const sheetId = yield* getSheetIdFromWorkspaceId(
          payload.workspaceId,
          workspaceConfigService,
          "generate check-in",
        );
        const { hour, eventConfig } = yield* deriveHour(payload, sheetConfigService, sheetId);
        const conversationName = Option.getOrElse(runningConversation.name, () => "").trim();
        if (conversationName.length === 0) {
          return yield* Effect.fail(
            makeArgumentError(
              "Cannot generate check-in, the running conversation has no sheet conversation name configured",
            ),
          );
        }
        yield* requireScheduleConfigForChannel(sheetId, conversationName, sheetConfigService);
        const schedules = yield* scheduleService.getChannelPopulatedSchedules(
          sheetId,
          conversationName,
        );

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
        const mentionsText = renderParticipantMentions(fillMovement.in);

        const hourText = parts(text("for "), strong([text(`hour ${hour}`)]));
        const scheduleHourWindow = pipe(
          schedule,
          Option.flatMap((currentSchedule) => currentSchedule.hourWindow as Option.Option<any>),
        );
        const timestampText = Option.isSome(scheduleHourWindow)
          ? parts(timestamp(DateTime.toEpochMillis(scheduleHourWindow.value.start), "relative"))
          : yield* pipe(
              eventConfig,
              Option.match({
                onSome: Effect.succeed,
                onNone: () => sheetConfigService.getEventConfig(sheetId),
              }),
              Effect.map((resolvedEventConfig) =>
                parts(
                  timestamp(
                    DateTime.toEpochMillis(
                      pipe(
                        resolvedEventConfig.startTime,
                        DateTime.addDuration(Duration.hours(hour - 1)),
                      ),
                    ),
                    "relative",
                  ),
                ),
              ),
              Effect.catch(() => Effect.succeed([])),
            );

        const conversationText = formatConversationString(
          runningConversation.roleId,
          runningConversation.conversationId,
          runningConversation.name,
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
          mentionsText,
          Option.map((resolvedMentionsText) =>
            renderTemplate(template, {
              mentionsString: resolvedMentionsText,
              conversationString: conversationText,
              hourString: hourText,
              timeStampString: timestampText,
            }),
          ),
          Option.getOrNull,
        );

        const empty =
          Option.isSome(schedule) && isPopulatedSchedule(schedule.value)
            ? PopulatedSchedule.empty(schedule.value)
            : SLOTS_PER_ROW;
        const lookupFailedMessage = getLookupFailedMessage(schedule);
        const monitorInfo = getMonitorInfo(schedule);

        return new CheckinGenerateResult({
          hour,
          runningConversationId: runningConversation.conversationId,
          checkinConversationId: Option.getOrElse(
            runningConversation.checkinConversationId,
            () => runningConversation.conversationId,
          ),
          fillCount,
          roleId: Option.getOrNull(runningConversation.roleId),
          initialMessage,
          monitorCheckinMessage: makeMonitorCheckinMessage({
            initialMessage,
            empty,
            out: fillMovement.out,
            stay: fillMovement.stay,
            in: fillMovement.in,
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
    Layer.provide(WorkspaceConfigService.layer),
    Layer.provide(ScheduleService.layer),
    Layer.provide(SheetConfigService.layer),
  );
}
