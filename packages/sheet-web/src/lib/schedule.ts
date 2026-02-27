import { Atom, Result, useAtomSuspense } from "@effect-atom/atom-react";
import { Sheet, Google, SheetConfig, Middlewares } from "sheet-apis/schema";
import { SheetApisClient } from "#/lib/sheetApis";
import { Effect, Schema } from "effect";
import {
  catchParseErrorAsValidationError,
  QueryResultError,
  ValidationError,
} from "typhoon-core/error";
import { RequestError, ResponseError } from "#/lib/error";

// Re-export types from sheet-apis
export type ScheduleResult = Sheet.PopulatedScheduleResult;
export type SchedulePlayer = Sheet.PopulatedSchedulePlayer;

// Private atom for fetching all schedules for a guild
const _guildScheduleAtom = (guildId: string) =>
  SheetApisClient.query("schedule", "getAllPopulatedSchedules", { urlParams: { guildId } });

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

// Private atom for fetching schedules for a specific day
const _dayScheduleAtom = (guildId: string, day: number) =>
  SheetApisClient.query("schedule", "getDayPopulatedSchedules", {
    urlParams: { guildId, day },
  });

// Serializable atom for day schedule
export const dayScheduleAtom = (guildId: string, day: number) =>
  Atom.make(
    Effect.fnUntraced(function* (get) {
      return yield* get.result(_dayScheduleAtom(guildId, day)).pipe(
        catchParseErrorAsValidationError,
        Effect.catchTags({
          RequestError: (error) => Effect.fail(RequestError.make(error)),
          ResponseError: (error) => Effect.fail(ResponseError.make(error)),
        }),
      );
    }),
  ).pipe(
    Atom.serializable({
      key: `schedule.getDayPopulatedSchedules.${guildId}.${day}`,
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

// Hook to use day schedule data
export const useDaySchedule = (
  guildId: string,
  day: number,
): readonly Sheet.PopulatedScheduleResult[] => {
  const result = useAtomSuspense(dayScheduleAtom(guildId, day), {
    suspendOnWaiting: true,
    includeFailure: false,
  });
  return result.value;
};
