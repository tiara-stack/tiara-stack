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

// Re-export types from sheet-apis
export type ScheduleResult = Sheet.PopulatedScheduleResult;
export type SchedulePlayer = Sheet.PopulatedSchedulePlayer;

// Private atom for fetching all schedules for a guild
const _guildScheduleAtom = (guildId: string) =>
  SheetApisClient.query("schedule", "getAllPopulatedSchedules", {
    urlParams: { guildId },
  });

// Serializable atom for guild schedule
export const guildScheduleAtom = (guildId: string) =>
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
  );

// Hook to use month schedule data
export const useGuildSchedule = (guildId: string): readonly Sheet.PopulatedScheduleResult[] => {
  const result = useAtomSuspense(guildScheduleAtom(guildId), {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};

export const getAllChannelsAtom = (guildId: string) =>
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
  );

export const useAllChannels = (guildId: string) => {
  const result = useAtomSuspense(getAllChannelsAtom(guildId), {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};

// Parameters for scheduledDaysAtom
export interface ScheduledDaysParams {
  guildId: string;
  channel: string;
  timeZone: string;
  rangeStart: number;
  rangeEnd: number;
}

// Format DateTime.Utc to yyyy-MM-dd key using timezone
export function formatDayKey(dateTime: DateTime.Utc, timeZone: string): string {
  const zoned = DateTime.unsafeSetZoneNamed(dateTime, timeZone);
  const parts = DateTime.toParts(zoned);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

// Derived atom for scheduled days within a calendar view range
export const scheduledDaysAtom = (params: ScheduledDaysParams) =>
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

      const isInChannel = (s: Sheet.PopulatedScheduleResult) =>
        Predicate.isTagged("PopulatedSchedule")(s) && s.channel === channel && s.visible;

      const isInRange = (s: Sheet.PopulatedScheduleResult) => {
        const scheduleTimestamp = computeScheduleTimestamp(eventConfig.startTime, s.day, s.hour);
        return scheduleTimestamp >= rangeStart && scheduleTimestamp < rangeEnd;
      };

      const getDayKey = (s: Sheet.PopulatedScheduleResult) => {
        const scheduleTimestamp = computeScheduleTimestamp(eventConfig.startTime, s.day, s.hour);
        const scheduleDateTime = DateTime.unsafeMake(scheduleTimestamp);
        return formatDayKey(scheduleDateTime, timeZone);
      };

      return pipe(
        schedules,
        Array.filter(isInChannel),
        Array.filter(isInRange),
        Array.map(getDayKey),
        HashSet.fromIterable,
      );
    }),
  ).pipe(
    Atom.serializable({
      key: `schedule.derived.scheduledDays.${params.guildId}.${params.channel}.${params.rangeStart}-${params.rangeEnd}`,
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
  );

// Hook to use scheduled days for a calendar view
export const useScheduledDays = (params: ScheduledDaysParams): HashSet.HashSet<string> => {
  const result = useAtomSuspense(scheduledDaysAtom(params), {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};

// Helper to convert DateTime.Utc to milliseconds timestamp
const utcToMillis = (utc: DateTime.Utc): number => {
  return DateTime.toEpochMillis(utc);
};

// Compute the actual date for a schedule day/hour relative to startTime
// startTime is DateTime.Utc, returns timestamp in milliseconds
// Note: hour field is cumulative across days (day 2 starts at hour 48)
export const computeScheduleTimestamp = (
  startTime: DateTime.Utc,
  _day: number,
  hour: Option.Option<number>,
): number => {
  const hourValue = Option.getOrElse(hour, () => 0);
  const startTimeMs = utcToMillis(startTime);
  // Hour is already cumulative (e.g., day 2 hour 0 = hour 48)
  // So we just add hour * 60 minutes * 60 seconds * 1000 ms
  return startTimeMs + hourValue * 60 * 60 * 1000;
};

// Compute the day offset and hour from an absolute timestamp relative to startTime
export const computeScheduleDayHour = (
  startTime: DateTime.Utc,
  timestamp: number,
): { day: number; hour: number } => {
  const startTimeMs = utcToMillis(startTime);
  const diffMs = timestamp - startTimeMs;
  const totalHours = Math.floor(diffMs / (60 * 60 * 1000));
  const day = Math.floor(totalHours / 24);
  const hour = totalHours; // Keep as cumulative hour
  return { day, hour };
};

// Filter schedules that fall within a specific date (in the target timezone)
export const filterSchedulesByDate = (
  schedules: readonly Sheet.PopulatedScheduleResult[],
  startTime: DateTime.Utc,
  targetDate: DateTime.Utc,
  timeZone: string,
): readonly Sheet.PopulatedScheduleResult[] => {
  // Get the start and end of the target date in the target timezone
  const zonedTargetDate = DateTime.unsafeSetZoneNamed(targetDate, timeZone);
  const targetDayStart = DateTime.toEpochMillis(DateTime.startOf(zonedTargetDate, "day"));
  const targetDayEnd = targetDayStart + 24 * 60 * 60 * 1000;

  return schedules.filter((schedule) => {
    const scheduleTimestamp = computeScheduleTimestamp(startTime, schedule.day, schedule.hour);
    // Check if the schedule falls within the target day
    return scheduleTimestamp >= targetDayStart && scheduleTimestamp < targetDayEnd;
  });
};
