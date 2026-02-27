import { useAtomSuspense } from "@effect-atom/atom-react";
import { Sheet } from "sheet-apis/schema";
import { SheetApisClient } from "#/lib/sheetApis";

// Re-export types from sheet-apis
export type ScheduleResult = Sheet.PopulatedScheduleResult;
export type SchedulePlayer = Sheet.PopulatedSchedulePlayer;

// Atom for fetching all schedules for a guild
export const guildScheduleAtom = (guildId: string) =>
  SheetApisClient.query("schedule", "getAllPopulatedSchedules", { urlParams: { guildId } });

// Atom for fetching schedules for a specific day
export const dayScheduleAtom = (guildId: string, day: number) =>
  SheetApisClient.query("schedule", "getDayPopulatedSchedules", {
    urlParams: { guildId, day },
  });

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
