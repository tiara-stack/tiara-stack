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
import {
  scheduleHourAt,
  scheduleHourInterval,
  scheduleTimeReferenceFromMetadata,
  type ScheduleTimeReference,
  type ScheduleTimeReferenceMetadata,
} from "sheet-domain";
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

type ScheduleEventConfig = SchedulesLoadWorkspaceSuccess["eventConfig"];

const scheduleRefreshInterval = Duration.minutes(2);

/** The reactivity key shared by schedule projections and Sheet Configuration mutations. */
export const scheduleReactivityKey = (guildId: string) => `schedule.timing.${guildId}`;

/**
 * Resolves the timing reference carried by a workspace schedule response.
 *
 * The response reference is authoritative when present. Legacy configuration is resolved before
 * the workflow response is published; this boundary never re-infers timing from a filtered view.
 */
export const scheduleTimeReferenceMetadataForResponse = (
  eventConfig: ScheduleEventConfig,
): ScheduleTimeReferenceMetadata | undefined => {
  return eventConfig.scheduleTimeReference;
};

export const scheduleTimeReferenceForResponse = (
  eventConfig: ScheduleEventConfig,
): ScheduleTimeReference | undefined => {
  const metadata = scheduleTimeReferenceMetadataForResponse(eventConfig);
  return metadata === undefined ? undefined : scheduleTimeReferenceFromMetadata(metadata);
};

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
    Atom.withReactivity([scheduleReactivityKey(guildId)]),
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.serializable({
      key: `schedules.loadWorkspace.v5.${guildId}`,
      schema: WorkspaceScheduleAsyncResultSchema,
    }),
  ),
);

/** Returns the start of an event-wide Schedule Hour from its resolved reference. */
export const scheduleStart = (reference: ScheduleTimeReference, hour: number) =>
  scheduleHourInterval(reference, hour).start;

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
  scheduleTimeReference: ScheduleTimeReference | undefined,
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

  const hourWindow =
    scheduleTimeReference === undefined
      ? Option.none()
      : Option.some(
          (() => {
            const interval = scheduleHourInterval(scheduleTimeReference, summary.hour);
            return new Schedule.ScheduleHourWindow(interval);
          })(),
        );

  if (summary.break === true) {
    return new Schedule.PopulatedBreakSchedule({
      channel: summary.conversationName,
      day: summary.day,
      visible: summary.visible,
      hour: Option.some(summary.hour),
      hourWindow,
    });
  }

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
    hourWindow,
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
      const scheduleTimeReference = scheduleTimeReferenceForResponse(response.eventConfig);
      return response.populatedSchedules.map((summary) =>
        scheduleFromSummary(scheduleTimeReference, summary),
      );
    }),
  ).pipe(
    Atom.withReactivity([scheduleReactivityKey(guildId)]),
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.serializable({
      key: `schedule.getAllPopulatedSchedules.v5.${guildId}`,
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
      const channelArray = schedules.map((s) => s.channel);
      const channelSet = HashSet.fromIterable(channelArray);
      const uniqueChannels = Array.fromIterable(channelSet);
      return [...uniqueChannels].sort((left, right) =>
        left.localeCompare(right),
      ) as readonly string[];
    }),
  ).pipe(
    Atom.withReactivity([scheduleReactivityKey(guildId)]),
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.serializable({
      key: `schedule.derived.getAllChannels.v5.${guildId}`,
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
        s.channel === channel && s.visible;

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
    Atom.withReactivity([scheduleReactivityKey(params.guildId)]),
    Atom.setIdleTTL(Duration.minutes(5)),
    Atom.serializable({
      key: `schedule.derived.scheduledDays.v5.${params.guildId}.${params.channel}.${zoneId(params.timeZone)}.${DateTime.toEpochMillis(params.rangeStart)}-${DateTime.toEpochMillis(params.rangeEnd)}`,
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
  scheduleTimeReference: ScheduleTimeReference | undefined,
  dateTime: DateTime.DateTime,
  maxHour: number,
): Option.Option<number> => {
  if (scheduleTimeReference === undefined) return Option.none();

  const hours = scheduleHourAt(
    scheduleTimeReference,
    DateTime.makeUnsafe(DateTime.toEpochMillis(dateTime)),
  );
  // A chapter reference still resolves to the full event clock, but the chapter's UI navigation
  // begins at its anchored event-wide hour rather than exposing unconfigured earlier hours.
  if (hours < scheduleTimeReference.hour) return Option.none();
  if (hours > maxHour) return Option.none();

  return Option.some(hours);
};
