import { useAtomSuspense } from "@effect/atom-react";
import {
  Array,
  DateTime,
  Duration,
  Effect,
  HashSet,
  Option,
  pipe,
  Predicate,
  Result,
  Schema,
} from "effect";
import { Atom, AsyncResult } from "effect/unstable/reactivity";
import { SchedulesLoadWorkspaceSuccess, WorkspaceInput } from "sheet-workflow-contracts";
import { useMemo } from "react";
import { zoneId } from "#/hooks/useDateTimeZoned";
import { runSheetWorkflow, sheetZeroClientAtom } from "#/lib/sheetZero";
import * as Schedule from "#/lib/scheduleValues";

// Re-export the shared schedule type for route consumers.
export type SchedulePlayer = Schedule.PopulatedSchedulePlayer;

const WorkspaceScheduleAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: SchedulesLoadWorkspaceSuccess,
    error: Schema.Unknown,
  }),
);

const GuildSchedulesAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: Schema.Array(Schedule.PopulatedScheduleResult),
    error: Schema.Unknown,
  }),
);

const GuildChannelsAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: Schema.Array(Schema.String),
    error: Schema.Unknown,
  }),
);

const ScheduledDaysAsyncResultSchema = Schema.revealCodec(
  AsyncResult.Schema({
    success: Schema.HashSet(Schema.String),
    error: Schema.Unknown,
  }),
);

type ScheduleSummary = Schema.Schema.Type<
  typeof SchedulesLoadWorkspaceSuccess
>["populatedSchedules"][number];

const scheduleRefreshInterval = Duration.minutes(2);

export const workspaceScheduleAtom = Atom.family((guildId: string) =>
  Atom.make<Schema.Schema.Type<typeof SchedulesLoadWorkspaceSuccess>, unknown>(
    Effect.fnUntraced(function* (get) {
      const runtime = yield* get.result(sheetZeroClientAtom);
      const input = yield* Schema.decodeUnknownEffect(WorkspaceInput)({ workspaceId: guildId });
      return yield* runSheetWorkflow(
        runtime.workflows.schedules.loadWorkspace,
        input,
        SchedulesLoadWorkspaceSuccess,
      );
    }),
  ).pipe(
    // Schedules are read from Google Sheets through a one-shot workflow, so Zero cannot notify
    // this atom when the source changes. Refresh while the schedule is in use to avoid stale tabs.
    Atom.withRefresh(scheduleRefreshInterval),
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.serializable({
      key: `schedules.loadWorkspace.v2.${guildId}`,
      schema: WorkspaceScheduleAsyncResultSchema,
    }),
  ),
);

/**
 * Schedule hours are global across the event: hour 1 starts at eventStart, hour 25 is +24 hours,
 * and hour 49 is +48 hours. `day` is sheet metadata and must not be added to this timestamp.
 */
export const scheduleStart = (eventStart: DateTime.Utc, hour: number) =>
  DateTime.addDuration(eventStart, Duration.hours(hour - 1));

const partialPlayer = (name: string, accountId: string | null | undefined) =>
  new Schedule.PopulatedSchedulePlayer({
    player:
      Predicate.isString(accountId) && accountId.length > 0
        ? new Schedule.Player({ index: 0, id: accountId, name })
        : new Schedule.PartialNamePlayer({ name }),
    enc: false,
  });

const partialMonitor = (name: string) =>
  new Schedule.PopulatedScheduleMonitor({
    monitor: new Schedule.PartialNameMonitor({ name }),
  });

export const scheduleFromSummary = (
  eventStart: DateTime.Utc,
  summary: ScheduleSummary,
): Schedule.PopulatedScheduleResult => {
  if (Predicate.isNull(summary.hour)) {
    return new Schedule.PopulatedBreakSchedule({
      channel: summary.conversationName,
      day: summary.day,
      visible: summary.visible,
      hour: Option.none(),
      hourWindow: Option.none(),
    });
  }

  const start = scheduleStart(eventStart, summary.hour);
  const fills = Array.makeBy(5, (index) =>
    Option.fromNullishOr(summary.playerNames[index]).pipe(
      Option.map((name) => partialPlayer(name, summary.playerAccountIds?.[index])),
    ),
  );

  return new Schedule.PopulatedSchedule({
    channel: summary.conversationName,
    day: summary.day,
    visible: summary.visible,
    hour: Option.some(summary.hour),
    hourWindow: Option.some(
      new Schedule.ScheduleHourWindow({
        start,
        end: DateTime.addDuration(start, Duration.hours(1)),
      }),
    ),
    fills,
    overfills: [],
    standbys: [],
    runners: [],
    monitor: Option.fromNullishOr(summary.monitorName).pipe(Option.map(partialMonitor)),
  });
};

