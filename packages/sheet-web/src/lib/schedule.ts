import { Atom, Result, useAtomSuspense } from "@effect-atom/atom-react";
import { Sheet, Google, SheetConfig, Middlewares } from "sheet-apis/schema";
import { SheetApisClient } from "#/lib/sheetApis";
import { Array, DateTime, Effect, Option, Schema } from "effect";
import {
  catchParseErrorAsValidationError,
  QueryResultError,
  ValidationError,
} from "typhoon-core/error";
import { RequestError, ResponseError } from "#/lib/error";
import { startOfDay } from "date-fns";
import { toZonedTime } from "date-fns-tz";

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

// Helper to convert DateTime.Utc to milliseconds timestamp
const utcToMillis = (utc: DateTime.Utc): number => {
  return DateTime.toDate(utc).getTime();
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

// Extract unique channels from schedules
export const getChannelsFromSchedules = (
  schedules: readonly Sheet.PopulatedScheduleResult[],
): string[] => {
  const channelSet = new Set<string>();
  schedules.forEach((schedule) => {
    if (schedule._tag === "PopulatedSchedule") {
      channelSet.add(schedule.channel);
    }
  });
  return Array.fromIterable(channelSet).sort();
};

// Filter schedules that fall within a specific date (in the target timezone)
export const filterSchedulesByDate = (
  schedules: readonly Sheet.PopulatedScheduleResult[],
  startTime: DateTime.Utc,
  targetDate: Date,
  timeZone: string,
): readonly Sheet.PopulatedScheduleResult[] => {
  // Get the start and end of the target date in the target timezone
  const zonedTargetDate = toZonedTime(targetDate, timeZone);
  const targetDayStart = startOfDay(zonedTargetDate).getTime();
  const targetDayEnd = targetDayStart + 24 * 60 * 60 * 1000;

  return schedules.filter((schedule) => {
    const scheduleTimestamp = computeScheduleTimestamp(startTime, schedule.day, schedule.hour);
    // Check if the schedule falls within the target day
    return scheduleTimestamp >= targetDayStart && scheduleTimestamp < targetDayEnd;
  });
};
