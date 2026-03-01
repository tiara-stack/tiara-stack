import { Atom, Result, useAtomSuspense } from "@effect-atom/atom-react";
import { Sheet, Google, SheetConfig, Middlewares } from "sheet-apis/schema";
import { SheetApisClient } from "#/lib/sheetApis";
import { Array, DateTime, Effect, HashSet, Option, pipe, Predicate, Schema } from "effect";
import {
  catchParseErrorAsValidationError,
  QueryResultError,
  ValidationError,
} from "typhoon-core/error";
import { RequestError, ResponseError } from "#/lib/error";
import { eventConfigAtom } from "#/lib/sheet";
import { useMemo } from "react";
import { zoneId } from "#/lib/date";

// Re-export types from sheet-apis
export type ScheduleResult = Sheet.PopulatedScheduleResult;
export type SchedulePlayer = Sheet.PopulatedSchedulePlayer;

// Private atom for fetching all schedules for a guild
const _guildScheduleAtom = Atom.family((guildId: string) =>
  SheetApisClient.query("schedule", "getAllPopulatedSchedules", {
    urlParams: { guildId },
  }),
);

// Serializable atom for guild schedule
export const guildScheduleAtom = Atom.family((guildId: string) =>
  Atom.make(
    Effect.fnUntraced(function* (get) {
      return yield* get.result(_guildScheduleAtom(guildId)).pipe(
        catchParseErrorAsValidationError,
        Effect.catchTags({
          RequestError: (error) => Effect.fail(RequestError.make(error)),
          ResponseError: (error) => Effect.fail(ResponseError.make(error)),
        }),
      );
    }),
  ).pipe(
    Atom.serializable({
      key: `schedule.getAllPopulatedSchedules.${guildId}`,
      schema: Result.Schema({
        success: Schema.Array(Sheet.PopulatedScheduleResult),
        error: Schema.Union(
          ValidationError,
          QueryResultError,
          Google.GoogleSheetsError,
          Sheet.ParserFieldError,
          SheetConfig.SheetConfigError,
          Middlewares.Unauthorized,
          RequestError,
          ResponseError,
        ),
      }),
    }),
  ),
);

// Hook to use month schedule data
export const useGuildSchedule = (guildId: string) => {
  const atom = useMemo(() => guildScheduleAtom(guildId), [guildId]);
  const result = useAtomSuspense(atom, {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};

export const getAllChannelsAtom = Atom.family((guildId: string) =>
  Atom.make(
    Effect.fnUntraced(function* (get) {
      const schedules = yield* get.result(guildScheduleAtom(guildId));
      const populatedSchedules = schedules.filter(
        (s): s is Sheet.PopulatedSchedule => s._tag === "PopulatedSchedule",
      );
      const channelArray = populatedSchedules.map((s) => s.channel);
      const channelSet = HashSet.fromIterable(channelArray);
      const uniqueChannels = Array.fromIterable(HashSet.toValues(channelSet));
      return [...uniqueChannels].sort() as readonly string[];
    }),
  ).pipe(
    Atom.serializable({
      key: `schedule.derived.getAllChannels.${guildId}`,
      schema: Result.Schema({
        success: Schema.Array(Schema.String),
        error: Schema.Union(
          ValidationError,
          QueryResultError,
          Google.GoogleSheetsError,
          Sheet.ParserFieldError,
          SheetConfig.SheetConfigError,
          Middlewares.Unauthorized,
          RequestError,
          ResponseError,
        ),
      }),
    }),
  ),
);

export const useAllChannels = (guildId: string) => {
  const atom = useMemo(() => getAllChannelsAtom(guildId), [guildId]);
  const result = useAtomSuspense(atom, {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
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
      const { schedules, eventConfig } = yield* Effect.all(
        {
          schedules: get.result(guildScheduleAtom(guildId)),
          eventConfig: get.result(eventConfigAtom(guildId)),
        },
        { concurrency: "unbounded" },
      );

      const startTimeZoned = DateTime.setZone(eventConfig.startTime, timeZone);

      const isInChannel = (s: Sheet.PopulatedScheduleResult) =>
        Predicate.isTagged("PopulatedSchedule")(s) && s.channel === channel && s.visible;

      const isInRange = (s: Sheet.PopulatedScheduleResult) => {
        const scheduleDateTime = computeScheduleDateTime(startTimeZoned, s.hour);
        return DateTime.between(scheduleDateTime, { minimum: rangeStart, maximum: rangeEnd });
      };

      const getDayKey = (s: Sheet.PopulatedScheduleResult) => {
        const scheduleDateTime = computeScheduleDateTime(startTimeZoned, s.hour);
        return formatDayKey(scheduleDateTime);
      };

      return pipe(
        schedules,
        Array.filter(isInChannel),
        Array.filter(isInRange),
        Array.map(getDayKey),
        HashSet.fromIterable,
      );
    }),
  ),
);

export const scheduledDaysAtom = Atom.family((params: ScheduledDaysParams) =>
  _scheduledDaysAtom(params).pipe(
    Atom.serializable({
      key: `schedule.derived.scheduledDays.${params.guildId}.${params.channel}.${zoneId(params.timeZone)}.${DateTime.toEpochMillis(params.rangeStart)}-${DateTime.toEpochMillis(params.rangeEnd)}`,
      schema: Result.Schema({
        success: Schema.HashSet(Schema.String),
        error: Schema.Union(
          ValidationError,
          QueryResultError,
          Google.GoogleSheetsError,
          Sheet.ParserFieldError,
          SheetConfig.SheetConfigError,
          Middlewares.Unauthorized,
          RequestError,
          ResponseError,
        ),
      }),
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
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};

// Compute the actual date for a schedule day/hour relative to startTime
// startTime is DateTime.Zoned, returns DateTime.Zoned
// Note: hour field is cumulative across days (day 2 starts at hour 48)
export const computeScheduleDateTime = (
  startTime: DateTime.Zoned,
  hour: Option.Option<number>,
): DateTime.Zoned => {
  const hourValue = Option.getOrElse(hour, () => 0);
  return DateTime.add(startTime, { hours: hourValue });
};

// Compute the day offset and hour from an absolute timestamp relative to startTime
export const computeScheduleDayHour = (
  startTime: DateTime.DateTime,
  timestamp: number,
): { day: number; hour: number } => {
  const startTimeMs = DateTime.toEpochMillis(startTime);
  const diffMs = timestamp - startTimeMs;
  const totalHours = Math.floor(diffMs / (60 * 60 * 1000));
  const day = Math.floor(totalHours / 24);
  const hour = totalHours; // Keep as cumulative hour
  return { day, hour };
};

// Filter schedules that fall within a specific date (in the target timezone)
export const filterSchedulesByDate = (
  schedules: readonly Sheet.PopulatedScheduleResult[],
  startTime: DateTime.Zoned,
  targetDate: DateTime.Zoned,
): readonly Sheet.PopulatedScheduleResult[] => {
  const targetDayStart = DateTime.startOf(targetDate, "day");
  const targetDayEnd = DateTime.endOf(targetDate, "day");

  return schedules.filter((schedule) => {
    const scheduleDateTime = computeScheduleDateTime(startTime, schedule.hour);
    return DateTime.between(scheduleDateTime, { minimum: targetDayStart, maximum: targetDayEnd });
  });
};