export const guildScheduleAtom = Atom.family((guildId: string) =>
  Atom.make<ReadonlyArray<Schedule.PopulatedScheduleResult>, unknown>(
    Effect.fnUntraced(function* (get) {
      const response = yield* get.result(workspaceScheduleAtom(guildId));
      const eventStart = DateTime.makeUnsafe(response.eventConfig.startTimeEpochMs);
      return response.populatedSchedules.map((summary) => scheduleFromSummary(eventStart, summary));
    }),
  ).pipe(
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.serializable({
      key: `schedule.getAllPopulatedSchedules.v2.${guildId}`,
      schema: GuildSchedulesAsyncResultSchema,
    }),
  ),
);

// Hook to use month schedule data
export const useGuildSchedule = (guildId: string) => {
  const atom = useMemo(() => guildScheduleAtom(guildId), [guildId]);
  const result = useAtomSuspense(atom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });
  return result.value;
};

export const getAllChannelsAtom = Atom.family((guildId: string) =>
  Atom.make(
    Effect.fnUntraced(function* (get) {
      const schedules = yield* get.result(guildScheduleAtom(guildId));
      const populatedSchedules = schedules.filter(Predicate.isTagged("PopulatedSchedule"));
      const channelArray = populatedSchedules.map((s) => s.channel);
      const channelSet = HashSet.fromIterable(channelArray);
      const uniqueChannels = Array.fromIterable(channelSet);
      return [...uniqueChannels].sort((left, right) =>
        left.localeCompare(right),
      ) as readonly string[];
    }),
  ).pipe(
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.serializable({
      key: `schedule.derived.getAllChannels.v2.${guildId}`,
      schema: GuildChannelsAsyncResultSchema,
    }),
  ),
);

export const useAllChannels = (guildId: string) => {
  const atom = useMemo(() => getAllChannelsAtom(guildId), [guildId]);
  const result = useAtomSuspense(atom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });
  return result.value;
};

export const useAllChannelsResult = (guildId: string) => {
  const atom = useMemo(() => getAllChannelsAtom(guildId), [guildId]);
  return useAtomSuspense(atom, {
    suspendOnWaiting: false,
    includeFailure: true,
  });
};

// Parameters for scheduledDaysAtom
export interface ScheduledDaysParams {
  guildId: string;
  channel: string;
  timeZone: DateTime.TimeZone;
  rangeStart: DateTime.Zoned;
  rangeEnd: DateTime.Zoned;
}

export function formatDayKey(dateTime: DateTime.Zoned): string {
  const parts = DateTime.toParts(dateTime);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

const _scheduledDaysAtom = Atom.family((params: ScheduledDaysParams) =>
  Atom.make(
    Effect.fnUntraced(function* (get) {
      const { guildId, channel, timeZone, rangeStart, rangeEnd } = params;
      const schedules = yield* get.result(guildScheduleAtom(guildId));

      const isInChannel = (s: Schedule.PopulatedScheduleResult) =>
        Predicate.isTagged("PopulatedSchedule")(s) && s.channel === channel && s.visible;

      const isInRange = (s: Schedule.PopulatedScheduleResult) =>
        pipe(
          s.hourWindow,
          Option.exists((hourWindow) =>
            DateTime.between(DateTime.setZone(hourWindow.start, timeZone), {
              minimum: rangeStart,
              maximum: rangeEnd,
            }),
          ),
        );

      const getDayKey = (s: Schedule.PopulatedScheduleResult) =>
        pipe(
          s.hourWindow,
          Option.map((hourWindow) => formatDayKey(DateTime.setZone(hourWindow.start, timeZone))),
          Result.fromOption(() => undefined),
        );

      return pipe(
        schedules,
        Array.filter(isInChannel),
        Array.filter(isInRange),
        Array.filterMap(getDayKey),
        HashSet.fromIterable,
      );
    }),
  ),
);

export const scheduledDaysAtom = Atom.family((params: ScheduledDaysParams) =>
  _scheduledDaysAtom(params).pipe(
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.serializable({
      key: `schedule.derived.scheduledDays.v2.${params.guildId}.${params.channel}.${zoneId(params.timeZone)}.${DateTime.toEpochMillis(params.rangeStart)}-${DateTime.toEpochMillis(params.rangeEnd)}`,
      schema: ScheduledDaysAsyncResultSchema,
    }),
  ),
);

// Hook to use scheduled days for a calendar view
export const useScheduledDays = (params: ScheduledDaysParams) => {
  const atom = useMemo(
    () => scheduledDaysAtom(params),
    [
      params.guildId,
      params.channel,
      zoneId(params.timeZone),
      DateTime.toEpochMillis(params.rangeStart),
      DateTime.toEpochMillis(params.rangeEnd),
    ],
  );
  const result = useAtomSuspense(atom, {
    suspendOnWaiting: false,
    includeFailure: false,
  });
  return result.value;
};

export const computeScheduleHour = (
  startTime: DateTime.Zoned,
  dateTime: DateTime.Zoned,
  maxHour: number,
): Option.Option<number> => {
  // Return none if dateTime is before startTime
  if (DateTime.isLessThan(dateTime, startTime)) return Option.none();

  const hours = Math.floor(Duration.toHours(DateTime.distance(startTime, dateTime))) + 1;
  if (hours > maxHour) return Option.none();

  return Option.some(hours);
};
